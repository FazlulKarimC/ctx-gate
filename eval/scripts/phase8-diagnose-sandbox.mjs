import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { project, trialRoot, overrides, runProcess } from "./phase5-host.mjs";
import { resolveCodex } from "./codex-command.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
const id = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  workspace = join(trialRoot, "phase8-diagnostic-" + id, "workspace"),
  output = join(project, "eval/runs/phase8-diagnostic", id);
await mkdir(workspace, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(workspace, ".ctxgate-eval-root"), "");
await writeFile(join(output, "outside.txt"), "PRIVATE_CANARY");
const code =
  'const f=require("node:fs");f.writeFileSync("inside.txt","OK");let denied;try{f.readFileSync(process.argv[1]);denied=false}catch(e){denied=["EACCES","EPERM"].includes(e.code)}console.log(JSON.stringify({inside:true,outside_denied:denied}))';
let result;
try {
  const host = resolveCodex();
  result = {
    host,
    workspace,
    ...(await runProcess(
      host.command,
      [
        "--no-daemon",
        "sandbox",
        "--permission-profile",
        "ctxgate_eval",
        "--cd",
        workspace,
        ...overrides(workspace),
        "--",
        process.execPath,
        "-e",
        code,
        join(output, "outside.txt"),
      ],
      { cwd: workspace, timeout_ms: 90000 },
    )),
  };
} finally {
  try {
    const cleanup = await restorePhase8Access(
      join(output, "permission-restoration.json"),
    );
    if (result) result.cleanup = cleanup;
  } catch (error) {
    if (result) result.cleanup_error = error.message;
  }
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
