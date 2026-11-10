import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { initialize } from "../../dist/index.js";
import { exportTree } from "./git-tree.mjs";
import { project, trialRoot } from "./phase5-host.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
import { applyTerraHostPin } from "./phase8-terra-host-bootstrap.mjs";
import {
  TERRA_ASSIGNMENTS,
  TERRA_MODEL,
  chooseTerraEffort,
} from "./phase8-terra-plan.mjs";
import {
  openTerraHostAudit,
  TERRA_PERMISSION_PROFILE,
  TERRA_SANDBOX,
} from "./phase8-terra-host.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const id = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = join(project, "eval/runs/phase8-terra-isolation", id);
const temporary = join(trialRoot, `phase8-terra-isolation-${id}`);
const modelListIndex = process.argv.indexOf("--model-list");
if (modelListIndex < 0)
  throw Error("A verified Terra model-list report is required");
const modelListPath = process.argv[modelListIndex + 1];
const modelListBytes = await readFile(modelListPath);
const modelList = JSON.parse(modelListBytes);
const terra = modelList.terra;
const effort =
  terra &&
  chooseTerraEffort({
    defaultReasoningEffort: terra.default_reasoning_effort,
    supportedReasoningEfforts: terra.supported_reasoning_efforts,
  });
if (
  modelList.operation !== "phase8_terra_model_list" ||
  modelList.status !== "ready" ||
  terra?.model !== TERRA_MODEL ||
  !effort
)
  throw Error("Current Terra model-list proof is not ready");
await applyTerraHostPin();
await mkdir(output, { recursive: true });

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

async function copyDependencies(task, workspace, readiness, runtime) {
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
    const lock = join(prepared, "node_modules/.package-lock.json");
    if (hash(await readFile(lock)) !== expected.installed_runtime_lock_sha256)
      throw Error(`Prepared runtime hash changed: ${task.id}`);
  }
  try {
    await cp(join(prepared, "node_modules"), join(workspace, "node_modules"), {
      recursive: true,
      dereference: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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

const pool = await json(join(project, "eval/manifests/holdout-readiness.json"));
const readiness = await json(
  join(project, "eval/summaries/holdout-readiness.json"),
);
const runtime = await json(
  join(project, "eval/manifests/holdout-runtime.json"),
);
const tasks = [
  ...new Map(TERRA_ASSIGNMENTS.map((row) => [row.id, row])).keys(),
].map((taskId) => {
  const task = pool.tasks.find((row) => row.id === taskId);
  if (!task) throw Error(`Missing Terra task: ${taskId}`);
  return task;
});
const report = {
  schema_version: 1,
  operation: "phase8_terra_export_isolation",
  created_at: new Date().toISOString(),
  model_calls: 0,
  model_list_report: modelListPath,
  model_list_sha256: hash(modelListBytes),
  model: TERRA_MODEL,
  reasoning_effort: effort,
  status: "infrastructure_invalid",
  tasks: [],
};
let lastAudit;
try {
  const prepared = new Map();
  for (const task of tasks) {
    const workspace = join(temporary, task.id, "workspace");
    await exportTree(
      join(project, "eval/.cache/upstream", task.repository),
      task.base_commit,
      workspace,
    );
    await copyDependencies(task, workspace, readiness, runtime);
    await initialize(workspace);
    await writeFile(join(workspace, ".ctxgate-eval-root"), "");
    await mkdir(join(workspace, "../host-state"), { recursive: true });
    await mkdir(join(workspace, "../host-logs"), { recursive: true });
    const canary = join(workspace, "input.txt");
    const nonce = randomUUID();
    await writeFile(canary, nonce);
    prepared.set(task.id, {
      workspace,
      nonce,
      exportFiles: await inventory(workspace),
    });
  }
  for (const task of tasks) {
    const { workspace, nonce, exportFiles } = prepared.get(task.id);
    const peer = tasks.find((candidate) => candidate.id !== task.id);
    const audit = await openTerraHostAudit(workspace, {
      model: TERRA_MODEL,
      effort,
      deniedPaths: [join(temporary, peer.id, "workspace")],
    });
    lastAudit = audit;
    let result;
    try {
      const config = await audit.request("config/read", {
        cwd: workspace,
        includeLayers: false,
      });
      const inside = await exec(audit, workspace, [
        process.execPath,
        "-e",
        'const f=require("node:fs");const text=f.readFileSync("input.txt","utf8");f.writeFileSync("output.txt",text);process.stdout.write(text)',
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
        join(
          process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          "config.toml",
        ),
      ]);
      const peerRead = await exec(audit, workspace, [
        process.execPath,
        "-e",
        'const f=require("node:fs");try{f.readFileSync(process.argv[1]);process.stdout.write("OPENED")}catch(error){process.stderr.write(error.code);process.exitCode=13}',
        join(temporary, peer.id, "workspace/.ctxgate-eval-root"),
      ]);
      let copied;
      let outputReadError;
      try {
        copied = await readFile(join(workspace, "output.txt"), "utf8");
      } catch (error) {
        outputReadError = error.message;
      }
      const denied = (entry) =>
        entry.exitCode !== 0 &&
        /EACCES|EPERM|access.*denied|permission/i.test(
          `${entry.stdout} ${entry.stderr}`,
        );
      result = {
        id: task.id,
        slots: TERRA_ASSIGNMENTS.filter((row) => row.id === task.id).map(
          (row) => row.slot,
        ),
        source_export_sha256: hash(JSON.stringify(exportFiles)),
        prompt_sha256: hash(task.prompt),
        files: exportFiles,
        controls: {
          model: config.config?.model,
          reasoning: config.config?.model_reasoning_effort,
          windows_sandbox: config.config?.windows?.sandbox,
          memories_disabled:
            config.config?.memories?.use_memories === false &&
            config.config?.memories?.generate_memories === false,
          integrations_disabled:
            config.config?.features?.plugins === false &&
            config.config?.features?.apps === false &&
            config.config?.features?.multi_agent === false,
          network_disabled:
            config.config?.permissions?.[TERRA_PERMISSION_PROFILE]?.network
              ?.enabled === false,
          workspace_roundtrip:
            inside.exitCode === 0 &&
            inside.stdout === nonce &&
            copied === nonce,
          evaluation_read_denied: denied(protectedRead),
          personal_read_denied: denied(personalRead),
          peer_read_denied: denied(peerRead),
        },
      };
      if (outputReadError) result.output_read_error = outputReadError;
      const controls = result.controls;
      result.ready =
        controls.model === TERRA_MODEL &&
        controls.reasoning === effort &&
        controls.windows_sandbox === TERRA_SANDBOX &&
        controls.memories_disabled &&
        controls.integrations_disabled &&
        controls.network_disabled &&
        controls.workspace_roundtrip &&
        controls.evaluation_read_denied &&
        controls.personal_read_denied &&
        controls.peer_read_denied;
    } finally {
      await audit.close();
      lastAudit = undefined;
    }
    report.tasks.push(result);
  }
  report.status = report.tasks.every((task) => task.ready)
    ? "ready"
    : "infrastructure_invalid";
} catch (error) {
  report.error = error.message;
} finally {
  await lastAudit?.close();
  try {
    report.cleanup = await restorePhase8Access(
      join(output, "permission-restoration.json"),
    );
  } catch (error) {
    report.cleanup_error = error.message;
    report.status = "infrastructure_invalid";
  }
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "ready" ? 0 : 2;
