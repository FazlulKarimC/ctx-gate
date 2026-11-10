import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { project, trialRoot, overrides, runProcess } from "./phase5-host.mjs";
import { resolveCodex } from "./codex-command.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";

// Static-only backend diagnostic. No model, saved config or sandbox installation.
const id = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  workspace = join(trialRoot, "phase8-mxc-" + id, "workspace"),
  peer = join(dirname(workspace), "peer"),
  output = join(project, "eval/runs/phase8-mxc-diagnostic", id),
  nonce = randomUUID();
await mkdir(workspace, { recursive: true });
await mkdir(peer, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(workspace, ".ctxgate-eval-root"), "");
await writeFile(join(workspace, "input.txt"), nonce);
await writeFile(join(output, "canary.txt"), randomUUID());
await writeFile(join(peer, "canary.txt"), randomUUID());
const report = {
  schema_version: 1,
  operation: "phase8_mxc_static_diagnostic",
  started_at: new Date().toISOString(),
  workspace,
  output,
  runtime: process.version,
  model_calls: 0,
};
try {
  report.external_control = await new Promise((done) => {
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
  const host = resolveCodex();
  // Preserve every protected path and explicit network setting; replace backend only.
  const args = overrides(workspace).map((entry) =>
    entry === 'windows.sandbox="elevated"' ? 'windows.sandbox="mxc"' : entry,
  );
  const code = `const f=require('node:fs');const result={};
const input=f.readFileSync('input.txt','utf8');f.writeFileSync('output.txt',input);result.inside=true;
for(const [key,path] of Object.entries(JSON.parse(process.argv[1]))){try{f.readFileSync(path);result[key]={denied:false}}catch(e){result[key]={denied:['EACCES','EPERM'].includes(e.code),code:e.code}}}
const s=require('node:net').connect(443,'1.1.1.1');
s.on('connect',()=>{result.network={denied:false};s.destroy();console.log(JSON.stringify(result))});
s.on('error',e=>{result.network={denied:['EACCES','EPERM'].includes(e.code),code:e.code};console.log(JSON.stringify(result))});
s.setTimeout(3000,()=>{result.network={denied:false,code:'timeout'};s.destroy();console.log(JSON.stringify(result))});`;
  report.host = host;
  report.run = await runProcess(
    host.command,
    [
      "--no-daemon",
      "sandbox",
      "--include-managed-config",
      "--permission-profile",
      "ctxgate_eval",
      "--cd",
      workspace,
      ...args,
      "--",
      process.execPath,
      "-e",
      code,
      JSON.stringify({
        project: join(output, "canary.txt"),
        personal: join(homedir(), ".codex", "AGENTS.md"),
        peer: join(peer, "canary.txt"),
      }),
    ],
    { cwd: workspace, timeout_ms: 30000 },
  );
  report.roundtrip =
    (await readFile(join(workspace, "output.txt"), "utf8")) === nonce;
  report.checks = JSON.parse(report.run.stdout.trim());
  report.ready =
    report.run.exit_code === 0 &&
    !report.run.timed_out &&
    report.roundtrip &&
    report.external_control.reachable &&
    ["project", "personal", "peer", "network"].every(
      (key) => report.checks[key]?.denied,
    );
} catch (error) {
  report.error = error.message;
  report.ready = false;
} finally {
  try {
    report.cleanup = await restorePhase8Access(
      join(output, "permission-restoration.json"),
    );
  } catch (error) {
    report.cleanup_error = error.message;
    report.ready = false;
  }
}
report.elapsed_ms = Date.now() - Date.parse(report.started_at);
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 2;
