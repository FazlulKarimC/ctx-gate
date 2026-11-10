// Post-run analysis only. It never invokes a model or alters raw reports.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = async (path) =>
  JSON.parse(await readFile(join(project, path), "utf8"));
const audit = await load("eval/summaries/phase8-terra-audit.json");
const policy = await load("eval/manifests/phase8-terra-policy.json");
const pool = await load("eval/manifests/holdout-readiness.json");
const rows = audit.rows.map((row) => {
  const task = pool.tasks.find((candidate) => candidate.id === row.id);
  return {
    id: row.id,
    slot: row.slot,
    condition: row.condition,
    repository: task?.repository ?? null,
    category: task?.category ?? null,
    family: task?.family ?? null,
    outcome: row.status,
    model_turn_completed: row.run.model_turn_completed === true,
    elapsed_ms: row.run.elapsed_ms,
    context_attempts: row.metrics.context_attempts,
    expand_attempts: row.metrics.expand_attempts,
    nonempty_context_deliveries: row.metrics.nonempty_context_deliveries,
    pre_edit_delivery: row.metrics.pre_edit_delivery,
    usage: row.metrics.usage,
    host_failure: row.host_failure,
    report: row.report_path,
  };
});
const pairs = [...new Set(policy.assignments.map((row) => row.id))].map(
  (id) => {
    const task = pool.tasks.find((candidate) => candidate.id === id);
    const A = rows.find((row) => row.id === id && row.condition === "A");
    const B = rows.find((row) => row.id === id && row.condition === "B");
    return {
      id,
      repository: task?.repository ?? null,
      category: task?.category ?? null,
      A: A?.outcome ?? "not_attempted",
      B: B?.outcome ?? "not_attempted",
      complete_pair: Boolean(A && B),
    };
  },
);
const summary = {
  schema_version: 1,
  operation: "phase8_terra_analysis",
  created_at: new Date().toISOString(),
  stratum: audit.stratum,
  run_id: audit.run_id,
  planned_attempts: policy.max_attempts,
  reserved_attempts: audit.reserved_attempts,
  completed_reports: audit.completed_reports,
  unattempted_registered_slots: audit.unattempted_registered_slots,
  stop_reason: audit.stop_reason,
  interpretation:
    "One treatment arm received nonempty lexical context and one expansion, then hit an account usage limit before a terminal model event or patch. There is no paired A/B outcome, accepted patch, timing comparison, or model-performance conclusion. This partial Terra result must not be pooled with the Sol strata.",
  by_condition: Object.fromEntries(
    ["A", "B"].map((condition) => [
      condition,
      {
        assigned: policy.assignments.filter(
          (row) => row.condition === condition,
        ).length,
        attempted: rows.filter((row) => row.condition === condition).length,
        task_failures: rows.filter(
          (row) =>
            row.condition === condition && row.outcome === "task_failure",
        ).length,
      },
    ]),
  ),
  pairs,
  rows,
};
await writeFile(
  join(project, "eval/summaries/phase8-terra.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: summary.run_id,
      reserved_attempts: summary.reserved_attempts,
      unattempted_registered_slots: summary.unattempted_registered_slots,
      stop_reason: summary.stop_reason,
      pairs,
      model_calls: 0,
    },
    null,
    2,
  ),
);
