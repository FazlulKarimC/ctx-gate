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
import ts from "typescript";
import { homedir } from "node:os";
import { initialize } from "../../dist/index.js";
import { verifyFreeze } from "./verify-freeze.mjs";
import { exportTree } from "./git-tree.mjs";
import {
  project,
  trialRoot,
  MODEL,
  EFFORT,
  WINDOWS_SANDBOX,
  runHost,
  openHostAudit,
} from "./phase5-host.mjs";
import { pilotMetrics } from "./pilot-metrics.mjs";
import { classifyHostFailure } from "./host-failures.mjs";
import { resolveCodex } from "./codex-command.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
import { applyPhase8HostPin } from "./phase8-host-pin.mjs";

const hostPin = await applyPhase8HostPin();

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) =>
  JSON.parse(await readFile(resolve(project, path), "utf8"));
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
};
const policy = await json("eval/manifests/phase8-policy.json"),
  pool = await json("eval/manifests/holdout-readiness.json");
if (
  policy.max_task_attempts !== 36 ||
  pool.tasks.length !== 18 ||
  pool.tasks.some((task) => !task.assessment?.ground_truth_verified) ||
  policy.model !== MODEL ||
  policy.reasoning_effort !== EFFORT
)
  throw Error("Qualified registered 18-task/36-attempt block required");
const assignments = pool.tasks.flatMap((task, index) =>
  (index % 2 ? ["B", "A"] : ["A", "B"]).map((condition) => ({
    id: task.id,
    condition,
    repetition: 1,
    slot: task.id + "-r1-" + condition,
  })),
);
const registrationPath = join(
    project,
    "eval/manifests/phase8-registration.json",
  ),
  ledger = join(project, "eval/runs/phase8/attempts.jsonl");
const sourcePaths = [
  "eval/scripts/phase8-run.mjs",
  "eval/scripts/restore-phase8-slot.ps1",
  "eval/scripts/codex-command.mjs",
  "eval/scripts/verify-freeze.mjs",
  "eval/scripts/phase5-host.mjs",
  "eval/scripts/phase8-readiness.mjs",
  "eval/scripts/phase8-readiness-core.mjs",
  "eval/scripts/phase8-cleanup.mjs",
  "eval/scripts/restore-phase8-access.ps1",
  "eval/scripts/phase8-mxc-diagnostic.mjs",
  "eval/scripts/phase8-mxc-thread-diagnostic.mjs",
  "eval/scripts/phase8-host-pin.mjs",
  "eval/manifests/phase8-host.json",
  "eval/manifests/phase8-host-runtime-package-lock.json",
  "eval/scripts/mcp-observer.mjs",
  "eval/scripts/pilot-metrics.mjs",
  "eval/scripts/host-failures.mjs",
  "eval/scripts/git-tree.mjs",
  "eval/manifests/evaluation-freeze.json",
  "eval/manifests/phase8-policy.json",
  "eval/manifests/holdout-readiness.json",
  "eval/manifests/holdout-runtime.json",
  "eval/labels/holdout-regressions.cjs",
  "eval/labels/holdout-modern.mjs",
  "eval/labels/holdout-controls.cjs",
  "eval/labels/holdout-existing.cjs",
  "docs/ctxgate-instruction.md",
];
const hashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      hash(await readFile(join(project, path))),
    ]),
  ),
);
const freeze = await json("eval/manifests/evaluation-freeze.json"),
  integrity = verifyFreeze(project, freeze);
if (!integrity.valid) throw Error("Frozen product/assessment inputs changed");
const amendmentPath = join(
  project,
  "eval/manifests/phase8-readiness-amendment.json",
);
const backendAmendmentPath = join(
  project,
  "eval/manifests/phase8-backend-amendment.json",
);
const hostAmendmentPath = join(
  project,
  "eval/manifests/phase8-host-recovery-amendment.json",
);
const fixAmendmentPath = join(
  project,
  "eval/manifests/phase8-pre-task-fix.json",
);
const capabilityReportPath =
  "eval/runs/phase8-readiness/2026-10-27T04-42-27-838Z/report.json";
