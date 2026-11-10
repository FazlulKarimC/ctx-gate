import { mkdir, writeFile, readFile, cp, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import {
  openHostAudit,
  runHost,
  project,
  trialRoot,
  MODEL,
  EFFORT,
} from "./phase5-host.mjs";
import { initialize } from "../../dist/index.js";

const runId = new Date().toISOString().replace(/[:.]/g, "-"),
  output = join(project, "eval/runs/host-readiness", runId),
  workspace = join(trialRoot, "readiness-" + runId, "workspace"),
  nonce = randomUUID();
await mkdir(output, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(join(workspace, "../host-state"), { recursive: true });
await mkdir(join(workspace, "../host-logs"), { recursive: true });
await cp(join(project, "tests/fixtures/basic-project"), workspace, {
  recursive: true,
  filter: (path) => !path.includes("/cache/") && !path.includes("\\cache\\"),
});
initialize(workspace);
await writeFile(join(workspace, ".ctxgate-eval-root"), "");
await writeFile(join(workspace, "input.txt"), nonce);
await writeFile(join(output, "outside-canary.txt"), randomUUID());
const report = {
  schema_version: 1,
  operation: "phase5_readiness",
  started_at: new Date().toISOString(),
  runtime: process.version,
  model_request: MODEL,
  reasoning_request: EFFORT,
  status: "infrastructure_invalid",
  static_ready: false,
  model_probe_requested: process.argv.includes("--model-probe"),
  workspace,
  output,
};
let audit, networkServer;
try {
  audit = await openHostAudit(workspace);
  report.host = audit.host;
  const loaded = await audit.request("config/read", {
      cwd: workspace,
      includeLayers: false,
    }),
    config = loaded.config;
  report.controls = {
    model: config.model,
    reasoning: config.model_reasoning_effort,
    memories: config.memories,
    features: config.features,
    default_permissions: config.default_permissions,
    permissions: config.permissions,
    approval_policy: config.approval_policy,
    web_search: config.web_search,
  };
  report.permission_profiles = await audit.request("permissionProfile/list", {
    cwd: workspace,
  });
  const exec = async (command) => {
    try {
      return await audit.request("command/exec", {
        command,
        cwd: workspace,
        permissionProfile: "ctxgate_eval",
        timeoutMs: 10000,
      });
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        rpc_error: true,
      };
    }
  };
  report.inside = await exec([
    process.execPath,
    "-e",
    'const f=require("node:fs");const s=f.readFileSync("input.txt","utf8");f.writeFileSync("output.txt",s);process.stdout.write(s)',
  ]);
  report.outside = await exec([
    process.execPath,
    "-e",
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))',
    join(output, "outside-canary.txt"),
  ]);
  report.filesystem_roundtrip =
    (await readFile(join(workspace, "output.txt"), "utf8")) === nonce;
  report.outside_read_denied =
    report.outside.exitCode !== 0 &&
    /EACCES|EPERM|access.*denied|permission/i.test(report.outside.stderr ?? "");
  networkServer = createServer((socket) =>
    socket.end("CTXGATE_NETWORK_CANARY"),
  );
  await new Promise((done) => networkServer.listen(0, "127.0.0.1", done));
  const port = networkServer.address().port;
  report.network = await exec([
    process.execPath,
    "-e",
    'const n=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");n.on("data",d=>{process.stdout.write(d);n.end()});n.on("error",e=>{console.log("DENIED:"+e.code)});setTimeout(()=>{n.destroy();console.log("TIMEOUT")},2000).unref()',
    String(port),
  ]);
  report.loopback_reachable = (report.network.stdout ?? "").includes(
    "CTXGATE_NETWORK_CANARY",
  );
  report.external_network_control = await new Promise((done) => {
    const socket = connect(443, "1.1.1.1");
    socket.once("connect", () => {
      socket.destroy();
      done({ reachable: true });
    });
    socket.once("error", (error) =>
      done({ reachable: false, code: error.code }),
    );
    socket.setTimeout(3000, () => {
      socket.destroy();
      done({ reachable: false, code: "timeout" });
    });
  });
  report.external_network = await exec([
    process.execPath,
    "-e",
    'const n=require("node:net").connect(443,"1.1.1.1");n.on("connect",()=>{console.log("REACHABLE");n.destroy()});n.on("error",e=>console.log("DENIED:"+e.code));n.setTimeout(3000,()=>{n.destroy();console.log("TIMEOUT")})',
  ]);
  report.network_denied =
    report.external_network_control.reachable &&
    /DENIED:(?:EACCES|EPERM)|EACCES|EPERM/.test(
      (report.external_network.stdout ?? "") +
        " " +
        (report.external_network.stderr ?? ""),
    );
  const thread = await audit.request("thread/start", {
    cwd: workspace,
    permissions: "ctxgate_eval",
    ephemeral: true,
    model: MODEL,
    allowProviderModelFallback: false,
  });
  report.thread_metadata = {
    model: thread.model,
    reasoning_effort: thread.reasoningEffort,
    permission_profile: thread.activePermissionProfile,
    sandbox: thread.sandbox,
  };
  report.static_ready =
    report.filesystem_roundtrip &&
    report.outside_read_denied &&
    report.network_denied &&
    thread.model === MODEL &&
    config.memories?.use_memories === false &&
    config.memories?.generate_memories === false &&
    config.features?.memories === false &&
    config.features?.plugins === false &&
    config.features?.apps === false;
  report.status = report.static_ready
    ? "static_ready"
    : "infrastructure_invalid";
  await audit.close();
  audit = undefined;
  const priorIndex = process.argv.indexOf("--prior-model-report");
  if (report.static_ready && priorIndex >= 0) {
    const priorPath = resolve(process.argv[priorIndex + 1] ?? ""),
      prior = JSON.parse(await readFile(priorPath, "utf8"));
    if (
      prior.status !== "ready" ||
      prior.host?.version !== report.host.version ||
      prior.runtime !== process.version ||
      !prior.model_probe?.context_delivery ||
      !prior.model_probe?.filesystem_roundtrip ||
      prior.thread_metadata?.model !== MODEL ||
      prior.thread_metadata?.reasoning_effort !== EFFORT
    )
      throw Error(
        "Prior model capability evidence does not match the unchanged host/model contract",
      );
    report.model_probe = prior.model_probe;
    report.model_probe_reused = {
      path: priorPath,
      sha256: createHash("sha256")
        .update(await readFile(priorPath))
        .digest("hex"),
      original_started_at: prior.started_at,
      reason:
        "Fresh static verification after adding command-side denial of personal Codex state; MCP adapter/model contract unchanged. No additional model call.",
    };
    report.status = "ready";
  }
  if (report.static_ready && report.model_probe_requested) {
    const ledger = join(project, "eval/runs/host-readiness/model-probes.jsonl");
    let used = [];
    try {
      used = (await readFile(ledger, "utf8")).split(/\r?\n/).filter(Boolean);
    } catch {}
    if (used.length >= 2)
      throw Error(
        "Both registered model capability probes are consumed; inspect preserved reports before another authorization",
      );
    await appendFile(
      ledger,
      JSON.stringify({
        run_id: runId,
        reserved_at: new Date().toISOString(),
        purpose: "phase5_capability_probe",
        policy: "eval/manifests/phase5-policy.json",
      }) + "\n",
    );
    const trace = join(output, "mcp.jsonl"),
      prompt = `This is an infrastructure check, not a repository repair. First call ctx_context with query symbol:readSession, encoding o200k_base, budget_tokens 2000. Then use a local shell command to read input.txt and copy its exact bytes to model-output.txt. Attempt to read the outside-canary.txt at ${join(output, "outside-canary.txt")} using a local command; access must be denied. Do not delegate, use network or read other paths. Return exactly CTXGATE_HOST_READY.`;
    const run = await runHost(workspace, prompt, {
      condition: "B",
      trace,
      timeout_ms: 90000,
    });
    await writeFile(join(output, "events.jsonl"), run.stdout);
    await writeFile(join(output, "stderr.txt"), run.stderr);
    let telemetry = [];
    try {
      telemetry = (await readFile(trace, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
    } catch {}
    let copied = false;
    try {
      copied =
        (await readFile(join(workspace, "model-output.txt"), "utf8")) === nonce;
    } catch {}
    report.model_probe = {
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      elapsed_ms: run.elapsed_ms,
      filesystem_roundtrip: copied,
      context_delivery: telemetry.some(
        (event) =>
          event.operation === "context" &&
          event.success &&
          event.references?.length > 0,
      ),
      event_types: [...new Set(run.events.map((event) => event.type))],
      usage:
        run.events.findLast((event) => event.type === "turn.completed")
          ?.usage ?? null,
      errors: run.events.filter((event) =>
        ["error", "turn.failed"].includes(event.type),
      ),
    };
    report.status =
      run.exit_code === 0 &&
      !run.timed_out &&
      copied &&
      report.model_probe.context_delivery
        ? "ready"
        : "infrastructure_invalid";
  }
} catch (error) {
  report.error = error.message;
} finally {
  await audit?.close();
  if (networkServer) await new Promise((done) => networkServer.close(done));
}
report.elapsed_ms = Date.now() - Date.parse(report.started_at);
report.controls_sha256 = report.controls
  ? createHash("sha256").update(JSON.stringify(report.controls)).digest("hex")
  : null;
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = ["ready", "static_ready"].includes(report.status) ? 0 : 2;
