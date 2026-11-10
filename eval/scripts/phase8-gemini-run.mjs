import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { context, expand, initialize, renderResult } from "../../dist/index.js";
import { evaluationOutcome } from "./evaluation-outcome.mjs";
import { exportTree } from "./git-tree.mjs";
import { classifyHostFailure, isAccountLimit } from "./host-failures.mjs";
import {
  GEMINI_ASSIGNMENTS,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MAX_TURNS,
  GEMINI_MIN_TURN_SPACING_MS,
  GEMINI_MODEL,
  GEMINI_PREFERRED_EFFORT,
  GEMINI_TIMEOUT_MS,
} from "./phase8-gemini-plan.mjs";
import { pilotMetrics } from "./pilot-metrics.mjs";
import { verifyFreeze } from "./verify-freeze.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyPath = "eval/manifests/phase8-gemini-policy.json";
const registrationPath = "eval/manifests/phase8-gemini-registration.json";
const freezePath = "eval/manifests/evaluation-freeze.json";
const ledgerPath = "eval/runs/phase8-gemini/attempts.jsonl";
const geminiTrialRoot = join(tmpdir(), "ctxgate-gemini-trials");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) =>
  JSON.parse(await readFile(join(project, path), "utf8"));
const save = async (path, value, options = {}) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", options);
};
const within = (parent, target) => {
  const rel = relative(parent, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

export function geminiToolDeclarations(condition = "A") {
  const tools = [
    {
      name: "list_workspace_files",
      description:
        "List relative file paths inside a directory of the isolated task workspace.",
      parameters: {
        type: "OBJECT",
        properties: { directory: { type: "STRING" } },
      },
    },
    {
      name: "read_workspace_file",
      description:
        "Read numbered lines from a UTF-8 text file inside the isolated task workspace. Defaults to lines 1-250; pass start_line and end_line to inspect specific sections of large files.",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING" },
          start_line: { type: "INTEGER" },
          end_line: { type: "INTEGER" },
        },
        required: ["path"],
      },
    },
    {
      name: "patch_workspace_file",
      description:
        "Replace an exact target snippet inside an existing UTF-8 file in the isolated task workspace. Prefer this over rewriting entire large files.",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING" },
          target: { type: "STRING" },
          replacement: { type: "STRING" },
        },
        required: ["path", "target", "replacement"],
      },
    },
    {
      name: "write_workspace_file",
      description:
        "Create or overwrite a UTF-8 text file inside the isolated task workspace.",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING" },
          content: { type: "STRING" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "run_focused_node_test",
      description:
        "Execute a standalone Node.js script inside the isolated task workspace using `node <script_path>`. Write a small standalone script using `node:assert` to verify your fix.",
      parameters: {
        type: "OBJECT",
        properties: {
          script_path: { type: "STRING" },
        },
        required: ["script_path"],
      },
    },
  ];
  if (condition === "B") {
    tools.push(
      {
        name: "ctx_context",
        description:
          "Retrieve budgeted lexical evidence from the repository before editing.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING" },
            budget_tokens: { type: "INTEGER" },
            encoding: { type: "STRING" },
          },
          required: ["query"],
        },
      },
      {
        name: "ctx_expand",
        description:
          "Expand a source-bound ctxgate reference returned by ctx_context. Pass either reference_json or path (with optional start_line/end_line).",
        parameters: {
          type: "OBJECT",
          properties: {
            reference_json: { type: "STRING" },
            path: { type: "STRING" },
            start_line: { type: "INTEGER" },
            end_line: { type: "INTEGER" },
            budget_tokens: { type: "INTEGER" },
          },
        },
      },
    );
  }
  return [{ functionDeclarations: tools }];
}

