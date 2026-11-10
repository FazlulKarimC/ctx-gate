import { spawn } from "node:child_process";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { resolveCodex } from "./codex-command.mjs";
import { isAccountLimit } from "./host-failures.mjs";

export const project = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const MODEL = "gemini-flash-3.8",
  EFFORT = "low";
export const WINDOWS_SANDBOX = "mxc";
export const trialRoot = join(tmpdir(), "ctxgate-phase5-trials");
const within = (parent, path) => {
  const part = relative(parent, path);
  return !part.startsWith("..") && !isAbsolute(part);
};
export function protectedPaths(workspace) {
  if (!within(trialRoot, workspace) || within(project, workspace))
    throw Error(
      "Trial workspaces must be isolated under the named temporary trial directory, outside the project",
    );
  const denied = [
    project,
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    join(dirname(workspace), "host-state"),
    join(dirname(workspace), "host-logs"),
  ];
  let directory = trialRoot;
  while (directory !== workspace) {
    if (!existsSync(directory)) break;
    let next;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (within(path, workspace)) next = path;
      else denied.push(path);
    }
    if (!next) throw Error("Workspace missing from protected trial inventory");
    directory = next;
  }
  return [...new Set(denied)];
}
export function overrides(workspace, condition = "A", trace, denied = []) {
  const settings = {
    model: MODEL,
    model_reasoning_effort: EFFORT,
    approval_policy: "never",
    default_permissions: "ctxgate_eval",
    web_search: "disabled",
    sqlite_home: join(dirname(workspace), "host-state"),
    log_dir: join(dirname(workspace), "host-logs"),
    "windows.sandbox": WINDOWS_SANDBOX,
    "memories.use_memories": false,
    "memories.generate_memories": false,
    "features.memories": false,
    "features.plugins": false,
    "features.apps": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.workspace_dependencies": false,
    "features.browser_use": false,
    "features.computer_use": false,
    "features.image_generation": false,
    project_root_markers: [".ctxgate-eval-root"],
    "permissions.ctxgate_eval.network.enabled": false,
  };
  const entries = Object.entries(settings).flatMap(([key, value]) => [
    "-c",
    key + "=" + JSON.stringify(value),
  ]);
  const fs = `{":root"="read",":workspace_roots"="write",${[...protectedPaths(workspace), ...denied].map((path) => JSON.stringify(path) + '="deny"').join(",")}}`;
  entries.push("-c", "permissions.ctxgate_eval.filesystem=" + fs);
  entries.push(
    "-c",
    `permissions.ctxgate_eval.workspace_roots={${JSON.stringify(workspace)}=true}`,
  );
  // A disabled entry still needs a valid transport under --ignore-user-config.
  entries.push(
    "-c",
    `mcp_servers.node_repl={command=${JSON.stringify(process.execPath)},args=["--version"],enabled=false}`,
  );
  if (condition === "B") {
    if (!trace) throw Error("Treatment trace path required");
    entries.push(
      "-c",
      `mcp_servers.ctxgate={command=${JSON.stringify(process.execPath)},args=[${[join(project, "eval/scripts/mcp-observer.mjs"), workspace, trace].map(JSON.stringify).join(",")}],enabled=true,required=true,enabled_tools=["ctx_context","ctx_expand"],startup_timeout_sec=20,tool_timeout_sec=30}`,
    );
  }
  return entries;
}
export function execArgs(workspace, prompt, condition = "A", trace) {
  return [
    "--no-daemon",
    "exec",
    "--ignore-user-config",
    "--strict-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--cd",
    workspace,
    ...overrides(workspace, condition, trace),
    prompt,
  ];
}
export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const fallback = setTimeout(() => child.kill("SIGTERM"), 1000);
    fallback.unref();
    const termination = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    termination.once("error", () => child.kill("SIGTERM"));
    termination.once("close", (code) => {
      if (code !== 0) child.kill("SIGTERM");
      else clearTimeout(fallback);
    });
    child.once("close", () => clearTimeout(fallback));
  } else child.kill("SIGTERM");
}
export async function runHost(
  workspace,
  prompt,
  { condition = "A", trace, timeout_ms = 300000 } = {},
) {
  const host = resolveCodex(),
    args = execArgs(workspace, prompt, condition, trace);
  return {
    host,
    args,
    ...(await runProcess(host.command, args, { cwd: workspace, timeout_ms })),
  };
}
export async function runProcess(command, args, { cwd, timeout_ms = 300000 }) {
  const start = Date.now();
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    timed_out = false,
    spawn_error = null,
    account_limit_detected = false;
  const stopForLimit = () => {
    if (!account_limit_detected) {
      account_limit_detected = true;
      killTree(child);
    }
  };
  const timeline = [];
  let invalid_json_lines = 0;
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      timeline.push({
        received_at: new Date().toISOString(),
        event,
      });
      if (
        ["error", "turn.failed"].includes(event.type) &&
        isAccountLimit(JSON.stringify(event))
      )
        stopForLimit();
    } catch {
      invalid_json_lines++;
    }
  });
  child.stdout.on("data", (data) => {
    stdout += data;
    if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) killTree(child);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    if (isAccountLimit(stderr)) stopForLimit();
    if (Buffer.byteLength(stderr) > 4 * 1024 * 1024) killTree(child);
  });
  child.on("error", (error) => {
    spawn_error = error.message;
  });
  const timer = setTimeout(() => {
    timed_out = true;
    killTree(child);
  }, timeout_ms);
  const exit_code = await new Promise((done) => child.once("close", done));
  clearTimeout(timer);
  reader.close();
  const events = timeline.map((row) => row.event);
  return {
    stdout,
    stderr,
    events,
    timeline,
    started_at: new Date(start).toISOString(),
    exit_code,
    timed_out,
    spawn_error,
    account_limit_detected,
    invalid_json_lines,
    elapsed_ms: Date.now() - start,
  };
}

/** Local app-server RPC is used for configuration/sandbox checks without model turns. */
export async function restoreNormalWorkspaceAccess(trialWorkspace) {
  const audit = await openHostAudit(trialWorkspace);
  try {
    return await audit.request("command/exec", {
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("NORMAL_WORKSPACE_ACCESS_OK")',
      ],
      cwd: project,
      permissionProfile: ":workspace",
      timeoutMs: 10000,
    });
  } finally {
    await audit.close();
  }
}
export async function openHostAudit(workspace) {
  const host = resolveCodex(),
    child = spawn(
      host.command,
      [
        "--no-daemon",
        "app-server",
        "--stdio",
        "--strict-config",
        ...overrides(workspace),
      ],
      { cwd: workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  const pending = new Map();
  let next = 1,
    stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const reader = createInterface({ input: child.stdout });
  const fail = (error) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("close", () =>
    fail(Error("Host audit exited: " + stderr.slice(-1500))),
  );
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(Error(JSON.stringify(message.error)));
        else call.resolve(message.result);
      } else if (message.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: "No interactive approvals in audit",
            },
          }) + "\n",
        );
      }
    } catch {
      /* Preserve bounded stderr on failure. */
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error("Host audit timeout: " + method + " " + stderr.slice(-1000)),
        );
      }, 20000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const closed = new Promise((done) => child.once("close", done));
  try {
    await request("initialize", {
      clientInfo: { name: "ctxgate-readiness", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  } catch (error) {
    killTree(child);
    throw error;
  }
  return {
    request,
    host,
    close: async () => {
      child.stdin.end();
      const timer = setTimeout(() => killTree(child), 2000);
      await closed;
      clearTimeout(timer);
      reader.close();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(Error("Audit closed"));
      }
      pending.clear();
    },
  };
}
