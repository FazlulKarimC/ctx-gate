import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Post-run analysis only; never invokes retrieval, a model, or the task runner.
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = async (path) =>
  JSON.parse(await readFile(join(project, path), "utf8"));
const recovery = process.argv.includes("--recovery");
const runPrefix = recovery ? "phase8-recovery" : "phase8";
const input = await load(
  recovery
    ? "eval/summaries/phase8-recovery-audit.json"
    : "eval/summaries/phase8-audit.json",
);
const pool = await load("eval/manifests/holdout-readiness.json");
const planned = recovery
  ? (await load("eval/manifests/phase8-recovery-policy.json")).assignments
  : (await load("eval/manifests/phase8-pre-task-fix.json")).assignments;
const plannedTasks = pool.tasks.filter((task) =>
  planned.some((row) => row.id === task.id),
);
let reviews = { rows: [] };
try {
  reviews = await load(
    recovery
      ? "eval/labels/phase8-recovery-patch-review.json"
      : "eval/labels/phase8-patch-review.json",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n
    ? {
        n,
        mean: sorted.reduce((a, b) => a + b, 0) / n,
        median:
          n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
        min: sorted[0],
        max: sorted[n - 1],
      }
    : { n: 0, mean: null, median: null, min: null, max: null };
};
const rows = [];
for (const row of input.rows) {
  const task = pool.tasks.find((task) => task.id === row.id),
    review = reviews.rows.find((review) => review.slot === row.slot),
    reportPath =
      row.report_path ??
      `eval/runs/${runPrefix}/${input.run_id}/${row.slot}/report.json`,
    digest = createHash("sha256")
      .update(await readFile(join(project, reportPath)))
      .digest("hex");
  if (review && review.report_sha256 !== digest)
    throw Error("Review/report mismatch: " + row.slot);
  const eligible = row.status !== "infrastructure_invalid";
  const outcome = !eligible
    ? "infrastructure_invalid"
    : row.status === "unassessed"
      ? review?.decision === "accepted"
        ? "success"
        : review?.decision === "rejected"
          ? "task_failure"
          : "unassessed"
      : row.status;
  rows.push({
    id: row.id,
    slot: row.slot,
    condition: row.condition,
    category: task.category,
    family: task.family,
    repository: task.repository,
    eligible,
    outcome,
    report: reportPath,
    review: review ?? null,
    elapsed_ms: row.run.elapsed_ms,
    timed_out: row.run.timed_out,
    turn_completed_ms: row.run.turn_completed_ms ?? null,
    cleanup_elapsed_ms: row.run.cleanup_elapsed_ms ?? null,
    cleanup_forced: row.run.cleanup_forced ?? null,
    model_turn_completed: recovery
      ? row.run.model_turn_completed === true
      : null,
    usage: row.metrics.usage,
    command_count: row.metrics.command_count,
    context_attempts: row.metrics.context_attempts,
    expand_attempts: row.metrics.expand_attempts,
    pre_edit_delivery: row.metrics.pre_edit_delivery,
    // pilotMetrics has no exhaustive held-out span labels: false there is not a measured miss.
    pre_edit_useful_span_delivery: review?.useful_span_before_edit ?? null,
    retrieval_ms: row.metrics.retrieval_ms,
    host_failure: row.host_failure,
    engine_payload_bytes: row.metrics.engine_payload_bytes,
    observed_mcp_result_json_bytes: row.metrics.observed_mcp_result_json_bytes,
  });
}
const metrics = {
  elapsed_ms: (row) => row.elapsed_ms,
  turn_completed_ms: (row) => row.turn_completed_ms,
  cleanup_elapsed_ms: (row) => row.cleanup_elapsed_ms,
  input_tokens: (row) => row.usage.input_tokens,
  uncached_input_tokens: (row) => row.usage.uncached_input_tokens,
  cached_input_tokens: (row) => row.usage.cached_input_tokens,
  output_tokens: (row) => row.usage.output_tokens,
  command_count: (row) => row.command_count,
};
const describe = (selected) => ({
  n: selected.length,
  success: selected.filter((row) => row.outcome === "success").length,
  task_failure: selected.filter((row) => row.outcome === "task_failure").length,
  product_failure: selected.filter((row) => row.outcome === "product_failure")
    .length,
  infrastructure_invalid: selected.filter((row) => !row.eligible).length,
  unassessed: selected.filter((row) => row.outcome === "unassessed").length,
  metrics: Object.fromEntries(
    Object.entries(metrics).map(([key, fn]) => [
      key,
      stats(selected.filter((row) => row.eligible).map(fn)),
    ]),
  ),
});
const pairs = plannedTasks.map((task) => {
  const A = rows.find((row) => row.id === task.id && row.condition === "A"),
    B = rows.find((row) => row.id === task.id && row.condition === "B"),
    complete = Boolean(
      A?.eligible &&
      B?.eligible &&
      A.outcome !== "unassessed" &&
      B.outcome !== "unassessed",
    );
  return {
    id: task.id,
    category: task.category,
    family: task.family,
    complete,
    both_turns_completed: Boolean(
      A?.model_turn_completed && B?.model_turn_completed,
    ),
    A:
      A?.outcome ??
      (planned.some((row) => row.id === task.id && row.condition === "A")
        ? "not_attempted"
        : "not_assigned_in_this_variant"),
    B:
      B?.outcome ??
      (planned.some((row) => row.id === task.id && row.condition === "B")
        ? "not_attempted"
        : "not_assigned_in_this_variant"),
    deltas_B_minus_A: Object.fromEntries(
      Object.entries(metrics).map(([key, fn]) => [
        key,
        complete &&
        (!recovery || (A.model_turn_completed && B.model_turn_completed)) &&
        Number.isFinite(fn(A)) &&
        Number.isFinite(fn(B))
          ? fn(B) - fn(A)
          : null,
      ]),
    ),
  };
});
const complete = pairs.filter((pair) => pair.complete);
const treatment = rows.filter((row) => row.condition === "B" && row.eligible);
const summary = {
  schema_version: 1,
  operation: recovery ? "phase8_recovery_analysis" : "phase8_audited_analysis",
  created_at: new Date().toISOString(),
  run_id: input.run_id,
  planned_attempts: input.planned_attempts,
  reserved_attempts: input.reserved_attempts,
  completed_reports: input.completed_reports,
  unassessed_reservations: input.unassessed_reservations,
  not_attempted: input.planned_attempts - input.reserved_attempts,
  stop_reason: input.stop_reason,
  infrastructure_adjudication: input.adjudication,
  completed_turn_diagnostics: input.diagnostics,
  interpretation:
    "One repetition; small public historical sample with family clusters. Missing/invalid/unassessed are distinct. No causal inference from tool-use subgroup. Cached input is included in input, never added to it. Billing, resolved provider model and unobserved compaction unavailable.",
  by_condition: Object.fromEntries(
    ["A", "B"].map((condition) => [
      condition,
      describe(rows.filter((row) => row.condition === condition)),
    ]),
  ),
  complete_pairs: {
    n: complete.length,
    families: new Set(complete.map((pair) => pair.family)).size,
    fully_completed_turn_pairs: complete.filter(
      (pair) => pair.both_turns_completed,
    ).length,
    both_success: complete.filter(
      (pair) => pair.A === "success" && pair.B === "success",
    ).length,
    A_only_success: complete.filter(
      (pair) => pair.A === "success" && pair.B !== "success",
    ).length,
    B_only_success: complete.filter(
      (pair) => pair.A !== "success" && pair.B === "success",
    ).length,
    neither_success: complete.filter(
      (pair) => pair.A !== "success" && pair.B !== "success",
    ).length,
    paired_deltas: Object.fromEntries(
      Object.keys(metrics).map((key) => [
        key,
        stats(complete.map((pair) => pair.deltas_B_minus_A[key])),
      ]),
    ),
  },
  by_category: Object.fromEntries(
    [...new Set(pool.tasks.map((task) => task.category))].map((category) => [
      category,
      Object.fromEntries(
        ["A", "B"].map((condition) => [
          condition,
          describe(
            rows.filter(
              (row) => row.category === category && row.condition === condition,
            ),
          ),
        ]),
      ),
    ]),
  ),
  treatment_uptake: {
    eligible: treatment.length,
    context_invoked: treatment.filter((row) => row.context_attempts > 0).length,
    pre_edit_delivery: treatment.filter((row) => row.pre_edit_delivery).length,
    expansion_invoked: treatment.filter((row) => row.expand_attempts > 0)
      .length,
    invoked_subgroup_descriptive: describe(
      treatment.filter((row) => row.context_attempts > 0),
    ),
    nonuse_subgroup_descriptive: describe(
      treatment.filter((row) => row.context_attempts === 0),
    ),
  },
  pairs,
  rows,
};
await writeFile(
  join(
    project,
    recovery
      ? "eval/summaries/phase8-recovery.json"
      : "eval/summaries/phase8.json",
  ),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: summary.run_id,
      reports: rows.length,
      complete_pairs: complete.length,
      by_condition: summary.by_condition,
      stop_reason: summary.stop_reason,
    },
    null,
    2,
  ),
);
