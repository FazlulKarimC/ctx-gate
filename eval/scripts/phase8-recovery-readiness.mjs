import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { project } from "./phase5-host.mjs";
import { applyPhase8HostPin } from "./phase8-host-pin.mjs";

await applyPhase8HostPin();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  id = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = join(project, "eval/runs/phase8-recovery-readiness", id),
  report = {
    schema_version: 1,
    operation: "phase8_recovery_readiness",
    created_at: new Date().toISOString(),
    runtime: process.version,
    model_calls: 0,
    output,
    status: "infrastructure_invalid",
  };
await mkdir(output, { recursive: true });
let client;
try {
  const preview = spawnSync(
    process.execPath,
    [join(project, "eval/scripts/phase8-recovery-run.mjs")],
    { cwd: project, encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  if (preview.status !== 0)
    throw Error("Recovery registration mismatch: " + preview.stderr);
  const policy = JSON.parse(
      await readFile(
        join(project, "eval/manifests/phase8-recovery-policy.json"),
        "utf8",
      ),
    ),
    priorBytes = await readFile(join(project, policy.prior_capability_report)),
    prior = JSON.parse(priorBytes);
  if (
    hash(priorBytes) !== policy.prior_capability_sha256 ||
    prior.status !== "ready" ||
    !prior.model_probe?.context_delivery ||
    !prior.model_probe?.filesystem_roundtrip
  )
    throw Error("Exact original successful model capability proof required");
  report.prior_capability_sha256 = hash(priorBytes);
  report.registration_sha256 = hash(
    await readFile(
      join(project, "eval/manifests/phase8-recovery-registration.json"),
    ),
  );
  const gate = spawnSync(
    process.execPath,
    [join(project, "eval/scripts/phase8-readiness.mjs")],
    {
      cwd: project,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  await writeFile(join(output, "static.stdout.json"), gate.stdout ?? "");
  await writeFile(join(output, "static.stderr.txt"), gate.stderr ?? "");
  const checked = JSON.parse(gate.stdout);
  if (
    gate.status !== 0 ||
    checked.status !== "static_ready" ||
    !checked.static_ready ||
    !checked.outside_read_denied ||
    !checked.personal_read_denied ||
    !checked.network_denied ||
    checked.host.version !== prior.host.version ||
    checked.host.command !== prior.host.command ||
    checked.controls.windows_sandbox !== "mxc" ||
    !checked.cleanup?.verified
  )
    throw Error("Fresh static gate failed");
  report.static_ready = true;
  report.host = checked.host;
  report.static_report = checked.output + "/report.json";
  report.cleanup_verified = checked.cleanup.verified;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(project, "eval/scripts/mcp-observer.mjs"),
      checked.workspace,
      join(output, "mcp.jsonl"),
    ],
    stderr: "pipe",
  });
  client = new Client({ name: "ctxgate-recovery-static", version: "0.1.0" });
  await client.connect(transport);
  const tools = await client.listTools(),
    result = await client.callTool({
      name: "ctx_context",
      arguments: {
        query: "symbol:readSession",
        encoding: "o200k_base",
        budget_tokens: 2000,
        neighbors: false,
        notes: false,
      },
    });
  await writeFile(
    join(output, "mcp-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  const payload = JSON.parse(
    result.content.find((part) => part.type === "text").text,
  );
  report.direct_mcp = {
    tools: tools.tools.map((tool) => tool.name),
    context_delivery:
      !result.isError && payload.status === "ok" && payload.items.length > 0,
    budget: payload.budget,
    fixture_only: true,
  };
  report.status = report.direct_mcp.context_delivery
    ? "ready"
    : "infrastructure_invalid";
} catch (error) {
  report.error = error.message;
} finally {
  await client?.close();
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "ready" ? 0 : 2;
