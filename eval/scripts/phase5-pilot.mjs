import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  appendFile,
  cp,
  lstat,
  rm,
} from "node:fs/promises";
import { join, relative, isAbsolute, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { initialize } from "../../dist/index.js";
import { exportTree } from "./git-tree.mjs";
import {
  project,
  trialRoot,
  MODEL,
  EFFORT,
  runHost,
  execArgs,
  openHostAudit,
  restoreNormalWorkspaceAccess,
} from "./phase5-host.mjs";
import { pilotMetrics } from "./pilot-metrics.mjs";
import { resolveCodex } from "./codex-command.mjs";
import { classifyHostFailure } from "./host-failures.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex"),
  json = async (path) =>
    JSON.parse(await readFile(join(project, path), "utf8")),
  save = async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  };
const policy = await json("eval/manifests/phase5-policy.json"),
  pool = await json("eval/manifests/agent-pool.json"),
  tasks = policy.tasks.map((id) => pool.tasks.find((task) => task.id === id));
if (
  tasks.some(
    (task) =>
      !task ||
      task.split !== "development" ||
      task.qualification !== "behavioral_regression_verified" ||
      !task.assessment?.ground_truth_verified,
  )
)
  throw Error("Only the five behaviorally verified development tasks qualify");
const instruction = await readFile(
  join(project, "docs/ctxgate-instruction.md"),
  "utf8",
);
const assignments = [];
for (let repetition = 0; repetition < policy.repetitions; repetition++)
  for (let index = 0; index < tasks.length; index++)
    for (const condition of (index + repetition) % 2 ? ["B", "A"] : ["A", "B"])
      assignments.push({
        id: tasks[index].id,
        repetition: repetition + 1,
        condition,
        slot: tasks[index].id + "-r" + (repetition + 1) + "-" + condition,
      });
if (
  assignments.length !== 20 ||
  tasks.length !== 5 ||
  policy.timeout_seconds_per_task !== 300
)
  throw Error("This registered pilot is capped at twenty five-minute attempts");
const registrationFile = join(project, "eval/manifests/phase5-pilot.json");
async function sourceFiles(path) {
  const all = [];
  for (const entry of await readdir(join(project, path), {
    withFileTypes: true,
  })) {
    const local = path + "/" + entry.name;
    if (entry.isDirectory()) all.push(...(await sourceFiles(local)));
    else all.push(local);
  }
  return all.sort();
}
const inputs = [
  ...(await sourceFiles("src")),
  ...(await sourceFiles("tests")),
  ...(await sourceFiles("eval/scripts")),
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "eval/manifests/phase5-policy.json",
  "eval/manifests/agent-pool.json",
  "eval/labels/candidate-review.json",
  "eval/labels/picomatch-initial.cjs",
  "eval/labels/picomatch-existing.cjs",
  "eval/labels/development-retrieval.json",
  "docs/ctxgate-instruction.md",
];
const hashes = Object.fromEntries(
  await Promise.all(
    inputs.map(async (path) => [
      path,
      sha(await readFile(join(project, path))),
    ]),
  ),
);
const resumeIndex = process.argv.indexOf("--resume-run"),
  resumeRun = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
if (resumeRun && !/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(resumeRun))
  throw Error("Invalid resume run identifier");
