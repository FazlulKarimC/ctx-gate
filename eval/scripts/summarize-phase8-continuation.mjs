// Post-run analysis only. This never invokes a model or changes raw reports.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = async (path) =>
  JSON.parse(await readFile(join(project, path), "utf8"));
const input = await load("eval/summaries/phase8-continuation-audit.json");
const policy = await load("eval/manifests/phase8-continuation-policy.json");
const pool = await load("eval/manifests/holdout-readiness.json");
const ledger = (
  await readFile(join(project, "eval/runs/phase8/attempts.jsonl"), "utf8")
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const stats = (values) => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length
    ? {
        n: finite.length,
        mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
        min: finite[0],
        max: finite.at(-1),
      }
    : { n: 0, mean: null, min: null, max: null };
};
const rows = input.rows.map((row) => {
  const task = pool.tasks.find((candidate) => candidate.id === row.id);
  const eligible = row.status !== "infrastructure_invalid";
  return {
    id: row.id,
    slot: row.slot,
    condition: row.condition,
    repository: task?.repository ?? null,
    category: task?.category ?? null,
    family: task?.family ?? null,
    eligible,
    outcome: row.status,
    model_turn_completed: row.run.model_turn_completed === true,
    timed_out: row.run.timed_out === true,
    elapsed_ms: row.run.elapsed_ms,
    turn_completed_ms: row.run.turn_completed_ms ?? null,
    cleanup_elapsed_ms: row.run.cleanup_elapsed_ms ?? null,
    usage: row.metrics.usage,
    command_count: row.metrics.command_count,
    context_attempts: row.metrics.context_attempts,
    expand_attempts: row.metrics.expand_attempts,
    pre_edit_delivery: row.metrics.pre_edit_delivery,
    host_failure: row.host_failure,
    report: row.report_path,
  };
});
const describe = (selected) => ({
  n: selected.length,
  eligible: selected.filter((row) => row.eligible).length,
  task_failure: selected.filter((row) => row.outcome === "task_failure").length,
  infrastructure_invalid: selected.filter(
    (row) => row.outcome === "infrastructure_invalid",
  ).length,
  terminal_completed: selected.filter((row) => row.model_turn_completed).length,
  metrics: {
    elapsed_ms: stats(
      selected.filter((row) => row.eligible).map((row) => row.elapsed_ms),
    ),
    input_tokens: stats(
      selected
        .filter((row) => row.eligible)
        .map((row) => row.usage.input_tokens),
    ),
    command_count: stats(
      selected.filter((row) => row.eligible).map((row) => row.command_count),
    ),
  },
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
      family: task?.family ?? null,
      A: A?.outcome ?? "not_attempted",
      B: B?.outcome ?? "not_attempted",
      eligible_pair: Boolean(A?.eligible && B?.eligible),
      completed_turn_pair: Boolean(
        A?.model_turn_completed && B?.model_turn_completed,
      ),
      delta_B_minus_A: {
        elapsed_ms:
          A?.eligible &&
          B?.eligible &&
          Number.isFinite(A.elapsed_ms) &&
          Number.isFinite(B.elapsed_ms)
            ? B.elapsed_ms - A.elapsed_ms
            : null,
        input_tokens:
          A?.eligible &&
          B?.eligible &&
          Number.isFinite(A.usage.input_tokens) &&
          Number.isFinite(B.usage.input_tokens)
            ? B.usage.input_tokens - A.usage.input_tokens
            : null,
      },
    };
  },
);
const summary = {
  schema_version: 1,
  operation: "phase8_continuation_analysis",
  created_at: new Date().toISOString(),
  run_id: input.run_id,
  planned_attempts: policy.assignments.length,
  reserved_attempts: input.reserved_attempts,
  globally_reserved_attempts: ledger.length,
  globally_unattempted_attempts: 36 - ledger.length,
  stop_reason: input.stop_reason,
  interpretation:
    "Separate continuation stratum. The two completed Picomatch turns both failed their focused task test; their paired timing/token difference is descriptive only and is not a performance effect. The JSON Server treatment was rejected before model execution as unsupported, so it is infrastructure-invalid. No success claim, model comparison, or whole-agent context benefit is estimable.",
  by_condition: Object.fromEntries(
    ["A", "B"].map((condition) => [
      condition,
      describe(rows.filter((row) => row.condition === condition)),
    ]),
  ),
  pairs,
  rows,
};
await writeFile(
  join(project, "eval/summaries/phase8-continuation.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: summary.run_id,
      reserved_attempts: summary.reserved_attempts,
      globally_reserved_attempts: summary.globally_reserved_attempts,
      globally_unattempted_attempts: summary.globally_unattempted_attempts,
      stop_reason: summary.stop_reason,
      by_condition: summary.by_condition,
      pairs: summary.pairs.filter(
        (pair) => pair.A !== "not_attempted" || pair.B !== "not_attempted",
      ),
    },
    null,
    2,
  ),
);
