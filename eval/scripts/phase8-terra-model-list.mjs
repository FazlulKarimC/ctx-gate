import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { project, trialRoot } from "./phase5-host.mjs";
import { applyTerraHostPin } from "./phase8-terra-host-bootstrap.mjs";
import { restorePhase8Access } from "./phase8-cleanup.mjs";
import { TERRA_MODEL, chooseTerraEffort } from "./phase8-terra-plan.mjs";
import { openTerraHostAudit, TERRA_SANDBOX } from "./phase8-terra-host.mjs";

const hostPin = await applyTerraHostPin();
const id = new Date().toISOString().replaceAll(/[:.]/g, "-");
const workspace = join(trialRoot, `phase8-terra-model-list-${id}`, "workspace");
const output = join(project, "eval/runs/phase8-terra-readiness", id);
await mkdir(join(workspace, "../host-state"), { recursive: true });
await mkdir(join(workspace, "../host-logs"), { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(workspace, ".ctxgate-eval-root"), randomUUID());
const report = {
  schema_version: 1,
  operation: "phase8_terra_model_list",
  created_at: new Date().toISOString(),
  output,
  workspace,
  model_calls: 0,
  requested_model: TERRA_MODEL,
  host_pin_manifest: hostPin.manifest,
  status: "unavailable",
};
let audit;
try {
  audit = await openTerraHostAudit(workspace);
  const models = await audit.request("model/list", {
    limit: 100,
    includeHidden: false,
  });
  const terra = models.data?.find(
    (model) => model.model === TERRA_MODEL && model.hidden !== true,
  );
  const config = await audit.request("config/read", {
    cwd: workspace,
    includeLayers: false,
  });
  report.host = audit.host;
  report.controls = {
    windows_sandbox: config.config?.windows?.sandbox ?? null,
    memories_disabled:
      config.config?.memories?.use_memories === false &&
      config.config?.memories?.generate_memories === false,
    integrations_disabled:
      config.config?.features?.plugins === false &&
      config.config?.features?.apps === false &&
      config.config?.features?.multi_agent === false,
    network_disabled:
      config.config?.permissions?.ctxgate_terra_eval?.network?.enabled ===
      false,
  };
  report.terra = terra
    ? {
        id: terra.id,
        model: terra.model,
        display_name: terra.displayName ?? null,
        default_reasoning_effort: terra.defaultReasoningEffort ?? null,
        supported_reasoning_efforts: terra.supportedReasoningEfforts ?? [],
        selected_reasoning_effort: chooseTerraEffort(terra),
      }
    : null;
  report.status =
    terra &&
    report.terra.selected_reasoning_effort &&
    report.controls.windows_sandbox === TERRA_SANDBOX &&
    report.controls.memories_disabled &&
    report.controls.integrations_disabled &&
    report.controls.network_disabled
      ? "ready"
      : "unavailable";
} catch (error) {
  report.error = error.message;
} finally {
  await audit?.close();
  try {
    report.cleanup = await restorePhase8Access(
      join(output, "permission-restoration.json"),
    );
  } catch (error) {
    report.cleanup_error = error.message;
    report.status = "unavailable";
  }
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "ready" ? 0 : 2;