const resumeRegistrationFile = join(
  project,
  "eval/manifests/phase5-resume.json",
);
if (process.argv.includes("--register-resume")) {
  if (!resumeRun) throw Error("An existing run ID is required");
  const original = await json("eval/manifests/phase5-pilot.json");
  const changed = Object.keys(original.source_hashes).filter(
    (path) => original.source_hashes[path] !== hashes[path],
  );
  const added = Object.keys(hashes).filter(
    (path) => !(path in original.source_hashes),
  );
  if (
    JSON.stringify(changed) !==
      JSON.stringify(["eval/scripts/phase5-pilot.mjs"]) ||
    JSON.stringify(added) !==
      JSON.stringify(["eval/scripts/restore-trial-access.ps1"])
  )
    throw Error(
      "Only the documented runner resume/owned-slot restoration correction may change",
    );
  await writeFile(
    resumeRegistrationFile,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        run_id: resumeRun,
        original_registration_sha256: sha(await readFile(registrationFile)),
        changed,
        added,
        source_hashes: hashes,
        reason:
          "Windows sandbox leaves explicit CodexSandboxUsers peer-deny ACL entries on future owned slots. Restore only those obsolete entries on the next inactive experiment slot, reapply identical host settings and recheck all isolation gates. Resume original remaining slots without repeating a completed attempt; no product/model/prompt/assessment/ranking change.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered infrastructure-only continuation; original twenty-attempt ceiling retained",
  );
  process.exit(0);
}
if (process.argv.includes("--register")) {
  await writeFile(
    registrationFile,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        policy: "eval/manifests/phase5-policy.json",
        model: MODEL,
        reasoning: EFFORT,
        assignments,
        source_hashes: hashes,
        task_families: tasks.map((task) => ({
          id: task.id,
          family: task.family,
        })),
        acceptance:
          "Complete bounded pilot and assess every eligible assignment. An ignored/error/timeout run remains an outcome. Success needs hidden regressions, no new failures on protected original selected tests, and recorded patch review. No post-outcome source/instruction tuning in this block.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log("Registered 20 sequential paired pilot assignments");
  process.exit(0);
}
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        operation: "preview",
        assignments,
        max_task_attempts: 20,
        model: MODEL,
        reasoning: EFFORT,
        note: "No tasks executed. --execute requires a fresh readiness report and matching frozen source.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const registration = await json("eval/manifests/phase5-pilot.json");
let resumeRegistration;
if (resumeRun) {
  resumeRegistration = await json("eval/manifests/phase5-resume.json");
  if (
    resumeRegistration.run_id !== resumeRun ||
    resumeRegistration.original_registration_sha256 !==
      sha(await readFile(registrationFile)) ||
    JSON.stringify(resumeRegistration.source_hashes) !== JSON.stringify(hashes)
  )
    throw Error(
      "Resume source does not match its separately frozen infrastructure correction",
    );
}
if (
  !resumeRun &&
  JSON.stringify(registration.source_hashes) !== JSON.stringify(hashes)
)
  throw Error(
    "Frozen pilot source changed; do not retune or overwrite registration",
  );
const option = process.argv.indexOf("--readiness-report"),
  readyPath = option >= 0 ? process.argv[option + 1] : null;
if (!readyPath)
  throw Error("Successful readiness report required before task execution");
const ready = JSON.parse(await readFile(resolve(readyPath), "utf8")),
  host = resolveCodex(),
  decisionTime = resumeRun
    ? Date.parse(
        (await json("eval/runs/phase5-pilot/" + resumeRun + "/decision.json"))
          .decided_at,
      )
    : Date.now(),
  age = decisionTime - Date.parse(ready.started_at);
if (
  ready.status !== "ready" ||
  !ready.static_ready ||
  !ready.model_probe?.context_delivery ||
  !ready.model_probe?.filesystem_roundtrip ||
  !ready.outside_read_denied ||
  !ready.network_denied ||
  ready.host.version !== host.version ||
  ready.runtime !== process.version ||
  ready.thread_metadata.model !== MODEL ||
  ready.thread_metadata.reasoning_effort !== EFFORT ||
  age < 0 ||
  age > 1800000
)
  throw Error("Fresh matching readiness controls required");
const ledger = join(project, "eval/runs/phase5-pilot/attempts.jsonl");
let previous = [];
try {
  previous = (await readFile(ledger, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
} catch {}
if (previous.length && !resumeRun)
  throw Error(
    "Pilot attempts already reserved; inspect/resume the existing block instead of creating another allowance",
  );
if (
  resumeRun &&
  (!previous.length ||
    previous.length >= 20 ||
    previous.some(
      (row, index) =>
        row.run_id !== resumeRun || row.slot !== assignments[index].slot,
    ))
)
  throw Error(
    "Existing ledger must be an incomplete exact prefix of the original assignments",
  );
const runId = resumeRun ?? new Date().toISOString().replace(/[:.]/g, "-"),
  output = join(project, "eval/runs/phase5-pilot", runId),
  temporary = join(trialRoot, "pilot-" + runId);
await mkdir(output, { recursive: true });
if (!resumeRun) {
  await save(join(output, "registration.json"), registration);
  await save(join(output, "readiness.json"), ready);
} else {
  if (
    sha(await readFile(join(output, "readiness.json"))) !==
    sha(await readFile(resolve(readyPath)))
  )
    throw Error("Resume must retain the original successful readiness report");
  await save(join(output, "resume-registration.json"), resumeRegistration);
}
for (const path of inputs) {
  const target = join(output, resumeRun ? "source-resume" : "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, path), target, { force: false, errorOnExist: true });
}
const rows = await Promise.all(
    previous.map((row) =>
      json("eval/runs/phase5-pilot/" + runId + "/" + row.slot + "/report.json"),
    ),
  ),
  labels = (await json("eval/labels/development-retrieval.json")).tasks;
const within = (parent, path) => {
  const rel = relative(parent, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};
async function inventory(root, prefix = "") {
  const all = {};
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (
      name === ".ctx/cache" ||
      ["node_modules", ".git"].includes(entry.name) ||
      entry.name.startsWith(".ctxgate-")
    )
      continue;
    const path = join(root, name),
      stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      all[name] = { sha256: null, unsupported: "symbolic_link" };
      continue;
    }
    if (entry.isDirectory()) Object.assign(all, await inventory(root, name));
    else if (entry.isFile()) all[name] = { sha256: sha(await readFile(path)) };
  }
  return all;
}
function assess(script, workspace, id) {
  const args = id
    ? [join(project, script), id, workspace]
    : [join(project, script), workspace];
  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error || ![0, 1].includes(child.status))
    return { unavailable: true, error: child.error?.message ?? child.stderr };
  try {
    return JSON.parse(child.stdout);
  } catch {
    return {
      unavailable: true,
      error: child.stderr || "Invalid assessment response",
    };
  }
}
// Prepare every peer root before constructing deny rules. None contains a fix/history.
for (const assignment of resumeRun ? [] : assignments) {
  const workspace = join(temporary, assignment.slot, "workspace");
  await exportTree(
    join(project, "eval/.cache/upstream/picomatch"),
    tasks.find((task) => task.id === assignment.id).base_commit,
    workspace,
  );
  initialize(workspace);
  await writeFile(join(workspace, ".ctxgate-eval-root"), "");
  await mkdir(join(workspace, "../host-state"), { recursive: true });
  await mkdir(join(workspace, "../host-logs"), { recursive: true });
}
await save(join(output, resumeRun ? "resume-decision.json" : "decision.json"), {
  decided_at: new Date().toISOString(),
  decision: "Run the registered 20-attempt development block",
  authorization: policy.authorization,
  readiness_report_sha256: sha(await readFile(resolve(readyPath))),
  host,
  model: MODEL,
  reasoning: EFFORT,
  source_hashes: hashes,
  remaining_task_attempts: 20 - previous.length,
  capability_probe_slots_consumed: 2,
  billing_cost_unavailable: true,
  loopback_reachable: ready.loopback_reachable,
});
let lastTrialWorkspace;
try {
  for (const assignment of assignments) {
    if (previous.some((row) => row.slot === assignment.slot)) continue;
    const task = tasks.find((task) => task.id === assignment.id),
      workspace = join(temporary, assignment.slot, "workspace"),
      target = join(output, assignment.slot),
      trace = join(target, "mcp.jsonl"),
      started = Date.now();
    await mkdir(target, { recursive: true });
    lastTrialWorkspace = workspace;
    if (process.platform === "win32") {
      const shell = resolve(
        dirname(process.execPath),
        "../../native/powershell/pwsh.exe",
      );
      const restored = spawnSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(project, "eval/scripts/restore-trial-access.ps1"),
          "-TrialSlot",
          dirname(workspace),
          "-EvidencePath",
          join(target, "inactive-acl-restoration-before-attempt.json"),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      if (restored.error || restored.status !== 0)
        throw Error(
          "Owned inactive-slot restoration failed: " +
            (restored.error?.message ?? restored.stderr),
        );
    }
    const original = await inventory(workspace),
      baseExisting = assess("eval/labels/picomatch-existing.cjs", workspace),
      baseFocused = assess(
        "eval/labels/picomatch-initial.cjs",
        workspace,
        task.id,
      );
    if (
      baseExisting.unavailable ||
      baseFocused.unavailable ||
      baseFocused.passed
    )
      throw Error(
        "Original task export/assessment no longer qualifies: " + task.id,
      );
    const canary = join(target, "canary.txt");
    await writeFile(canary, "assessment-only-canary");
    const audit = await openHostAudit(workspace);
    let control;
    try {
      const config = (
        await audit.request("config/read", {
          cwd: workspace,
          includeLayers: false,
        })
      ).config;
      const inside = await audit.request("command/exec", {
        command: [
          process.execPath,
          "-e",
          'process.stdout.write("WORKSPACE_OK")',
        ],
        cwd: workspace,
        permissionProfile: "ctxgate_eval",
        timeoutMs: 10000,
      });
      let denied = false;
      try {
        await audit.request("command/exec", {
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
      } catch (error) {
        denied = /EPERM|EACCES/.test(error.message);
      }
      const peer = assignments.find((row) => row.slot !== assignment.slot);
      const access = await audit.request("command/exec", {
        command: [
          process.execPath,
          "-e",
          'const f=require("node:fs");console.log(JSON.stringify(process.argv.slice(1).map(p=>{try{f.closeSync(f.openSync(p,"r"));return "OPENED"}catch(e){return e.code}})))',
          join(
            process.env.CODEX_HOME ?? join(homedir(), ".codex"),
            "config.toml",
          ),
          join(temporary, peer.slot, "workspace/index.js"),
        ],
        cwd: workspace,
        permissionProfile: "ctxgate_eval",
        timeoutMs: 10000,
      });
      const accessResults = JSON.parse(access.stdout);
      control = {
        model: config.model,
        reasoning: config.model_reasoning_effort,
        memory_injection: config.memories?.use_memories,
        memory_generation: config.memories?.generate_memories,
        protected_read_denied: denied,
        personal_state_read_denied: /^(EPERM|EACCES)$/.test(accessResults[0]),
        peer_read_denied: /^(EPERM|EACCES)$/.test(accessResults[1]),
        unrelated_integrations_disabled:
          config.features?.plugins === false &&
          config.features?.apps === false &&
          config.features?.multi_agent === false,
        inside: inside.exitCode === 0,
      };
      if (
        !denied ||
        !control.personal_state_read_denied ||
        !control.peer_read_denied ||
        !control.unrelated_integrations_disabled ||
        !control.inside ||
        control.memory_injection !== false ||
        control.memory_generation !== false ||
        control.model !== MODEL ||
        control.reasoning !== EFFORT
      )
        throw Error("Per-assignment isolation gate failed");
    } finally {
      await audit.close();
    }
    const prompt =
      task.prompt +
      "\n\nWork only in the current repository. Do not access other workspaces, parent/project/evaluation folders, upstream Git history, network or other agents. Preserve existing behavior beyond this task. Use local checks where available and report what you ran. Finish with a concise explanation." +
      (assignment.condition === "B" ? "\n\n" + instruction : "");
    const reserved = {
      ...assignment,
      run_id: runId,
      reserved_at: new Date().toISOString(),
    };
    await appendFile(ledger, JSON.stringify(reserved) + "\n");
    await save(join(target, "request.json"), {
      ...reserved,
      base_commit: task.base_commit,
      host,
      model: MODEL,
      reasoning: EFFORT,
      controls: control,
      source_hashes: hashes,
      prompt,
      arguments: execArgs(workspace, prompt, assignment.condition, trace),
      timeout_seconds: 300,
    });
    const setup_ms = Date.now() - started,
      run = await runHost(workspace, prompt, {
        condition: assignment.condition,
        trace,
      });
    await writeFile(join(target, "events.jsonl"), run.stdout);
    await writeFile(join(target, "stderr.txt"), run.stderr);
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
    const protectedTree = join(target, "protected-assessment");
    await exportTree(
      join(project, "eval/.cache/upstream/picomatch"),
      task.base_commit,
      protectedTree,
    );
    for (const change of changed) {
      if (
        change.path.startsWith(".ctx/") ||
        change.path.startsWith("test/") ||
        change.after?.unsupported
      )
        continue;
      const destination = resolve(protectedTree, change.path);
      if (!within(protectedTree, destination))
        throw Error("Unsafe assessment overlay path");
      if (!change.after) {
        await rm(destination, { force: true });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        await readFile(join(workspace, change.path)),
      );
    }
    const assessmentStart = Date.now(),
      focused = assess(
        "eval/labels/picomatch-initial.cjs",
        protectedTree,
        task.id,
      ),
      existing = assess("eval/labels/picomatch-existing.cjs", protectedTree),
      previousFailures = new Set(
        (baseExisting.failures ?? []).map((row) => row.name),
      ),
      newFailures = (existing.failures ?? []).filter(
        (row) => !previousFailures.has(row.name),
      );
    const metrics = pilotMetrics(
      run,
      telemetry,
      labels.find((label) => label.id === task.id),
    );
    const hostFailure = classifyHostFailure(run, changed, metrics);
    const infrastructure = hostFailure.status === "infrastructure_invalid";
    const status = infrastructure
      ? "infrastructure_invalid"
      : hostFailure.status === "product_failure"
        ? "product_failure"
        : run.timed_out ||
            !focused.passed ||
            newFailures.length ||
            existing.unavailable
          ? "task_failure"
          : "unassessed";
    const diffs = [];
    for (const change of changed) {
      if (change.after?.unsupported) continue;
      const originalPath = join(
        target,
        "protected-assessment-original",
        change.path,
      );
      await mkdir(dirname(originalPath), { recursive: true });
      if (change.before) {
        const blob = spawnSync(
          "git",
          [
            "-C",
            join(project, "eval/.cache/upstream/picomatch"),
            "show",
            task.base_commit + ":" + change.path,
          ],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        await writeFile(
          originalPath,
          blob.status === 0 ? blob.stdout : Buffer.alloc(0),
        );
      } else await writeFile(originalPath, "");
      const patchedPath = join(target, "patch-files", change.path);
      await mkdir(dirname(patchedPath), { recursive: true });
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
          originalPath,
          patchedPath,
        ],
        { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      diffs.push({
        path: change.path,
        patch: diff.stdout ?? "",
        diff_exit_code: diff.status,
      });
    }
    const report = {
      schema_version: 1,
      ...assignment,
      status,
      host: host.version,
      model_requested: MODEL,
      reasoning_requested: EFFORT,
      model_backend_revision: null,
      workspace,
      started_at: run.started_at,
      setup_ms,
      agent_elapsed_ms: run.elapsed_ms,
      assessment_ms: Date.now() - assessmentStart,
      end_to_end_ms: Date.now() - started,
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      spawn_error: run.spawn_error,
      invalid_json_lines: run.invalid_json_lines,
      controls: control,
      host_failure: hostFailure,
      focused_regression: focused,
      original_selected_tests: {
        base: baseExisting,
        patched: existing,
        new_failures: newFailures,
      },
      changed,
      metrics,
      patch_review: "pending",
      final_message:
        run.events
          .filter((event) => event.item?.type === "agent_message")
          .at(-1)?.item?.text ?? null,
    };
    await save(join(target, "report.json"), report);
    await save(join(target, "diffs.json"), diffs);
    rows.push(report);
    await save(join(output, "summary.json"), {
      schema_version: 1,
      run_id: runId,
      registration,
      rows,
    });
    console.log(
      JSON.stringify({
        slot: assignment.slot,
        status,
        focused: focused.passed,
        new_failures: newFailures.length,
        context_attempts: metrics.context_attempts,
        pre_edit_delivery: metrics.pre_edit_delivery,
        elapsed_ms: run.elapsed_ms,
      }),
    );
    if (hostFailure.stop_batch) {
      console.log("Stopped on host/account failure; attempts retained");
      break;
    }
  }
} finally {
  if (process.platform === "win32" && lastTrialWorkspace) {
    const cleanup = await restoreNormalWorkspaceAccess(lastTrialWorkspace);
    await save(join(output, "sandbox-cleanup-result.json"), cleanup);
    if (
      cleanup.exitCode !== 0 ||
      cleanup.stdout !== "NORMAL_WORKSPACE_ACCESS_OK"
    )
      throw Error("Sandbox cleanup requires attention; see saved result");
  }
}
await save(join(project, "eval/summaries/phase5-pilot.json"), {
  schema_version: 1,
  created_at: new Date().toISOString(),
  run_id: runId,
  registration,
  rows,
  patch_review: "pending",
  capability_probes_separate: true,
  model_calls: rows.length,
  holdout_calls: 0,
});
