import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  cp,
  appendFile,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import ts from "typescript";
import { initialize } from "../../dist/index.js";
import { verifyFreeze } from "./verify-freeze.mjs";
import { exportTree } from "./git-tree.mjs";
import {
  project,
  trialRoot,
  MODEL,
  EFFORT,
  WINDOWS_SANDBOX,
  openHostAudit,
  execArgs,
} from "./phase5-host.mjs";
import { pilotMetrics } from "./pilot-metrics.mjs";
import { classifyHostFailure } from "./host-failures.mjs";
import { resolveCodex } from "./codex-command.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
import { applyPhase8HostPin } from "./phase8-host-pin.mjs";
import { observedHostProcess } from "./observed-host-process.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  json = async (path) =>
    JSON.parse(await readFile(resolve(project, path), "utf8")),
  save = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + "\n");
  };
const hostPin = await applyPhase8HostPin(),
  policy = await json("eval/manifests/phase8-recovery-policy.json"),
  prefix = await json("eval/manifests/phase8-recovery-prefix.json"),
  parent = await json("eval/manifests/phase8-pre-task-fix.json"),
  pool = await json("eval/manifests/holdout-readiness.json"),
  assignments = policy.assignments,
  ledger = join(project, "eval/runs/phase8/attempts.jsonl"),
  registrationPath = join(
    project,
    "eval/manifests/phase8-recovery-registration.json",
  );
if (
  policy.max_new_attempts !== 33 ||
  assignments.length !== 33 ||
  prefix.reservations.length !== 3 ||
  policy.model !== MODEL ||
  policy.reasoning_effort !== EFFORT ||
  policy.max_total_attempts !== 36 ||
  policy.max_additional_model_probes !== 0 ||
  pool.tasks.some((task) => !task.assessment?.ground_truth_verified)
)
  throw Error("Recovery scope changed");
const originalAssignments = pool.tasks.flatMap((task, index) =>
  (index % 2 ? ["B", "A"] : ["A", "B"]).map((condition) => ({
    id: task.id,
    condition,
    repetition: 1,
    slot: task.id + "-r1-" + condition,
  })),
);
const expected = originalAssignments.filter(
  (row) => !prefix.reservations.some((used) => used.slot === row.slot),
);
if (JSON.stringify(expected) !== JSON.stringify(assignments))
  throw Error("Only original unattempted assignments are allowed");
const sourcePaths = [
  ...new Set([
    ...Object.keys(parent.source_hashes),
    "eval/scripts/phase8-recovery-run.mjs",
    "eval/scripts/phase8-recovery-readiness.mjs",
    "eval/scripts/observed-host-process.mjs",
    "eval/tests/host-lifecycle.test.mjs",
    "eval/manifests/phase8-recovery-policy.json",
    "eval/manifests/phase8-recovery-prefix.json",
  ]),
];
const hashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      hash(await readFile(join(project, path))),
    ]),
  ),
);
for (const [path, digest] of Object.entries(parent.source_hashes))
  if (hashes[path] !== digest)
    throw Error("Original capability/product/harness source changed: " + path);
const integrity = verifyFreeze(
  project,
  await json("eval/manifests/evaluation-freeze.json"),
);
if (!integrity.valid) throw Error("Product/task/assessment freeze changed");
const live = (await readFile(ledger, "utf8"))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
if (JSON.stringify(live.slice(0, 3)) !== JSON.stringify(prefix.reservations))
  throw Error("Consumed reservation prefix changed");
if (process.argv.includes("--register")) {
  if (live.length !== 3)
    throw Error("Cannot register after recovery reservations");
  await writeFile(
    registrationPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        authorization: policy.authorization,
        method_variant: policy.method_variant,
        original_prefix_sha256: hash(
          await readFile(
            join(project, "eval/manifests/phase8-recovery-prefix.json"),
          ),
        ),
        parent_registration_sha256: hash(
          await readFile(
            join(project, "eval/manifests/phase8-pre-task-fix.json"),
          ),
        ),
        assignments,
        source_hashes: hashes,
        model: MODEL,
        reasoning: EFFORT,
        max_new_attempts: 33,
        max_total_attempts: 36,
        max_additional_model_probes: 0,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered the user-authorized 33 unused slots under the separate terminal-event recovery method.",
  );
  process.exit(0);
}
const registration = await json(
  "eval/manifests/phase8-recovery-registration.json",
);
if (
  JSON.stringify(registration.source_hashes) !== JSON.stringify(hashes) ||
  JSON.stringify(registration.assignments) !== JSON.stringify(assignments)
)
  throw Error("Registered recovery inputs changed");
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        operation: "phase8_recovery_preview",
        assignments: assignments.length,
        consumed_original_slots: live.length,
        source_integrity: true,
        execution: false,
        method_variant: policy.method_variant,
        capability_model_probes_remaining: 0,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (live.length !== 3)
  throw Error(
    "Recovery already reserved slots; no implicit retries or further recovery block",
  );
