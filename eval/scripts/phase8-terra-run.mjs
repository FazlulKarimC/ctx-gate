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
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { initialize } from "../../dist/index.js";
import { evaluationOutcome } from "./evaluation-outcome.mjs";
import { exportTree } from "./git-tree.mjs";
import { classifyHostFailure } from "./host-failures.mjs";
import { observedHostProcess } from "./observed-host-process.mjs";
import { pilotMetrics } from "./pilot-metrics.mjs";
import { project, trialRoot } from "./phase5-host.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
import { applyTerraHostPin } from "./phase8-terra-host-bootstrap.mjs";
import {
  openTerraHostAudit,
  TERRA_PERMISSION_PROFILE,
  TERRA_SANDBOX,
  terraExecArgs,
} from "./phase8-terra-host.mjs";
import {
  TERRA_ASSIGNMENTS,
  TERRA_MAX_ATTEMPTS,
  TERRA_MODEL,
  TERRA_TIMEOUT_MS,
  chooseTerraEffort,
} from "./phase8-terra-plan.mjs";
import { verifyFreeze } from "./verify-freeze.mjs";
import { resolveCodex } from "./codex-command.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) =>
  JSON.parse(await readFile(join(project, path), "utf8"));
const save = async (path, value, options = {}) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", options);
};
const id = new Date().toISOString().replaceAll(/[:.]/g, "-");
const policyPath = "eval/manifests/phase8-terra-policy.json";
const prefixPath = "eval/manifests/phase8-terra-prefix.json";
const registrationPath = "eval/manifests/phase8-terra-registration.json";
const amendmentPath = "eval/manifests/phase8-terra-pre-task-amendment.json";
const amendment2Path = "eval/manifests/phase8-terra-pre-task-amendment-2.json";
const ledgerPath = "eval/runs/phase8-terra/attempts.jsonl";
const policy = await json(policyPath);
const prefix = await json(prefixPath);
const pool = await json("eval/manifests/holdout-readiness.json");
const runtime = await json("eval/manifests/holdout-runtime.json");
const readiness = await json("eval/summaries/holdout-readiness.json");
const hostPin = await applyTerraHostPin();

const modelListPath = policy.model_list_report;
const isolationPath = policy.isolation_report;
const modelListBytes = await readFile(join(project, modelListPath));
const isolationBytes = await readFile(join(project, isolationPath));
const modelList = JSON.parse(modelListBytes);
const isolation = JSON.parse(isolationBytes);
const effort = chooseTerraEffort({
  defaultReasoningEffort: modelList.terra?.default_reasoning_effort,
  supportedReasoningEfforts: modelList.terra?.supported_reasoning_efforts,
});

if (
  policy.stratum !== "gpt56_terra_independent_pilot" ||
  policy.model !== TERRA_MODEL ||
  policy.reasoning_effort !== effort ||
  policy.max_attempts !== TERRA_MAX_ATTEMPTS ||
  policy.timeout_seconds_per_task * 1000 !== TERRA_TIMEOUT_MS ||
  policy.max_additional_model_probes !== 0 ||
  JSON.stringify(policy.assignments) !== JSON.stringify(TERRA_ASSIGNMENTS) ||
  JSON.stringify(prefix.reservations) !== JSON.stringify([]) ||
  hash(modelListBytes) !== policy.model_list_sha256 ||
  hash(isolationBytes) !== policy.isolation_report_sha256 ||
  modelList.operation !== "phase8_terra_model_list" ||
  modelList.status !== "ready" ||
  modelList.terra?.model !== TERRA_MODEL ||
  isolation.operation !== "phase8_terra_export_isolation" ||
  isolation.status !== "ready" ||
  isolation.model_calls !== 0 ||
  isolation.model !== TERRA_MODEL ||
  isolation.reasoning_effort !== effort ||
  isolation.tasks.length !== 6 ||
  isolation.tasks.some((task) => !task.ready) ||
  pool.tasks.some((task) => !task.assessment?.ground_truth_verified)
)
  throw Error(
    "Terra policy, model discovery, or no-model isolation proof changed",
  );

const integrity = verifyFreeze(
  project,
  await json("eval/manifests/evaluation-freeze.json"),
);
if (!integrity.valid) throw Error("Product/task/assessment freeze changed");