if (process.argv.includes("--register-pre-task-fix")) {
  if ((await readFile(ledger, "utf8").catch(() => "")).trim())
    throw Error("Cannot amend after any task reservation");
  const parent = await json(
      "eval/manifests/phase8-host-recovery-amendment.json",
    ),
    capability = await json(capabilityReportPath);
  if (
    capability.status !== "ready" ||
    capability.registration_sha256 !==
      hash(await readFile(hostAmendmentPath)) ||
    !capability.model_probe?.context_delivery ||
    !capability.model_probe?.filesystem_roundtrip
  )
    throw Error("Unchanged successful capability evidence required");
  for (const [path, digest] of Object.entries(parent.source_hashes))
    if (
      ![
        "eval/scripts/phase8-run.mjs",
        "eval/scripts/restore-phase8-slot.ps1",
      ].includes(path) &&
      hashes[path] !== digest
    )
      throw Error("Capability contract changed: " + path);
  if (Object.keys(hashes).length !== Object.keys(parent.source_hashes).length)
    throw Error("Unexpected source inventory change");
  await writeFile(
    fixAmendmentPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        parent_host_amendment_sha256: hash(await readFile(hostAmendmentPath)),
        reason:
          "After the single successful capability probe but before any task reservation: fix a malformed regex quote and duplicated tail in restore-phase8-slot.ps1. The first preparation stopped before baseline/model work. Preserve its stop report and verify the corrected helper. Only this helper and registration loader change; every capability/product/host/MCP/task/assessment input remains byte-identical. Reuse the exact retained capability evidence, spend no new probe or task allowance.",
        capability_report: capabilityReportPath,
        capability_report_sha256: hash(
          await readFile(join(project, capabilityReportPath)),
        ),
        unchanged_capability_sources_verified: true,
        assignments,
        source_hashes: hashes,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered pre-task cleanup correction; no task/model-probe retry allowance added.",
  );
  process.exit(0);
}
if (process.argv.includes("--register-host-amendment")) {
  for (const path of [
    ledger,
    join(project, "eval/runs/phase8-readiness/model-probes.jsonl"),
  ])
    if ((await readFile(path, "utf8").catch(() => "")).trim())
      throw Error("Cannot amend after model/task reservations");
  const parent = await json("eval/manifests/phase8-backend-amendment.json");
  if (
    parent.parent_readiness_amendment_sha256 !==
      hash(await readFile(amendmentPath)) ||
    JSON.stringify(parent.assignments) !== JSON.stringify(assignments)
  )
    throw Error("Backend registration changed");
  await writeFile(
    hostAmendmentPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        parent_backend_amendment_sha256: hash(
          await readFile(backendAmendmentPath),
        ),
        reason:
          "Before any model/task reservation: pin official task-local CLI 0.163.0 and MXC identically for A/B after 0.164 alpha/stable fail internal filesystem-helper initialization and 0.163.0 passes all static controls. Automatically verify runtime bytes and the registered harness. No desktop/global configuration changes, credential copies, product/task/prompt/model/assessment changes or additional allowance.",
        host: {
          version: hostPin.version,
          windows_sandbox: hostPin.windows_sandbox,
        },
        assignments,
        source_hashes: hashes,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered pinned-host recovery before all Phase 8 model reservations.",
  );
  process.exit(0);
}
if (process.argv.includes("--register-backend-amendment")) {
  for (const path of [
    ledger,
    join(project, "eval/runs/phase8-readiness/model-probes.jsonl"),
  ]) {
    if ((await readFile(path, "utf8").catch(() => "")).trim())
      throw Error("Cannot amend after model/task reservations");
  }
  const parent = await json("eval/manifests/phase8-readiness-amendment.json");
  if (
    parent.parent_registration_sha256 !==
      hash(await readFile(registrationPath)) ||
    JSON.stringify(parent.assignments) !== JSON.stringify(assignments)
  )
    throw Error("Original registration/assignments changed");
  await writeFile(
    backendAmendmentPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        parent_readiness_amendment_sha256: hash(await readFile(amendmentPath)),
        reason:
          "Before any model/task reservation: legacy elevated sandbox setup repeatedly times out. Static MXC diagnostic passed inside writes, project/personal/peer read denials and external network denial. Select MXC identically for both arms using process-local overrides, bind readiness to this registration, and preserve earlier source snapshots. Product, task prompts, assignments, requested model, assessments and ceilings unchanged.",
        windows_sandbox: WINDOWS_SANDBOX,
        diagnostic:
          "eval/runs/phase8-mxc-diagnostic/2026-10-27T04-34-33-437Z/report.json",
        assignments,
        source_hashes: hashes,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered MXC backend amendment before model/task reservations.",
  );
  process.exit(0);
}
if (process.argv.includes("--register-amendment")) {
  const attempts = await readFile(ledger, "utf8").catch(() => "");
  if (attempts.trim()) throw Error("Cannot amend after task reservations");
  const probes = await readFile(
    join(project, "eval/runs/phase8-readiness/model-probes.jsonl"),
    "utf8",
  ).catch(() => "");
  if (probes.trim())
    throw Error("Cannot amend after a model capability reservation");
  const original = await json("eval/manifests/phase8-registration.json");
  if (JSON.stringify(original.assignments) !== JSON.stringify(assignments))
    throw Error("Task assignment changes require a new study decision");
  await writeFile(
    amendmentPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        parent_registration_sha256: hash(await readFile(registrationPath)),
        reason:
          "Before any held-out model/task reservation: select installed Node 24 for the readiness launcher, preserve failed diagnostics, add verified native cleanup after CLI cleanup timed out, and include the bounded runner helpers in its source registration. Product, prompts, assignments, model and ceilings unchanged.",
        assignments,
        source_hashes: hashes,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered readiness-only amendment; original registration and source snapshot retained.",
  );
  process.exit(0);
}
if (process.argv.includes("--register")) {
  await writeFile(
    registrationPath,
    JSON.stringify(
      {
        schema_version: 1,
        registered_at: new Date().toISOString(),
        authorization: policy.authorization,
        scope_refinement: policy.scope_refinement,
        model: MODEL,
        reasoning: EFFORT,
        assignments,
        source_hashes: hashes,
        agent_runs_allowed: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Registered the frozen 36-attempt upper ceiling; execution still requires readiness.",
  );
  process.exit(0);
}
const preview = () => {
  console.log(
    JSON.stringify(
      {
        operation: "phase8_preview",
        model: MODEL,
        assignments: assignments.length,
        source_integrity: integrity.valid,
        execution: false,
        required:
          "--register once; then --execute --readiness <fresh matching report>. No model or preparation in preview.",
      },
      null,
      2,
    ),
  );
};
let registration = await json("eval/manifests/phase8-registration.json");
try {
  const amendment = await json(
    "eval/manifests/phase8-readiness-amendment.json",
  );
  if (
    amendment.parent_registration_sha256 !==
    hash(await readFile(registrationPath))
  )
    throw Error("Amendment parent changed");
  registration = { ...registration, ...amendment };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  const amendment = await json("eval/manifests/phase8-backend-amendment.json");
  if (
    amendment.parent_readiness_amendment_sha256 !==
      hash(await readFile(amendmentPath)) ||
    amendment.windows_sandbox !== WINDOWS_SANDBOX ||
    JSON.stringify(amendment.assignments) !== JSON.stringify(assignments)
  )
    throw Error("Backend amendment parent/contract changed");
  registration = { ...registration, ...amendment };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  const amendment = await json(
    "eval/manifests/phase8-host-recovery-amendment.json",
  );
  if (
    amendment.parent_backend_amendment_sha256 !==
      hash(await readFile(backendAmendmentPath)) ||
    amendment.host.version !== hostPin.version ||
    amendment.host.windows_sandbox !== WINDOWS_SANDBOX ||
    JSON.stringify(amendment.assignments) !== JSON.stringify(assignments)
  )
    throw Error("Host recovery amendment parent/contract changed");
  registration = { ...registration, ...amendment };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let cleanupFix;
try {
  const amendment = await json("eval/manifests/phase8-pre-task-fix.json");
  if (
    amendment.parent_host_amendment_sha256 !==
      hash(await readFile(hostAmendmentPath)) ||
    amendment.capability_report_sha256 !==
      hash(await readFile(join(project, amendment.capability_report))) ||
    JSON.stringify(amendment.assignments) !== JSON.stringify(assignments)
  )
    throw Error("Pre-task correction parent/evidence changed");
  cleanupFix = amendment;
  registration = { ...registration, ...amendment };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (JSON.stringify(registration.source_hashes) !== JSON.stringify(hashes))
  throw Error("Registered harness changed; do not overwrite its registration");
if (!process.argv.includes("--execute")) {
  preview();
  process.exit(0);
}
const readyIndex = process.argv.indexOf("--readiness");
if (readyIndex < 0)
  throw Error("Matching successful readiness report required");
const ready = JSON.parse(
    await readFile(resolve(process.argv[readyIndex + 1]), "utf8"),
  ),
  host = resolveCodex(),
  age = Date.now() - Date.parse(ready.started_at);
if (
  cleanupFix &&
  hash(await readFile(resolve(process.argv[readyIndex + 1]))) !==
    cleanupFix.capability_report_sha256
)
  throw Error("Exact preserved compatible capability report required");
if (
  ready.operation !== "phase8_readiness" ||
  ready.status !== "ready" ||
  !ready.static_ready ||
  !ready.model_probe?.context_delivery ||
  !ready.model_probe?.filesystem_roundtrip ||
  !ready.outside_read_denied ||
  !ready.network_denied ||
  !ready.personal_read_denied ||
  ready.controls?.windows_sandbox !== WINDOWS_SANDBOX ||
  ready.registration_sha256 !== hash(await readFile(hostAmendmentPath)) ||
  ready.host.version !== hostPin.version ||
  ready.host.command !== hostPin.command ||
  ready.host.version !== host.version ||
  ready.runtime !== process.version ||
  age < 0 ||
  age > 1800000
)
  throw Error("Fresh exact host/isolation/MCP capability required");
let previous = [];
try {
  previous = (await readFile(ledger, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch {}
if (previous.length)
  throw Error(
    "Attempts already reserved; inspect the existing block. No implicit retries or new allowance.",
  );
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = join(project, "eval/runs/phase8", runId),
  temporary = join(trialRoot, "holdout-" + runId),
  audit = await json("eval/summaries/holdout-readiness.json");
await mkdir(output, { recursive: true });
await save(join(output, "registration.json"), registration);
await save(join(output, "readiness.json"), ready);
for (const path of sourcePaths) {
  const target = join(output, "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(project, path), target);
}
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
      failure = classifyHostFailure(run, changed, metrics);
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
      planned_attempts: 36,
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
  await save(join(project, "eval/summaries/phase8-preliminary.json"), {
    schema_version: 1,
    run_id: runId,
    created_at: new Date().toISOString(),
    planned_attempts: 36,
    reserved_attempts: reserved,
    completed_reports: rows.length,
    unassessed_reservations: reserved - rows.length,
    stop_reason: stopReason,
    patch_review_pending: true,
    rows,
  });
}
