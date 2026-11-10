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
      description: "Read a UTF-8 text file inside the isolated task workspace.",
      parameters: {
        type: "OBJECT",
        properties: { path: { type: "STRING" } },
        required: ["path"],
      },
    },
    {
      name: "write_workspace_file",
      description:
        "Write a UTF-8 text file inside the isolated task workspace.",
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
        "Execute a local Node.js test file or script inside the isolated task workspace.",
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
        description: "Expand a source-bound ctxgate reference.",
        parameters: {
          type: "OBJECT",
          properties: {
            reference_json: { type: "STRING" },
            budget_tokens: { type: "INTEGER" },
          },
          required: ["reference_json"],
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
    return { content: await readFile(target, "utf8") };
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
    const ref = JSON.parse(String(args.reference_json ?? "{}"));
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
    const err = new Error(`Gemini API error (${response.status}): ${bodyText}`);
    err.status = response.status;
    err.body = bodyText;
    throw err;
  }
  return response.json();
}

export async function runGeminiAgentSession({
  workspace,
  condition = "A",
  prompt,
  apiKey,
  endpoint,
  maxTurns = GEMINI_MAX_TURNS,
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
      const elapsed = performance.now() - started;
      const remaining = Math.max(1000, Math.ceil(timeoutMs - elapsed));
      if (elapsed >= timeoutMs) {
        timedOut = true;
        break;
      }
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
          call.name === "write_workspace_file" &&
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
    if (existing.trim())
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
      { flag: "wx" },
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

  if (!process.argv.includes("--execute")) {
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "GEMINI_API_KEY is required when running with --execute (direct Gemini API).",
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
  if (existingRows.length) {
    throw Error(
      "Gemini pilot cannot resume, replace, or duplicate existing reservations",
    );
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

  const rows = [];
  for (const assignment of policy.assignments) {
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
      "\n\nWork only in this repository using the provided workspace tools. Preserve existing behavior beyond the request and run focused checks where helpful." +
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

    const row = {
      ...reserved,
      host: run.host,
      status,
      baseline,
      assessment,
      metrics,
      host_failure: hostFailure,
      changed,
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
    if (hostFailure.stop_batch) break;
  }
}
