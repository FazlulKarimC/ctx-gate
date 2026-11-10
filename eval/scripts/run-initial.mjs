import { spawn, spawnSync } from "node:child_process";
import { resolveCodex } from "./codex-command.mjs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { exportTree } from "./git-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = JSON.parse(
  await readFile(resolve(root, "eval/manifests/corpus.json"), "utf8"),
);
const tasks = corpus.tasks.filter((task) =>
  /^picomatch-d0[1-5]$/.test(task.id),
);
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        action: "preview",
        tasks: tasks.map((task) => task.id),
        max_attempts: 5,
        timeout_seconds_per_attempt: 300,
        note: "Pass --execute to run the registered initial host-only baseline.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (
  tasks.length !== 5 ||
  tasks.some((task) => task.qualification !== "behavioral_regression_verified")
)
  throw new Error("Initial task regressions must qualify first");
const preflightOption = process.argv.indexOf("--preflight-report");
const preflightPath =
  preflightOption >= 0 ? process.argv[preflightOption + 1] : undefined;
if (!preflightPath)
  throw new Error(
    "Supply --preflight-report <report.json> from a successful filesystem capability probe. Reply-only probes do not qualify.",
  );
const preflight = JSON.parse(await readFile(resolve(preflightPath), "utf8"));
const host = resolveCodex();
const hostVersion = host.version;
const preflightAge = Date.now() - Date.parse(preflight.started_at);
if (
  preflight.status !== "ready" ||
  preflight.config_mode !== "user_config_with_workspace_sandbox" ||
  preflight.filesystem_roundtrip !== true ||
  preflight.runtime !== process.version ||
  preflight.host_version !== hostVersion ||
  !Number.isFinite(preflightAge) ||
  preflightAge < 0 ||
  preflightAge > 30 * 60_000
)
  throw new Error(
    "A fresh, matching host/runtime filesystem capability probe is required.",
  );
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = resolve(root, "eval/runs/initial-baseline", runId);
await mkdir(runRoot, { recursive: true });
const reports = [];

async function manifest(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".cache"].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(result, await manifest(join(directory, entry.name), rel));
    else if (entry.isFile())
      result[rel] = createHash("sha256")
        .update(await readFile(join(directory, entry.name)))
        .digest("hex");
  }
  return result;
}
for (const task of tasks) {
  const workspace = resolve(root, "eval/.cache/workspaces", runId, task.id);
  const output = resolve(runRoot, task.id);
  await mkdir(output, { recursive: true });
  await exportTree(
    resolve(root, "eval/.cache/upstream", task.repository),
    task.base_commit,
    workspace,
  );
  const before = await manifest(workspace);
  const prompt = `${task.prompt}\n\nWork only in the current repository. Do not read parent folders, other workspaces, evaluation files, or upstream Git history. Do not delegate to other agents. Do not use network search or download dependencies. Preserve existing behavior beyond this task. You may use local Node.js for focused checks; report which checks you ran. Finish with a concise explanation of the change.`;
  const args = [
    "--no-daemon",
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    "--cd",
    workspace,
    prompt,
  ];
  await writeFile(
    resolve(output, "request.json"),
    JSON.stringify(
      {
        task_id: task.id,
        base_commit: task.base_commit,
        condition: "A",
        host: hostVersion,
        model_request: "gemini-flash-3.8",
        reasoning_request: "low",
        config_mode: "user_config_with_workspace_sandbox",
        protocol_block: "2026-10-26-infrastructure-recovery-retry-1",
        model_resolved: null,
        runtime: process.version,
        timeout_seconds: 300,
        prompt,
      },
      null,
      2,
    ) + "\n",
  );
  const started = Date.now();
  const child = spawn(host.command, args, {
    cwd: workspace,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let errorMessage;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.on("error", (error) => {
    errorMessage = error.message;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid)
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else child.kill("SIGTERM");
  }, 300_000);
  const exitCode = await new Promise((done) => child.on("close", done));
  clearTimeout(timer);
  const events = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* Preserved in raw output; reported below. */
    }
  }
  const usage =
    events.filter((event) => event.type === "turn.completed").at(-1)?.usage ??
    null;
  const assessmentProcess = spawnSync(
    process.execPath,
    [resolve(root, "eval/labels/picomatch-initial.cjs"), task.id, workspace],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  let assessment = null;
  try {
    assessment = JSON.parse(assessmentProcess.stdout);
  } catch {
    /* Failed assessment is not a successful task. */
  }
  const after = await manifest(workspace);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = paths
    .filter((path) => before[path] !== after[path])
    .map((path) => ({
      path,
      before: before[path] ?? null,
      after: after[path] ?? null,
    }));
  const hasTurn = events.some((event) => event.type === "turn.started");
  const completed = events.some((event) => event.type === "turn.completed");
  const toolsBlocked =
    !changes.length &&
    /rejected: blocked by policy|in-process app-server client: Access is denied/i.test(
      stderr,
    );
  const status =
    !hasTurn || toolsBlocked || (!completed && !timedOut && !changes.length)
      ? "infrastructure_invalid"
      : "unassessed";
  const report = {
    schema_version: 1,
    task_id: task.id,
    condition: "A",
    status,
    elapsed_ms: Date.now() - started,
    exit_code: exitCode,
    timed_out: timedOut,
    spawn_error: errorMessage ?? null,
    usage,
    infrastructure_reason: toolsBlocked ? "host_tool_execution_blocked" : null,
    tool_commands: events.filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "command_execution",
    ).length,
    regression_assessment: assessment,
    assessment_exit_code: assessmentProcess.status,
    patch_review: "pending",
    model_resolved: null,
    memory_isolation:
      "User configuration retained for Windows sandbox/trust; memory/tool settings require verification before a controlled comparison",
    changes,
    final_message:
      events.filter((event) => event.item?.type === "agent_message").at(-1)
        ?.item.text ?? null,
    errors: events.filter((event) =>
      ["error", "turn.failed"].includes(event.type),
    ),
  };
  reports.push(report);
  await Promise.all([
    writeFile(resolve(output, "events.jsonl"), stdout),
    writeFile(resolve(output, "stderr.txt"), stderr),
    writeFile(
      resolve(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    ),
  ]);
  await writeFile(
    resolve(runRoot, "summary.json"),
    JSON.stringify({ run_id: runId, reports }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      task: task.id,
      status,
      regression_passed: assessment?.passed ?? null,
      elapsed_ms: report.elapsed_ms,
      commands: report.tool_commands,
      usage,
    }),
  );
  if (status === "infrastructure_invalid") {
    console.log(
      "Stopped after infrastructure failure; no repeated task attempts.",
    );
    break;
  }
}
console.log(
  JSON.stringify({
    run_root: runRoot,
    attempts: reports.length,
    note: "Regression outcomes require patch review. Model identity/memory controls remain unverified; this is an instrumentation baseline, not a causal study.",
  }),
);
