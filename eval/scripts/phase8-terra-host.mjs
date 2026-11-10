import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { project, protectedPaths, killTree } from "./phase5-host.mjs";
import { resolveCodex } from "./codex-command.mjs";

export const TERRA_PERMISSION_PROFILE = "ctxgate_terra_eval";
export const TERRA_SANDBOX = "mxc";

export function terraOverrides(
  workspace,
  { model, effort, condition = "A", trace, deniedPaths = [] } = {},
) {
  const settings = {
    approval_policy: "never",
    default_permissions: TERRA_PERMISSION_PROFILE,
    web_search: "disabled",
    sqlite_home: join(workspace, "../host-state"),
    log_dir: join(workspace, "../host-logs"),
    "windows.sandbox": TERRA_SANDBOX,
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
    [`permissions.${TERRA_PERMISSION_PROFILE}.network.enabled`]: false,
  };
  if (model) settings.model = model;
  if (effort) settings.model_reasoning_effort = effort;
  const entries = Object.entries(settings).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
  const denied = [
    ...protectedPaths(workspace),
    join(dirname(workspace), "protected-assessment"),
    ...deniedPaths,
  ];
  const fs = `{":root"="read",":workspace_roots"="write",${[...new Set(denied)].map((path) => `${JSON.stringify(path)}="deny"`).join(",")}}`;
  entries.push(
    "-c",
    `permissions.${TERRA_PERMISSION_PROFILE}.filesystem=${fs}`,
  );
  entries.push(
    "-c",
    `permissions.${TERRA_PERMISSION_PROFILE}.workspace_roots={${JSON.stringify(workspace)}=true}`,
  );
  entries.push(
    "-c",
    `mcp_servers.node_repl={command=${JSON.stringify(process.execPath)},args=["--version"],enabled=false}`,
  );
  if (condition === "B") {
    if (!trace) throw Error("Treatment B requires an MCP trace path");
    entries.push(
      "-c",
      `mcp_servers.ctxgate={command=${JSON.stringify(process.execPath)},args=[${[
        join(project, "eval/scripts/mcp-observer.mjs"),
        workspace,
        trace,
      ]
        .map(JSON.stringify)
        .join(
          ",",
        )}],enabled=true,required=true,enabled_tools=["ctx_context","ctx_expand"],startup_timeout_sec=20,tool_timeout_sec=30}`,
    );
  }
  return entries;
}

export function terraExecArgs(workspace, prompt, options = {}) {
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
    ...terraOverrides(workspace, options),
    prompt,
  ];
}

export async function openTerraHostAudit(workspace, options = {}) {
  const host = resolveCodex();
  const child = spawn(
    host.command,
    [
      "--no-daemon",
      "app-server",
      "--stdio",
      "--strict-config",
      ...terraOverrides(workspace, options),
    ],
    { cwd: workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  let next = 1;
  let stderr = "";
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
    fail(Error(`Terra host audit exited: ${stderr.slice(-1500)}`)),
  );
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(call.timer);
        message.error
          ? call.reject(Error(JSON.stringify(message.error)))
          : call.resolve(message.result);
      } else if (message.id !== undefined) {
        child.stdin.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601, message: "No interactive approvals in Terra audit" } })}\n`,
        );
      }
    } catch {
      // Keep the bounded stderr tail for failure diagnostics.
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error(`Terra host audit timeout: ${method} ${stderr.slice(-1000)}`),
        );
      }, 20_000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const closed = new Promise((done) => child.once("close", done));
  try {
    await request("initialize", {
      clientInfo: { name: "ctxgate-terra-readiness", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  } catch (error) {
    killTree(child);
    throw error;
  }
  return {
    host,
    request,
    close: async () => {
      child.stdin.end();
      const timer = setTimeout(() => killTree(child), 2_000);
      await closed;
      clearTimeout(timer);
      reader.close();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(Error("Terra audit closed"));
      }
      pending.clear();
    },
  };
}