const sourcePaths = [
  "eval/scripts/phase8-terra-run.mjs",
  "eval/scripts/phase8-terra-host.mjs",
  "eval/scripts/phase8-terra-host-bootstrap.mjs",
  "eval/scripts/phase8-terra-plan.mjs",
  "eval/scripts/phase8-terra-model-list.mjs",
  "eval/scripts/phase8-terra-isolation.mjs",
  "eval/scripts/observed-host-process.mjs",
  "eval/scripts/evaluation-outcome.mjs",
  "eval/scripts/host-failures.mjs",
  "eval/scripts/pilot-metrics.mjs",
  "eval/scripts/mcp-observer.mjs",
  "eval/scripts/phase8-cleanup.mjs",
  "eval/scripts/phase5-host.mjs",
  "eval/scripts/verify-freeze.mjs",
  policyPath,
  prefixPath,
  "eval/manifests/phase8-terra-host.json",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      hash(await readFile(join(project, path))),
    ]),
  ),
);
const historicalSolLedger = await readFile(
  join(project, policy.historical_sol_ledger),
);
const historicalSolLedgerSha256 = hash(historicalSolLedger);

if (process.argv.includes("--register")) {
  const existing = await readFile(join(project, ledgerPath), "utf8").catch(
    () => "",
  );
  if (existing.trim()) throw Error("Cannot register after a Terra reservation");
  await save(
    join(project, registrationPath),
    {
      schema_version: 1,
      registered_at: new Date().toISOString(),
      authorization: policy.authorization,
      stratum: policy.stratum,
      policy_sha256: hash(await readFile(join(project, policyPath))),
      prefix_sha256: hash(await readFile(join(project, prefixPath))),
      model_list_sha256: hash(modelListBytes),
      isolation_sha256: hash(isolationBytes),
      evaluation_freeze_sha256: hash(
        await readFile(join(project, "eval/manifests/evaluation-freeze.json")),
      ),
      historical_sol_ledger_sha256: historicalSolLedgerSha256,
      independent_ledger: ledgerPath,
      assignments: policy.assignments,
      model: TERRA_MODEL,
      reasoning_effort: effort,
      timeout_ms_per_task: TERRA_TIMEOUT_MS,
      max_attempts: TERRA_MAX_ATTEMPTS,
      max_additional_model_probes: 0,
      host: hostPin,
      source_hashes: sourceHashes,
      stop_rule: policy.stop_rule,
    },
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        operation: "phase8_terra_registration",
        registered: true,
        model_calls: 0,
        assignments: policy.assignments.length,
        ledger: ledgerPath,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const registrationBytes = await readFile(join(project, registrationPath));
const registration = JSON.parse(registrationBytes);
const amendmentBytes = await readFile(join(project, amendmentPath)).catch(
  () => null,
);
const amendment = amendmentBytes ? JSON.parse(amendmentBytes) : null;
const amendment2Bytes = await readFile(join(project, amendment2Path)).catch(
  () => null,
);
const amendment2 = amendment2Bytes ? JSON.parse(amendment2Bytes) : null;
if (process.argv.includes("--register-pre-task-amendment")) {
  const ledger = await readFile(join(project, ledgerPath), "utf8").catch(
    () => "",
  );
  if (ledger.trim()) throw Error("Cannot amend after a Terra reservation");
  if (amendment) throw Error("Terra pre-task amendment already registered");
  await save(
    join(project, amendmentPath),
    {
      schema_version: 1,
      registered_at: new Date().toISOString(),
      supersedes_registration_sha256: hash(registrationBytes),
      reason:
        "The initial execution reached a per-task static isolation gate before any ledger reservation or model request. This amendment records added failure diagnostics only; it changes no task, arm order, model, effort, timeout, host pin, prompt, assessment, stop rule, or ceiling.",
      prior_no_model_run: "eval/runs/phase8-terra/2026-11-06T18-57-37-134Z",
      source_hashes: sourceHashes,
      assignments: policy.assignments,
      model: TERRA_MODEL,
      reasoning_effort: effort,
      timeout_ms_per_task: TERRA_TIMEOUT_MS,
      max_attempts: TERRA_MAX_ATTEMPTS,
    },
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        operation: "phase8_terra_pre_task_amendment",
        registered: true,
        model_calls: 0,
        reservations: 0,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (process.argv.includes("--register-pre-task-amendment-2")) {
  const ledger = await readFile(join(project, ledgerPath), "utf8").catch(
    () => "",
  );
  if (ledger.trim()) throw Error("Cannot amend after a Terra reservation");
  if (!amendment || amendment2)
    throw Error("Expected exactly one prior Terra pre-task amendment");
  await save(
    join(project, amendment2Path),
    {
      schema_version: 1,
      registered_at: new Date().toISOString(),
      supersedes_amendment_sha256: hash(amendmentBytes),
      reason:
        "The first diagnostic showed that the peer negative probe appended 'workspace' twice and therefore tested a nonexistent path. This amendment corrects only that probe path; no model request or reservation occurred, and it changes no task, arm order, model, effort, timeout, host pin, prompt, assessment, stop rule, or ceiling.",
      prior_no_model_runs: [
        "eval/runs/phase8-terra/2026-11-06T18-57-37-134Z",
        "eval/runs/phase8-terra/2026-11-06T19-01-09-888Z",
      ],
      source_hashes: sourceHashes,
      assignments: policy.assignments,
      model: TERRA_MODEL,
      reasoning_effort: effort,
      timeout_ms_per_task: TERRA_TIMEOUT_MS,
      max_attempts: TERRA_MAX_ATTEMPTS,
    },
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        operation: "phase8_terra_pre_task_amendment_2",
        registered: true,
        model_calls: 0,
        reservations: 0,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (
  registration.stratum !== policy.stratum ||
  registration.model !== TERRA_MODEL ||
  registration.reasoning_effort !== effort ||
  registration.max_attempts !== TERRA_MAX_ATTEMPTS ||
  registration.timeout_ms_per_task !== TERRA_TIMEOUT_MS ||
  JSON.stringify(registration.assignments) !==
    JSON.stringify(policy.assignments) ||
  registration.historical_sol_ledger_sha256 !== historicalSolLedgerSha256 ||
  registration.host.command !== hostPin.command ||
  registration.host.version !== hostPin.version
)
  throw Error("Registered Terra inputs changed");
if (
  amendment &&
  (amendment.supersedes_registration_sha256 !== hash(registrationBytes) ||
    JSON.stringify(amendment.assignments) !==
      JSON.stringify(policy.assignments) ||
    amendment.model !== TERRA_MODEL ||
    amendment.reasoning_effort !== effort ||
    amendment.timeout_ms_per_task !== TERRA_TIMEOUT_MS ||
    amendment.max_attempts !== TERRA_MAX_ATTEMPTS ||
    (!amendment2 &&
      JSON.stringify(amendment.source_hashes) !== JSON.stringify(sourceHashes)))
)
  throw Error("Registered Terra pre-task amendment changed");
if (
  amendment2 &&
  (amendment2.supersedes_amendment_sha256 !== hash(amendmentBytes) ||
    JSON.stringify(amendment2.assignments) !==
      JSON.stringify(policy.assignments) ||
    amendment2.model !== TERRA_MODEL ||
    amendment2.reasoning_effort !== effort ||
    amendment2.timeout_ms_per_task !== TERRA_TIMEOUT_MS ||
    amendment2.max_attempts !== TERRA_MAX_ATTEMPTS ||
    JSON.stringify(amendment2.source_hashes) !== JSON.stringify(sourceHashes))
)
  throw Error("Registered second Terra pre-task amendment changed");
if (
  !amendment2 &&
  !amendment &&
  JSON.stringify(registration.source_hashes) !== JSON.stringify(sourceHashes)
)
  throw Error("Registered Terra harness source changed without amendment");

const ledgerText = await readFile(join(project, ledgerPath), "utf8").catch(
  () => "",
);
const existingRows = ledgerText
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
if (
  existingRows.length ||
  new Set(existingRows.map((row) => row.slot)).size !== existingRows.length
)
  throw Error("Terra pilot cannot resume, replace, or duplicate reservations");
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        operation: "phase8_terra_preview",
        execution: false,
        source_integrity: true,
        model_calls: 0,
        assignments: policy.assignments.length,
        model: TERRA_MODEL,
        reasoning_effort: effort,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const runId = id;
const output = join(project, "eval/runs/phase8-terra", runId);
const temporary = join(trialRoot, `phase8-terra-${runId}`);
await mkdir(output, { recursive: true });
await save(join(output, "registration.json"), registration);
await save(join(output, "model-list.json"), modelList);
await save(join(output, "isolation.json"), isolation);
for (const path of sourcePaths) {
  const target = join(output, "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, path), target);
}

const within = (parent, path) => {
  const part = relative(parent, path);
  return !part.startsWith("..") && !isAbsolute(part);
};
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
async function dependencies(task, root) {
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
function check(script, root, args) {
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
function assess(task, root) {
  return {
    focused: check(task.assessment.script, root, [task.id]),
    controls: check("eval/labels/holdout-controls.cjs", root, [task.id]),
    ...(task.repository === "picomatch"
      ? { existing: check("eval/labels/holdout-existing.cjs", root, []) }
      : {}),
  };
}
async function exec(audit, workspace, command) {
  try {
    return await audit.request("command/exec", {
      command,
      cwd: workspace,
      permissionProfile: TERRA_PERMISSION_PROFILE,
      timeoutMs: 10_000,
    });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: error.message, rpc_error: true };
  }
}
const denied = (entry) =>
  entry.exitCode !== 0 &&
  /EACCES|EPERM|access.*denied|permission/i.test(
    `${entry.stdout} ${entry.stderr}`,
  );
async function verifyAssignmentHost(
  workspace,
  protectedRoot,
  condition,
  trace,
  peer,
) {
  const audit = await openTerraHostAudit(workspace, {
    model: TERRA_MODEL,
    effort,
    condition,
    trace,
    deniedPaths: [protectedRoot, peer],
  });
  try {
    const config = await audit.request("config/read", {
      cwd: workspace,
      includeLayers: false,
    });
    const inside = await exec(audit, workspace, [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(".ctxgate-host-canary","ok");process.stdout.write(require("node:fs").readFileSync(".ctxgate-host-canary","utf8"))',
    ]);
    const protectedRead = await exec(audit, workspace, [
      process.execPath,
      "-e",
      'const f=require("node:fs");try{f.readFileSync(process.argv[1]);process.stdout.write("OPENED")}catch(error){process.stderr.write(error.code);process.exitCode=13}',
      join(project, "eval/labels/holdout-regressions.cjs"),
    ]);
    const personalRead = await exec(audit, workspace, [
      process.execPath,
      "-e",
      'const f=require("node:fs");try{f.readFileSync(process.argv[1]);process.stdout.write("OPENED")}catch(error){process.stderr.write(error.code);process.exitCode=13}',
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
    ]);
    const peerRead = await exec(audit, workspace, [
      process.execPath,
      "-e",
      'const f=require("node:fs");try{f.readFileSync(process.argv[1]);process.stdout.write("OPENED")}catch(error){process.stderr.write(error.code);process.exitCode=13}',
      join(peer, ".ctxgate-eval-root"),
    ]);
    const value = config.config ?? {};
    const controls = {
      model: value.model,
      reasoning: value.model_reasoning_effort,
      windows_sandbox: value.windows?.sandbox,
      memory_disabled:
        value.memories?.use_memories === false &&
        value.memories?.generate_memories === false,
      integrations_disabled:
        value.features?.plugins === false &&
        value.features?.apps === false &&
        value.features?.multi_agent === false,
      network_disabled:
        value.permissions?.[TERRA_PERMISSION_PROFILE]?.network?.enabled ===
        false,
      workspace_roundtrip: inside.exitCode === 0 && inside.stdout === "ok",
      evaluation_read_denied: denied(protectedRead),
      personal_read_denied: denied(personalRead),
      peer_read_denied: denied(peerRead),
    };
    const ready =
      controls.model === TERRA_MODEL &&
      controls.reasoning === effort &&
      controls.windows_sandbox === TERRA_SANDBOX &&
      controls.memory_disabled &&
      controls.integrations_disabled &&
      controls.network_disabled &&
      controls.workspace_roundtrip &&
      controls.evaluation_read_denied &&
      controls.personal_read_denied &&
      controls.peer_read_denied;
    if (!ready)
      throw Error(
        `Per-assignment isolation gate failed: ${JSON.stringify(controls)}`,
      );
    return controls;
  } finally {
    await audit.close();
  }
}
async function runHost(workspace, prompt, condition, trace) {
  const host = resolveCodex();
  const args = terraExecArgs(workspace, prompt, {
    model: TERRA_MODEL,
    effort,
    condition,
    trace,
  });
  return {
    host,
    args,
    ...(await observedHostProcess(host.command, args, {
      cwd: workspace,
      output: dirname(trace),
      timeout_ms: TERRA_TIMEOUT_MS,
      cleanup_grace_ms: policy.cleanup_grace_seconds * 1000,
    })),
  };
}

const prepared = new Map();
for (const assignment of policy.assignments) {
  const task = pool.tasks.find((row) => row.id === assignment.id);
  if (!task) throw Error(`Unknown Terra task: ${assignment.id}`);
  const workspace = join(temporary, assignment.slot, "workspace");
  await exportTree(
    join(project, "eval/.cache/upstream", task.repository),
    task.base_commit,
    workspace,
  );
  await dependencies(task, workspace);
  await initialize(workspace);
  await writeFile(join(workspace, ".ctxgate-eval-root"), "");
  await mkdir(join(workspace, "../host-state"), { recursive: true });
  await mkdir(join(workspace, "../host-logs"), { recursive: true });
  prepared.set(assignment.slot, { task, workspace });
}

const rows = [];
let stopReason = null;
let reservedCount = 0;
try {
  for (const assignment of policy.assignments) {
    const { task, workspace } = prepared.get(assignment.slot);
    const target = join(output, assignment.slot);
    const trace = join(target, "mcp.jsonl");
    const peer = policy.assignments.find((row) => row.slot !== assignment.slot);
    const peerWorkspace = prepared.get(peer.slot).workspace;
    await mkdir(target, { recursive: true });
    const original = await inventory(workspace);
    const protectedRoot = join(target, "protected-assessment");
    await exportTree(
      join(project, "eval/.cache/upstream", task.repository),
      task.base_commit,
      protectedRoot,
    );
    await dependencies(task, protectedRoot);
    const baseline = assess(task, protectedRoot);
    if (
      baseline.focused.exit_code === 0 ||
      baseline.controls.exit_code !== 0 ||
      (baseline.existing && baseline.existing.exit_code !== 0)
    )
      throw Error(`Task baseline no longer qualifies: ${task.id}`);
    const controls = await verifyAssignmentHost(
      workspace,
      protectedRoot,
      assignment.condition,
      trace,
      peerWorkspace,
    );
    const instruction = await readFile(
      join(project, "docs/ctxgate-instruction.md"),
      "utf8",
    );
    const prompt =
      task.prompt +
      "\n\nWork only in this repository. Do not access other workspaces, parent/project/evaluation folders, upstream Git history, network, personal state, or other agents. Runtime dependencies are prepared locally; use focused checks where available. Preserve behavior beyond the request and report your checks." +
      (assignment.condition === "B" ? `\n\n${instruction}` : "");
    const reserved = {
      ...assignment,
      stratum: policy.stratum,
      run_id: runId,
      reserved_at: new Date().toISOString(),
      model: TERRA_MODEL,
      reasoning_effort: effort,
    };
    await appendFile(
      join(project, ledgerPath),
      JSON.stringify(reserved) + "\n",
    );
    reservedCount++;
    await save(join(target, "request.json"), {
      ...reserved,
      base_commit: task.base_commit,
      host: resolveCodex(),
      controls,
      prompt,
      registration_sha256: hash(JSON.stringify(registration)),
    });
    const run = await runHost(workspace, prompt, assignment.condition, trace);
    await save(join(target, "timeline.json"), run.timeline);
    let telemetry = [];
    try {
      telemetry = (await readFile(trace, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
    } catch {}
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
    const assessment = assess(task, protectedRoot);
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
    await restorePhase8Access(join(target, "permission-restoration.json"));
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
        elapsed_ms: run.elapsed_ms,
      }),
    );
    if (hostFailure.stop_batch) {
      stopReason = hostFailure.reason ?? "Infrastructure failure";
      break;
    }
  }
} catch (error) {
  stopReason = error.message;
  process.exitCode = 2;
} finally {
  try {
    const cleanup = await restorePhase8Access(
      join(output, "final-permission-restoration.json"),
    );
    if (!cleanup.verified) throw Error("Final permission cleanup not verified");
  } catch (error) {
    stopReason = `Cleanup failure: ${error.message}`;
    process.exitCode = 2;
  }
  if (stopReason)
    await save(join(output, "stop.json"), {
      stopped_at: new Date().toISOString(),
      reason: stopReason,
    });
  const ledger = (
    await readFile(join(project, ledgerPath), "utf8").catch(() => "")
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  await save(join(project, "eval/summaries/phase8-terra-preliminary.json"), {
    schema_version: 1,
    stratum: policy.stratum,
    run_id: runId,
    created_at: new Date().toISOString(),
    planned_attempts: policy.assignments.length,
    reserved_attempts: ledger.length,
    completed_reports: rows.length,
    unassessed_reservations: ledger.length - rows.length,
    stop_reason: stopReason,
    patch_review_pending: true,
    rows,
  });
}
