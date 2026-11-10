import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  project,
  trialRoot,
  overrides,
  MODEL,
  killTree,
} from "./phase5-host.mjs";
import { resolveCodex } from "./codex-command.mjs";

// No turn/start or model invocation. Test the explicitly reported missing OS variable.
const id = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  workspace = join(trialRoot, "phase8-mxc-thread-" + id, "workspace"),
  output = join(project, "eval/runs/phase8-mxc-thread-diagnostic", id);
await mkdir(workspace, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(workspace, ".ctxgate-eval-root"), "");
const host = resolveCodex(),
  args = [
    "--no-daemon",
    "app-server",
    "--stdio",
    ...overrides(workspace),
    "-c",
    "shell_environment_policy.set.SYSTEMROOT=" +
      JSON.stringify(process.env.SystemRoot),
  ];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() !== "SYSTEMROOT",
  ),
);
env.SYSTEMROOT = process.env.SystemRoot;
const child = spawn(host.command, args, {
  cwd: workspace,
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "",
  next = 1;
child.stderr.on("data", (data) => {
  stderr += data;
});
const pending = new Map();
const reader = createInterface({ input: child.stdout });
reader.on("line", (line) => {
  try {
    const value = JSON.parse(line),
      call = pending.get(value.id);
    if (call) {
      pending.delete(value.id);
      clearTimeout(call.timer);
      value.error
        ? call.reject(Error(JSON.stringify(value.error)))
        : call.resolve(value.result);
    }
  } catch {}
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const callId = next++;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(Error("Timeout: " + method));
    }, 20000);
    pending.set(callId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: callId, method, params }) + "\n");
  });
const report = {
  schema_version: 1,
  operation: "phase8_mxc_thread_static_diagnostic",
  started_at: new Date().toISOString(),
  host,
  workspace,
  model_calls: 0,
  changes: [
    "uppercase process SYSTEMROOT key",
    "shell_environment_policy.set.SYSTEMROOT",
  ],
};
try {
  await request("initialize", {
    clientInfo: { name: "ctxgate-static", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const result = await request("thread/start", {
    cwd: workspace,
    permissions: "ctxgate_eval",
    ephemeral: true,
    model: MODEL,
    allowProviderModelFallback: false,
  });
  report.thread = {
    model: result.model,
    reasoning: result.reasoningEffort,
    permission: result.activePermissionProfile,
  };
  report.ready = true;
} catch (error) {
  report.ready = false;
  report.error = error.message;
} finally {
  const closed = new Promise((done) => child.once("close", done));
  child.stdin.end();
  const timer = setTimeout(() => killTree(child), 2000);
  await closed;
  clearTimeout(timer);
  reader.close();
}
report.stderr = stderr;
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 2;
