import { spawn } from "node:child_process";
import { resolveCodex } from "./codex-command.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Infrastructure probe only: prove shell/file capability before any task runs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(
  root,
  "eval/runs/preflight",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true });
const nonce = randomUUID();
await writeFile(resolve(output, "capability-input.txt"), nonce);
const args = [
  "--no-daemon",
  "exec",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "--json",
  "--cd",
  output,
  "This is a capability check, not a repository task. Use a local shell command to read capability-input.txt and copy its exact content to capability-output.txt in this working directory. Do not access parent folders, use network, or delegate. Then return exactly CTX_GATE_PREFLIGHT_OK.",
];
const started = new Date();
let host;
try {
  host = resolveCodex();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "infrastructure_invalid",
      reason: "codex_not_found",
      error: error.message,
    }),
  );
  process.exit(2);
}
const hostVersion = host.version;
let stdout = "";
let stderr = "";
let timedOut = false;
let spawnError;
const child = spawn(host.command, args, {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data) => {
  stdout += data;
});
child.stderr.on("data", (data) => {
  stderr += data;
});
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else child.kill("SIGTERM");
}, 30_000);
child.on("error", (error) => {
  spawnError = error.message;
});
const exitCode = await new Promise((done) => child.on("close", done));
clearTimeout(timer);
const events = [];
let invalidLines = 0;
for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
  try {
    events.push(JSON.parse(line));
  } catch {
    invalidLines++;
  }
}
const completions = events.filter((event) => event.type === "turn.completed");
let roundtrip = false;
try {
  roundtrip =
    (await readFile(resolve(output, "capability-output.txt"), "utf8")) ===
    nonce;
} catch {
  /* Missing capability is failure, not readiness. */
}
const replyReceived = events.some(
  (event) =>
    event.item?.type === "agent_message" &&
    event.item.text?.trim() === "CTX_GATE_PREFLIGHT_OK",
);
const passed = !timedOut && exitCode === 0 && replyReceived && roundtrip;
const report = {
  schema_version: 1,
  operation: "host_preflight",
  started_at: started.toISOString(),
  elapsed_ms: Date.now() - started.getTime(),
  status: passed ? "ready" : "infrastructure_invalid",
  timed_out: timedOut,
  exit_code: exitCode,
  spawn_error: spawnError ?? null,
  reply_received: replyReceived,
  filesystem_roundtrip: roundtrip,
  command: host.command,
  host_version: hostVersion,
  arguments: args,
  runtime: process.version,
  config_mode: "user_config_with_workspace_sandbox",
  platform: {
    system: os.type(),
    release: os.release(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model ?? null,
    logical_cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
  },
  event_types: [...new Set(events.map((event) => event.type))],
  invalid_json_lines: invalidLines,
  usage: completions.at(-1)?.usage ?? null,
  errors: events.filter(
    (event) => event.type === "error" || event.type === "turn.failed",
  ),
  assessment:
    "Requires a real filesystem roundtrip. A text-only reply does not establish readiness. Infrastructure only, not a task-performance measurement.",
};
await Promise.all([
  writeFile(resolve(output, "events.jsonl"), stdout),
  writeFile(resolve(output, "stderr.txt"), stderr),
  writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  ),
]);
console.log(
  JSON.stringify({ ...report, arguments: undefined, output }, null, 2),
);
process.exitCode = passed ? 0 : 2;