export async function invokeGeminiTool(
  workspace,
  condition,
  call,
  observeTool,
  recentReferences = [],
) {
  const args = call.args ?? {};
  if (call.name === "list_workspace_files") {
    const sub = String(args.directory ?? ".");
    const target = resolve(workspace, sub);
    if (!within(workspace, target) && target !== resolve(workspace))
      return { error: "Path outside isolated workspace denied" };
    const entries = await readdir(target, { withFileTypes: true });
    return {
      files: entries
        .filter((e) => !["node_modules", ".git", ".ctx"].includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
    };
  }
  if (call.name === "read_workspace_file") {
    const target = resolve(workspace, String(args.path ?? ""));
    if (!within(workspace, target))
      return { error: "Path outside isolated workspace denied" };
    const raw = await readFile(target, "utf8");
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;
    const startLine = Math.max(1, Number(args.start_line ?? 1));
    const endLine = Math.min(
      totalLines,
      Number(args.end_line ?? startLine + 249),
    );
    const slice = lines
      .slice(startLine - 1, endLine)
      .map((line, idx) => `${startLine + idx}: ${line}`)
      .join("\n");
    return {
      path: String(args.path ?? ""),
      start_line: startLine,
      end_line: endLine,
      total_lines: totalLines,
      truncated: endLine < totalLines || startLine > 1,
      content: slice,
    };
  }
  if (call.name === "patch_workspace_file") {
    const relPath = String(args.path ?? "");
    const target = resolve(workspace, relPath);
    if (
      !within(workspace, target) ||
      relPath.startsWith(".ctx/") ||
      relPath === ".ctx"
    )
      return { error: "Path outside editable workspace scope denied" };
    const current = await readFile(target, "utf8");
    const needle = String(args.target ?? "");
    if (!needle || !current.includes(needle)) {
      return {
        error:
          "Target snippet not found in file; read the exact lines with read_workspace_file first",
      };
    }
    const updated = current.replace(needle, String(args.replacement ?? ""));
    await writeFile(target, updated, "utf8");
    return { written: true, path: relPath };
  }
  if (call.name === "write_workspace_file") {
    const relPath = String(args.path ?? "");
    const target = resolve(workspace, relPath);
    if (
      !within(workspace, target) ||
      relPath.startsWith(".ctx/") ||
      relPath === ".ctx"
    )
      return { error: "Path outside editable workspace scope denied" };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(args.content ?? ""), "utf8");
    return { written: true, path: relPath };
  }
  if (call.name === "run_focused_node_test") {
    const relPath = String(args.script_path ?? "");
    const target = resolve(workspace, relPath);
    if (!within(workspace, target))
      return { error: "Script path outside isolated workspace denied" };
    const res = spawnSync(process.execPath, [target], {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exit_code: res.status ?? 1,
      stdout: (res.stdout ?? "").slice(0, 8192),
      stderr: (res.stderr ?? "").slice(0, 8192),
    };
  }
  if (condition === "B" && call.name === "ctx_context") {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const res = await context(workspace, String(args.query ?? ""), {
      encoding: args.encoding === "cl100k_base" ? "cl100k_base" : "o200k_base",
      budget_tokens: Number(args.budget_tokens ?? 2000),
      neighbors: false,
      notes: false,
    });
    for (const item of res.items ?? []) {
      if (item?.reference) recentReferences.push(item.reference);
    }
    const text = renderResult(res);
    const elapsedMs = performance.now() - t0;
    observeTool?.({
      schema_version: 1,
      operation: "context",
      started_at: startedAt,
      elapsed_ms: elapsedMs,
      success: res.status !== "budget_too_small",
      status: res.status,
      request_hash: hash(JSON.stringify(args)),
      response_bytes: Buffer.byteLength(text),
      budget: {
        count: res.budget.count,
        counter: res.budget.counter,
        method: res.budget.method,
      },
      references: res.items.map((item) => ({
        path: item.reference.path,
        start_line: item.reference.start_line,
        end_line: item.reference.end_line,
      })),
      raw_text: text,
      tool_configuration: {
        encoding:
          args.encoding === "cl100k_base" ? "cl100k_base" : "o200k_base",
        budget_tokens: Number(args.budget_tokens ?? 2000),
        neighbors: false,
        notes: false,
      },
    });
    return { result: text };
  }
  if (condition === "B" && call.name === "ctx_expand") {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let ref = null;
    if (args.reference_json) {
      ref = JSON.parse(String(args.reference_json));
    } else if (args.path) {
      const candidates = recentReferences.filter((r) => r.path === args.path);
      ref = candidates.at(-1) ?? null;
      if (ref && Number.isFinite(Number(args.start_line))) {
        ref = {
          ...ref,
          start_line: Number(args.start_line),
          end_line: Number(args.end_line ?? Number(args.start_line) + 30),
        };
      }
    } else {
      ref = recentReferences.at(-1) ?? null;
    }
    if (!ref) {
      return {
        error:
          "No matching reference found to expand; call ctx_context first or pass reference_json",
      };
    }
    const res = await expand(workspace, ref, {
      encoding: "o200k_base",
      budget_tokens: Number(args.budget_tokens ?? 1000),
      notes: false,
    });
    const text = renderResult(res);
    const elapsedMs = performance.now() - t0;
    observeTool?.({
      schema_version: 1,
      operation: "expand",
      started_at: startedAt,
      elapsed_ms: elapsedMs,
      success: res.status === "expanded",
      status: res.status,
      request_hash: hash(JSON.stringify(args)),
      response_bytes: Buffer.byteLength(text),
      budget: {
        count: res.budget.count,
        counter: res.budget.counter,
        method: res.budget.method,
      },
      references: res.items.map((item) => ({
        path: item.reference.path,
        start_line: item.reference.start_line,
        end_line: item.reference.end_line,
      })),
      raw_text: text,
    });
    return { result: text };
  }
  return { error: `Unsupported tool: ${call.name}` };
}

export async function callGeminiFlash({
  apiKey,
  contents,
  condition = "A",
  endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
  timeoutMs = GEMINI_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const maxRateRetries = 4;
  for (let attempt = 0; attempt <= maxRateRetries; attempt++) {
    const response = await fetchImpl(
      `${endpoint}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          tools: geminiToolDeclarations(condition),
          generationConfig: {
            thinkingConfig: { thinkingLevel: "LOW" },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      const bodyText = await response.text();
      const isTransientDemand =
        response.status === 503 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 504 ||
        (response.status === 429 && !/perday|daily/i.test(bodyText));
      if (isTransientDemand && attempt < maxRateRetries) {
        const delayMs = [5_000, 10_000, 18_000, 28_000][attempt] ?? 15_000;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        continue;
      }
      const err = new Error(
        `Gemini API error (${response.status}): ${bodyText}`,
      );
      err.status = response.status;
      err.body = bodyText;
      throw err;
    }
    return response.json();
  }
}

export async function runGeminiAgentSession({
  workspace,
  condition = "A",
  prompt,
  apiKey,
  endpoint,
  maxTurns = GEMINI_MAX_TURNS,
  minTurnSpacingMs = GEMINI_MIN_TURN_SPACING_MS,
  timeoutMs = GEMINI_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  onToolObservation,
}) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const events = [];
  const timeline = [];
  let stderr = "";
  let timedOut = false;
  let accountLimitDetected = false;
  let spawnError = null;
  let modelTurnCompleted = false;
  let turnCompletedMs = null;
  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let lastCallStartedAt = 0;
  const recentReferences = [];

  const pushEvent = (event) => {
    const entry = {
      received_at: new Date().toISOString(),
      elapsed_ms: performance.now() - started,
      event,
    };
    events.push(event);
    timeline.push(entry);
  };

  pushEvent({ type: "turn.started" });

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (turn > 0 && minTurnSpacingMs > 0) {
        const sinceLastCall = performance.now() - lastCallStartedAt;
        if (sinceLastCall < minTurnSpacingMs) {
          await new Promise((resolveDelay) =>
            setTimeout(
              resolveDelay,
              Math.ceil(minTurnSpacingMs - sinceLastCall),
            ),
          );
        }
      }
      const elapsed = performance.now() - started;
      const remaining = Math.max(1000, Math.ceil(timeoutMs - elapsed));
      if (elapsed >= timeoutMs) {
        timedOut = true;
        break;
      }
      lastCallStartedAt = performance.now();
      const reply = await callGeminiFlash({
        apiKey,
        contents,
        condition,
        endpoint,
        timeoutMs: remaining,
        fetchImpl,
      });
      const usageMeta = reply.usageMetadata ?? {};
      totalInputTokens += Number(usageMeta.promptTokenCount ?? 0);
      totalCachedTokens += Number(usageMeta.cachedContentTokenCount ?? 0);
      totalOutputTokens += Number(usageMeta.candidatesTokenCount ?? 0);
      totalReasoningTokens += Number(usageMeta.thoughtsTokenCount ?? 0);

      const candidate = reply.candidates?.[0];
      const modelContent = candidate?.content;
      const parts = modelContent?.parts ?? [];
      if (!modelContent || !parts.length) {
        stderr += `Empty model candidate on turn ${turn + 1}\n`;
        pushEvent({
          type: "turn.failed",
          error: { message: "Empty model candidate response" },
        });
        break;
      }

      contents.push({
        role: modelContent.role ?? "model",
        parts,
      });

      const functionCalls = parts
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall);

      if (functionCalls.length === 0) {
        modelTurnCompleted = true;
        turnCompletedMs = performance.now() - started;
        pushEvent({
          type: "turn.completed",
          usage: {
            input_tokens: totalInputTokens,
            cached_input_tokens: totalCachedTokens,
            output_tokens: totalOutputTokens,
            reasoning_output_tokens: totalReasoningTokens,
          },
        });
        break;
      }

      const functionResponseParts = [];
      for (const call of functionCalls) {
        let lastObserved = null;
        let toolOutput;
        try {
          toolOutput = await invokeGeminiTool(
            workspace,
            condition,
            call,
            (obs) => {
              lastObserved = obs;
              onToolObservation?.(obs);
            },
            recentReferences,
          );
        } catch (toolError) {
          toolOutput = { error: toolError.message };
        }

        if (call.name === "ctx_context" || call.name === "ctx_expand") {
          const isError = Boolean(toolOutput?.error);
          pushEvent({
            type: "item.completed",
            item: {
              type: "mcp_tool_call",
              server: "ctxgate",
              tool: call.name,
              arguments: call.args ?? {},
              status: isError ? "failed" : "completed",
              error: toolOutput?.error ?? null,
              result: isError
                ? { isError: true, content: [] }
                : {
                    content: [
                      {
                        type: "text",
                        text: lastObserved?.raw_text ?? toolOutput.result ?? "",
                      },
                    ],
                  },
            },
          });
        } else if (
          (call.name === "write_workspace_file" ||
            call.name === "patch_workspace_file") &&
          toolOutput?.written
        ) {
          pushEvent({
            type: "item.started",
            item: { type: "file_change", path: toolOutput.path },
          });
          pushEvent({
            type: "item.completed",
            item: { type: "file_change", path: toolOutput.path },
          });
        } else {
          pushEvent({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: `${call.name}(${JSON.stringify(call.args ?? {})})`,
              exit_code: toolOutput?.error ? 1 : (toolOutput?.exit_code ?? 0),
              aggregated_output: JSON.stringify(toolOutput).slice(0, 4096),
            },
          });
        }

        functionResponseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: toolOutput,
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });
    }
    if (!modelTurnCompleted && !timedOut) {
      if (performance.now() - started >= timeoutMs) {
        timedOut = true;
      } else {
        modelTurnCompleted = true;
        turnCompletedMs = performance.now() - started;
        pushEvent({
          type: "turn.completed",
          max_turns_reached: true,
          usage: {
            input_tokens: totalInputTokens,
            cached_input_tokens: totalCachedTokens,
            output_tokens: totalOutputTokens,
            reasoning_output_tokens: totalReasoningTokens,
          },
        });
      }
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    stderr += message + "\n";
    if (error?.name === "TimeoutError" || /aborted|timeout/i.test(message)) {
      timedOut = true;
    } else if (error?.status === 429 || isAccountLimit(message)) {
      accountLimitDetected = true;
      pushEvent({ type: "turn.failed", error: { message } });
    } else {
      spawnError = message;
      pushEvent({ type: "error", message });
    }
  }

  if (!modelTurnCompleted && totalInputTokens > 0) {
    pushEvent({
      type: "turn.completed",
      partial: true,
      usage: {
        input_tokens: totalInputTokens,
        cached_input_tokens: totalCachedTokens,
        output_tokens: totalOutputTokens,
        reasoning_output_tokens: totalReasoningTokens,
      },
    });
  }

  const elapsedMs = performance.now() - started;
  const stopBatch =
    accountLimitDetected ||
    Boolean(spawnError) ||
    (!modelTurnCompleted && !timedOut);

  return {
    started_at: startedAt,
    host: {
      mode: "direct_gemini_api",
      model: GEMINI_MODEL,
      reasoning_effort: GEMINI_PREFERRED_EFFORT,
    },
    contents,
    events,
    timeline,
    stdout: JSON.stringify(events),
    stderr,
    elapsed_ms: elapsedMs,
    exit_code: modelTurnCompleted ? 0 : 1,
    timed_out: timedOut,
    spawn_error: spawnError,
    account_limit_detected: accountLimitDetected,
    turn_completed_ms: turnCompletedMs,
    cleanup_elapsed_ms: modelTurnCompleted ? 0 : null,
    cleanup_forced: false,
    cleanup_incomplete: false,
    model_turn_completed: modelTurnCompleted,
    stop_batch: stopBatch,
  };
}

async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      ["node_modules", ".git"].includes(entry.name) ||
      path === ".ctx/cache" ||
      entry.name.startsWith(".ctxgate-")
    )
      continue;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) files[path] = { unsupported: "symlink" };
    else if (info.isDirectory())
      Object.assign(files, await inventory(root, path));
    else if (info.isFile())
      files[path] = { sha256: hash(await readFile(join(root, path))) };
  }
  return files;
}

async function copyTaskDependencies(task, root, readiness, runtime) {
  const setup = readiness.results.find((row) => row.id === task.id);
  const expected = runtime.tasks.find((row) => row.id === task.id);
  if (!setup?.verified || !expected)
    throw Error(`Unqualified task: ${task.id}`);
  const prepared = join(
    project,
    "eval/.cache/holdout-qualification",
    setup.qualification_run,
    task.id,
    "before",
  );
  if (expected.installed_runtime_lock_sha256) {
    const installed = await readFile(
      join(prepared, "node_modules/.package-lock.json"),
    );
    if (hash(installed) !== expected.installed_runtime_lock_sha256)
      throw Error(`Prepared runtime hash changed: ${task.id}`);
  }
  try {
    await cp(join(prepared, "node_modules"), join(root, "node_modules"), {
      recursive: true,
      dereference: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function runCheckScript(script, root, args) {
  const result = spawnSync(
    process.execPath,
    [join(project, script), root, ...args],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return {
    exit_code: result.status,
    error: result.error?.message ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assessTask(task, root) {
  return {
    focused: runCheckScript(task.assessment.script, root, [task.id]),
    controls: runCheckScript("eval/labels/holdout-controls.cjs", root, [
      task.id,
    ]),
    ...(task.repository === "picomatch"
      ? {
          existing: runCheckScript(
            "eval/labels/holdout-existing.cjs",
            root,
            [],
          ),
        }
      : {}),
  };
}

const sourcePaths = [
  "eval/scripts/phase8-gemini-run.mjs",
  "eval/scripts/phase8-gemini-plan.mjs",
  "eval/scripts/evaluation-outcome.mjs",
  "eval/scripts/host-failures.mjs",
  "eval/scripts/pilot-metrics.mjs",
  "eval/scripts/verify-freeze.mjs",
  policyPath,
];

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const policy = await json(policyPath);
  const freeze = verifyFreeze(project, await json(freezePath));
  if (
    !freeze.valid ||
    policy.model !== GEMINI_MODEL ||
    policy.reasoning_effort !== GEMINI_PREFERRED_EFFORT ||
    policy.max_attempts !== GEMINI_MAX_ATTEMPTS ||
    JSON.stringify(policy.assignments) !== JSON.stringify(GEMINI_ASSIGNMENTS)
  ) {
    console.error("Gemini policy or evaluation freeze check failed");
    process.exit(2);
  }

  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        hash(await readFile(join(project, path))),
      ]),
    ),
  );

  if (process.argv.includes("--register")) {
    const existing = await readFile(join(project, ledgerPath), "utf8").catch(
      () => "",
    );
    if (existing.trim() && !process.argv.includes("--resume"))
      throw Error("Cannot register after a Gemini reservation exists");
    await save(
      join(project, registrationPath),
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        stratum: policy.stratum,
        host_mode: policy.host_mode,
        model: GEMINI_MODEL,
        reasoning_effort: GEMINI_PREFERRED_EFFORT,
        timeout_ms_per_task: GEMINI_TIMEOUT_MS,
        max_attempts: GEMINI_MAX_ATTEMPTS,
        evaluation_freeze_sha256: hash(
          await readFile(join(project, freezePath)),
        ),
        policy_sha256: hash(await readFile(join(project, policyPath))),
        independent_ledger: ledgerPath,
        assignments: policy.assignments,
        source_hashes: sourceHashes,
        stop_rule: policy.stop_rule,
      },
      process.argv.includes("--resume") ? {} : { flag: "wx" },
    );
    console.log(
      JSON.stringify(
        {
          operation: "phase8_gemini_registration",
          registered: true,
          model: GEMINI_MODEL,
          reasoning_effort: GEMINI_PREFERRED_EFFORT,
          assignments: policy.assignments.length,
          model_calls: 0,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (
    !process.argv.includes("--execute") &&
    !process.argv.includes("--resume")
  ) {
    console.log(
      JSON.stringify(
        {
          operation: "phase8_gemini_preview",
          execution: false,
          source_integrity: freeze.valid,
          host_mode: policy.host_mode,
          model: GEMINI_MODEL,
          reasoning_effort: GEMINI_PREFERRED_EFFORT,
          assignments: GEMINI_ASSIGNMENTS.length,
          model_calls: 0,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const isResume = process.argv.includes("--resume");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "GEMINI_API_KEY is required when running with --execute or --resume (direct Gemini API).",
    );
    process.exit(2);
  }

  const registration = await json(registrationPath);
  if (
    registration.model !== GEMINI_MODEL ||
    registration.reasoning_effort !== GEMINI_PREFERRED_EFFORT ||
    JSON.stringify(registration.source_hashes) !== JSON.stringify(sourceHashes)
  ) {
    throw Error(
      "Registered Gemini harness inputs changed; re-register before executing",
    );
  }

  const ledgerText = await readFile(join(project, ledgerPath), "utf8").catch(
    () => "",
  );
  const existingRows = ledgerText
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  if (existingRows.length && !isResume) {
    throw Error(
      "Gemini pilot cannot replace or duplicate existing reservations without --resume",
    );
  }

  const priorPreliminary = isResume
    ? await json("eval/summaries/phase8-gemini-preliminary.json").catch(
        () => null,
      )
    : null;
  const completedRowsBySlot = new Map();
  for (const row of priorPreliminary?.rows ?? []) {
    if (row.model === GEMINI_MODEL && row.status !== "infrastructure_invalid") {
      completedRowsBySlot.set(row.slot, row);
    }
  }

  const pool = await json("eval/manifests/holdout-readiness.json");
  const runtime = await json("eval/manifests/holdout-runtime.json");
  const readiness = await json("eval/summaries/holdout-readiness.json");
  const instruction = await readFile(
    join(project, "docs/ctxgate-instruction.md"),
    "utf8",
  );

  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = join(project, "eval/runs/phase8-gemini", runId);
  const temporary = join(geminiTrialRoot, `phase8-gemini-${runId}`);
  await mkdir(output, { recursive: true });
  await mkdir(dirname(join(project, ledgerPath)), { recursive: true });
  await save(join(output, "registration.json"), registration);

  const maxArgsPairs = Number(
    process.argv.find((arg) => arg.startsWith("--max-pairs="))?.split("=")[1] ??
      0,
  );
  const assignmentsToRun =
    maxArgsPairs > 0
      ? policy.assignments.slice(0, maxArgsPairs * 2)
      : policy.assignments;

  const rows = [];
  for (const assignment of assignmentsToRun) {
    if (completedRowsBySlot.has(assignment.slot)) {
      const preserved = completedRowsBySlot.get(assignment.slot);
      rows.push(preserved);
      console.log(
        JSON.stringify({
          slot: assignment.slot,
          resumed_skip: true,
          status: preserved.status,
          focused: preserved.assessment?.focused?.exit_code ?? null,
          controls: preserved.assessment?.controls?.exit_code ?? null,
        }),
      );
      continue;
    }
    const task = pool.tasks.find((row) => row.id === assignment.id);
    if (!task) throw Error(`Unknown Gemini task: ${assignment.id}`);
    const workspace = join(temporary, assignment.slot, "workspace");
    const target = join(output, assignment.slot);
    const trace = join(target, "mcp.jsonl");
    const protectedRoot = join(target, "protected-assessment");

    await exportTree(
      join(project, "eval/.cache/upstream", task.repository),
      task.base_commit,
      workspace,
    );
    await copyTaskDependencies(task, workspace, readiness, runtime);
    await initialize(workspace);

    await exportTree(
      join(project, "eval/.cache/upstream", task.repository),
      task.base_commit,
      protectedRoot,
    );
    await copyTaskDependencies(task, protectedRoot, readiness, runtime);

    const baseline = assessTask(task, protectedRoot);
    if (
      baseline.focused.exit_code === 0 ||
      baseline.controls.exit_code !== 0 ||
      (baseline.existing && baseline.existing.exit_code !== 0)
    ) {
      throw Error(`Task baseline no longer qualifies: ${task.id}`);
    }

    const original = await inventory(workspace);
    const prompt =
      task.prompt +
      "\n\nWork only in this repository using the provided workspace tools. Be concise and minimize tool turns: use `read_workspace_file` with `start_line` and `end_line` to inspect only the relevant section, use `patch_workspace_file` to apply the surgical fix, verify once with `run_focused_node_test` using a short standalone `node:assert` script, and immediately return your final answer." +
      (assignment.condition === "B" ? `\n\n${instruction}` : "");

    const reserved = {
      ...assignment,
      stratum: policy.stratum,
      run_id: runId,
      reserved_at: new Date().toISOString(),
      model: GEMINI_MODEL,
      reasoning_effort: GEMINI_PREFERRED_EFFORT,
    };
    await appendFile(
      join(project, ledgerPath),
      JSON.stringify(reserved) + "\n",
    );
    await save(join(target, "request.json"), {
      ...reserved,
      base_commit: task.base_commit,
      prompt,
      registration_sha256: hash(JSON.stringify(registration)),
    });

    const telemetry = [];
    const run = await runGeminiAgentSession({
      workspace,
      condition: assignment.condition,
      prompt,
      apiKey,
      onToolObservation: (obs) => {
        const { raw_text: _raw, tool_configuration: _cfg, ...cleanObs } = obs;
        telemetry.push(cleanObs);
      },
    });
    if (telemetry.length) {
      await writeFile(
        trace,
        telemetry.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }
    await save(join(target, "timeline.json"), run.timeline);

    const after = await inventory(workspace);
    const changed = [
      ...new Set([...Object.keys(original), ...Object.keys(after)]),
    ]
      .filter(
        (path) =>
          JSON.stringify(original[path]) !== JSON.stringify(after[path]),
      )
      .map((path) => ({
        path,
        before: original[path] ?? null,
        after: after[path] ?? null,
      }));

    for (const change of changed) {
      if (
        change.after?.unsupported ||
        /(^|\/)(?:test|tests)\/|\.test\.[cm]?[jt]sx?$/.test(change.path) ||
        change.path.startsWith(".ctx/") ||
        !/\.[cm]?[jt]sx?$/.test(change.path)
      )
        continue;
      const destination = resolve(protectedRoot, change.path);
      if (!within(protectedRoot, destination))
        throw Error("Unsafe overlay path");
      await mkdir(dirname(destination), { recursive: true });
      if (change.after)
        await writeFile(
          destination,
          await readFile(join(workspace, change.path)),
        );
      else await rm(destination, { force: true });
    }

    const assessment = assessTask(task, protectedRoot);
    const metrics = pilotMetrics(run, telemetry, { source_spans: [] });
    const preliminaryFailure = classifyHostFailure(run, changed, metrics);
    const hostFailure =
      run.stop_batch &&
      !run.account_limit_detected &&
      preliminaryFailure.status !== "product_failure"
        ? {
            status: "infrastructure_invalid",
            reason: "observed_host_lifecycle_failure",
            stop_batch: true,
            task_progress: preliminaryFailure.task_progress,
          }
        : preliminaryFailure;
    const status = evaluationOutcome({
      host_failure: hostFailure,
      timed_out: run.timed_out,
      model_turn_completed: run.model_turn_completed,
      assessment,
    });

    const patches = [];
    for (const change of changed) {
      if (change.after?.unsupported) continue;
      const originalFile = join(target, "original-files", change.path);
      const patchedFile = join(target, "patch-files", change.path);
      await mkdir(dirname(originalFile), { recursive: true });
      await mkdir(dirname(patchedFile), { recursive: true });
      const blob = spawnSync(
        "git",
        [
          "-C",
          join(project, "eval/.cache/upstream", task.repository),
          "show",
          `${task.base_commit}:${change.path}`,
        ],
        { maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
      await writeFile(
        originalFile,
        change.before && blob.status === 0 ? blob.stdout : "",
      );
      await writeFile(
        patchedFile,
        change.after ? await readFile(join(workspace, change.path)) : "",
      );
      const diff = spawnSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "diff",
          "--no-index",
          "--",
          originalFile,
          patchedFile,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      patches.push({ path: change.path, patch: diff.stdout });
    }

    const row = {
      ...reserved,
      host: run.host,
      status,
      baseline,
      assessment,
      metrics,
      host_failure: hostFailure,
      changed,
      patches,
      run: {
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        elapsed_ms: run.elapsed_ms,
        turn_completed_ms: run.turn_completed_ms,
        cleanup_elapsed_ms: run.cleanup_elapsed_ms,
        cleanup_forced: run.cleanup_forced,
        cleanup_incomplete: run.cleanup_incomplete,
        model_turn_completed: run.model_turn_completed,
        account_limit_detected: run.account_limit_detected,
        spawn_error: run.spawn_error,
      },
      review_required: true,
    };
    rows.push(row);
    await save(join(target, "report.json"), row);
    await save(join(output, "summary.json"), {
      schema_version: 1,
      stratum: policy.stratum,
      run_id: runId,
      completed_attempts: rows.length,
      planned_attempts: policy.assignments.length,
      rows,
    });
    console.log(
      JSON.stringify({
        slot: assignment.slot,
        status,
        focused: assessment.focused.exit_code,
        controls: assessment.controls.exit_code,
        context_calls: metrics.context_attempts,
        input_tokens: metrics.usage.input_tokens,
        output_tokens: metrics.usage.output_tokens,
        elapsed_ms: Math.round(run.elapsed_ms),
      }),
    );
    if (hostFailure.stop_batch) break;
  }
  await save(join(project, "eval/summaries/phase8-gemini-preliminary.json"), {
    schema_version: 1,
    stratum: policy.stratum,
    model: GEMINI_MODEL,
    reasoning_effort: GEMINI_PREFERRED_EFFORT,
    run_id: runId,
    created_at: new Date().toISOString(),
    planned_attempts: policy.assignments.length,
    completed_reports: rows.length,
    rows,
  });
}