const readyIndex = process.argv.indexOf("--readiness");
if (readyIndex < 0) throw Error("Fresh recovery readiness report required");
const ready = await json(resolve(process.argv[readyIndex + 1])),
  host = resolveCodex(),
  age = Date.now() - Date.parse(ready.created_at);
if (
  ready.operation !== "phase8_recovery_readiness" ||
  ready.status !== "ready" ||
  !ready.static_ready ||
  !ready.direct_mcp?.context_delivery ||
  !ready.cleanup_verified ||
  ready.registration_sha256 !== hash(await readFile(registrationPath)) ||
  ready.prior_capability_sha256 !== policy.prior_capability_sha256 ||
  ready.host.version !== hostPin.version ||
  ready.host.command !== hostPin.command ||
  ready.runtime !== process.version ||
  age < 0 ||
  age > 1800000
)
  throw Error("Fresh matching static/MCP/unchanged capability proof required");
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = join(project, "eval/runs/phase8-recovery", runId),
  temporary = join(trialRoot, "holdout-recovery-" + runId),
  audit = await json("eval/summaries/holdout-readiness.json");
await mkdir(output, { recursive: true });
await save(join(output, "registration.json"), registration);
await save(join(output, "readiness.json"), ready);
for (const path of sourcePaths) {
  const target = join(output, "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, path), target);
}
async function runHost(workspace, prompt, { condition, trace }) {
  const host = resolveCodex(),
    args = execArgs(workspace, prompt, condition, trace);
  return {
    host,
    args,
    ...(await observedHostProcess(host.command, args, {
      cwd: workspace,
      output: dirname(trace),
      timeout_ms: 300000,
      cleanup_grace_ms: 5000,
    })),
  };
}
// The protected assessment/export loop below is retained from the original
// registered runner. Only completion/lifecycle accounting and ledger/output
// bookkeeping change in this separately registered recovery variant.

const within = (parent, path) => {
  const rel = relative(parent, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};
async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
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
  const setup = audit.results.find((row) => row.id === task.id);
  const prepared = join(
    project,
    "eval/.cache/holdout-qualification",
    setup.qualification_run,
    task.id,
    "before",
  );
  const runtime = (
    await json("eval/manifests/holdout-runtime.json")
  ).tasks.find((row) => row.id === task.id);
  if (
    runtime.installed_runtime_lock_sha256 &&
    hash(await readFile(join(prepared, "node_modules/.package-lock.json"))) !==
      runtime.installed_runtime_lock_sha256
  )
    throw Error("Prepared runtime changed for " + task.id);
  try {
    await cp(join(prepared, "node_modules"), join(root, "node_modules"), {
      recursive: true,
      dereference: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (["json-server-h04", "json-server-h05"].includes(task.id)) {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await cp(
      join(project, "node_modules/typescript"),
      join(root, "node_modules/typescript"),
      { recursive: true },
    );
  }
}
async function transpile(root, prefix = "src") {
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix + "/" + entry.name;
    if (entry.isDirectory()) await transpile(root, path);
    else if (
      entry.name.endsWith(".ts") &&
      !/\.(?:test|d)\.ts$/.test(entry.name)
    ) {
      const text = await readFile(join(root, path), "utf8"),
        result = ts.transpileModule(text, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        });
      await writeFile(
        join(root, path.replace(/\.ts$/, ".js")),
        result.outputText,
      );
    }
  }
}
async function assess(task, root) {
  if (["json-server-h04", "json-server-h05"].includes(task.id))
    await transpile(root);
  const run = (script, args) => {
    const result = spawnSync(
      process.execPath,
      [join(project, script), root, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return {
      exit_code: result.status,
      error: result.error?.message ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return {
    focused: run(task.assessment.script, [task.id]),
    controls: run("eval/labels/holdout-controls.cjs", [task.id]),
    ...(task.repository === "picomatch"
      ? { existing: run("eval/labels/holdout-existing.cjs", []) }
      : {}),
  };
}
// Create all peer roots before constructing deny inventories. No future fixes/history.
for (const assignment of assignments) {
  const task = pool.tasks.find((task) => task.id === assignment.id),
    workspace = join(temporary, assignment.slot, "workspace");
  await exportTree(
    join(project, "eval/.cache/upstream", task.repository),
    task.base_commit,
    workspace,
  );
  await dependencies(task, workspace);
  initialize(workspace);
  await writeFile(join(workspace, ".ctxgate-eval-root"), "");
  await mkdir(join(workspace, "../host-state"), { recursive: true });
  await mkdir(join(workspace, "../host-logs"), { recursive: true });
}
const rows = [];
let lastWorkspace;
let stopReason = null;
try {
  for (const assignment of assignments) {
    const task = pool.tasks.find((task) => task.id === assignment.id),
      workspace = join(temporary, assignment.slot, "workspace"),
      target = join(output, assignment.slot),
      trace = join(target, "mcp.jsonl");
    await mkdir(target, { recursive: true });
    lastWorkspace = workspace;
    // Remove only this inactive owned slot's obsolete peer deny entries before reapplying policy.
    if (process.platform === "win32") {
      const restored = spawnSync(
        resolve(dirname(process.execPath), "../../native/powershell/pwsh.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(project, "eval/scripts/restore-phase8-slot.ps1"),
          "-TrialSlot",
          dirname(workspace),
          "-EvidencePath",
          join(target, "acl-restoration.json"),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      if (restored.status !== 0)
        throw Error("Owned-slot restoration failed: " + restored.stderr);
    }
    const original = await inventory(workspace),
      protectedRoot = join(target, "protected-assessment");
    await exportTree(
      join(project, "eval/.cache/upstream", task.repository),
      task.base_commit,
      protectedRoot,
    );
    await dependencies(task, protectedRoot);
    const baseline = await assess(task, protectedRoot);
    if (
      baseline.focused.exit_code === 0 ||
      baseline.controls.exit_code !== 0 ||
      (baseline.existing && baseline.existing.exit_code !== 0)
    )
      throw Error("Task baseline no longer qualifies: " + task.id);
    const canary = join(target, "canary.txt");
    await writeFile(canary, "assessment-only");
    const hostAudit = await openHostAudit(workspace);
    let controls;
    try {
      const config = (
        await hostAudit.request("config/read", {
          cwd: workspace,
          includeLayers: false,
        })
      ).config;
      const inside = await hostAudit.request("command/exec", {
        command: [process.execPath, "-e", 'process.stdout.write("INSIDE")'],
        cwd: workspace,
        permissionProfile: "ctxgate_eval",
        timeoutMs: 10000,
      });
      let denied = false;
      try {
        const probe = await hostAudit.request("command/exec", {
          command: [
            process.execPath,
            "-e",
            'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))',
            canary,
          ],
          cwd: workspace,
          permissionProfile: "ctxgate_eval",
          timeoutMs: 10000,
        });
        denied =
          probe.exitCode !== 0 && /EPERM|EACCES/.test(probe.stderr ?? "");
      } catch (error) {
        denied = /EPERM|EACCES/.test(error.message);
      }
      controls = {
        model: config.model,
        reasoning: config.model_reasoning_effort,
        memory_disabled:
          config.memories?.use_memories === false &&
          config.memories?.generate_memories === false,
        integrations_disabled:
          config.features?.plugins === false &&
          config.features?.apps === false &&
          config.features?.multi_agent === false,
        windows_sandbox: config.windows?.sandbox,
        network_disabled:
          config.permissions?.ctxgate_eval?.network?.enabled === false,
        inside: inside.exitCode === 0,
        protected_read_denied: denied,
      };
      const peer = assignments.find((row) => row.slot !== assignment.slot);
      const protectedProbe = await hostAudit.request("command/exec", {
        command: [
          process.execPath,
          "-e",
          'const f=require("node:fs");console.log(JSON.stringify(process.argv.slice(1).map(path=>{try{f.closeSync(f.openSync(path,"r"));return "OPENED"}catch(error){return error.code}})))',
          join(
            process.env.CODEX_HOME ?? join(homedir(), ".codex"),
            "config.toml",
          ),
          join(temporary, peer.slot, "workspace/.ctxgate-eval-root"),
        ],
        cwd: workspace,
        permissionProfile: "ctxgate_eval",
        timeoutMs: 10000,
      });
      const protection = JSON.parse(protectedProbe.stdout ?? "[]");
      controls.personal_state_read_denied = /^(EPERM|EACCES)$/.test(
        protection[0] ?? "",
      );
      controls.peer_read_denied = /^(EPERM|EACCES)$/.test(protection[1] ?? "");
      if (
        controls.model !== MODEL ||
        controls.reasoning !== EFFORT ||
        !controls.memory_disabled ||
        !controls.integrations_disabled ||
        !controls.inside ||
        controls.windows_sandbox !== WINDOWS_SANDBOX ||
        !controls.network_disabled ||
        !controls.personal_state_read_denied ||
        !controls.peer_read_denied ||
        !controls.protected_read_denied
      )
        throw Error("Per-assignment isolation gate failed");
    } finally {
      await hostAudit.close();
    }
    const instruction = await readFile(
      join(project, "docs/ctxgate-instruction.md"),
      "utf8",
    );
    const prompt =
      task.prompt +
      "\n\nWork only in this repository. Do not access other workspaces, parent/project/evaluation folders, upstream Git history, network or other agents. Runtime dependencies are prepared locally; use focused checks where available. Preserve behavior beyond the request and report your checks." +
      (assignment.condition === "B" ? "\n\n" + instruction : "");
    const reserved = {
      ...assignment,
      run_id: runId,
      reserved_at: new Date().toISOString(),
    };
    const usedBefore = (await readFile(ledger, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean).length;
    if (usedBefore >= 36) throw Error("Global 36-attempt ceiling reached");
    reserved.method_variant = policy.method_variant;
    await appendFile(ledger, JSON.stringify(reserved) + "\n");
    await save(join(target, "request.json"), {
      ...reserved,
      base_commit: task.base_commit,
      host,
      model: MODEL,
      reasoning: EFFORT,
      controls,
      prompt,
      registration_sha256: hash(JSON.stringify(registration)),
    });
    const run = await runHost(workspace, prompt, {
      condition: assignment.condition,
      trace,
      timeout_ms: 300000,
    });
    // Raw stdout/stderr are already persisted as they arrive; never truncate them.
    await save(join(target, "timeline.json"), run.timeline);
    let telemetry = [];
    try {
      telemetry = (await readFile(trace, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
    } catch {}
    const after = await inventory(workspace),
      changed = [...new Set([...Object.keys(original), ...Object.keys(after)])]
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
    const assessed = await assess(task, protectedRoot),
      metrics = pilotMetrics(run, telemetry, undefined),
      initialFailure = classifyHostFailure(run, changed, metrics);
    const failure =
      run.stop_batch &&
      !run.account_limit_detected &&
      initialFailure.status !== "product_failure"
        ? {
            status: "infrastructure_invalid",
            reason: "observed_host_lifecycle_failure",
            stop_batch: true,
            task_progress: initialFailure.task_progress,
          }
        : initialFailure;
    const checkerUsed = telemetry.some((event) => event.operation === "check");
    const status =
      failure.status === "infrastructure_invalid"
        ? "infrastructure_invalid"
        : failure.status === "product_failure"
          ? "product_failure"
          : run.timed_out ||
              assessed.focused.exit_code !== 0 ||
              assessed.controls.exit_code !== 0 ||
              (assessed.existing && assessed.existing.exit_code !== 0)
            ? "task_failure"
            : "unassessed";
    const patches = [];
    for (const change of changed) {
      if (change.after?.unsupported) continue;
      const baselinePath = join(target, "original-files", change.path),
        patchedPath = join(target, "patch-files", change.path);
      await mkdir(dirname(baselinePath), { recursive: true });
      await mkdir(dirname(patchedPath), { recursive: true });
      const blob = spawnSync(
        "git",
        [
          "-C",
          join(project, "eval/.cache/upstream", task.repository),
          "show",
          task.base_commit + ":" + change.path,
        ],
        { maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
      await writeFile(
        baselinePath,
        change.before && blob.status === 0 ? blob.stdout : "",
      );
      await writeFile(
        patchedPath,
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
          baselinePath,
          patchedPath,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      patches.push({ path: change.path, patch: diff.stdout });
    }
    const row = {
      ...reserved,
      host,
      status,
      checker_used: checkerUsed,
      baseline,
      assessment: assessed,
      metrics,
      host_failure: failure,
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
      run_id: runId,
      completed_attempts: rows.length,
      planned_attempts: assignments.length,
      rows,
    });
    console.log(
      JSON.stringify({
        slot: assignment.slot,
        status,
        focused: assessed.focused.exit_code,
        elapsed_ms: run.elapsed_ms,
      }),
    );
    await restorePhase8Access(join(target, "permission-restoration.json"));
    if (failure.stop_batch || checkerUsed) {
      stopReason = checkerUsed
        ? "Unexpected checker contamination"
        : "Infrastructure failure";
      break;
    }
  }
} catch (error) {
  stopReason = error.message;
  await save(join(output, "stop.json"), {
    stopped_at: new Date().toISOString(),
    reason: stopReason,
  });
  process.exitCode = 2;
} finally {
  if (lastWorkspace) {
    try {
      await restorePhase8Access(
        join(output, "final-permission-restoration.json"),
      );
    } catch (error) {
      stopReason = "Cleanup failure: " + error.message;
      process.exitCode = 2;
    }
  }
  const reserved = (await readFile(ledger, "utf8").catch(() => ""))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean).length;
  await save(join(project, "eval/summaries/phase8-recovery-preliminary.json"), {
    schema_version: 1,
    run_id: runId,
    created_at: new Date().toISOString(),
    planned_attempts: assignments.length,
    reserved_attempts: reserved - 3,
    total_reserved_across_variants: reserved,
    completed_reports: rows.length,
    unassessed_reservations: reserved - 3 - rows.length,
    stop_reason: stopReason,
    patch_review_pending: true,
    rows,
  });
}
