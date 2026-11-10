import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { classifyHostFailure } from "./host-failures.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  runId = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(runId ?? ""))
  throw Error("Supply the preserved pilot run timestamp");
const output = join(root, "eval/runs/phase5-pilot", runId),
  json = async (path) => JSON.parse(await readFile(path, "utf8")),
  sha = (data) => createHash("sha256").update(data).digest("hex");
const raw = await json(join(output, "summary.json")),
  review = await json(join(root, "eval/labels/phase5-patch-review.json")),
  rows = [];
for (const original of raw.rows) {
  const path = join(output, original.slot),
    events = (await readFile(join(path, "events.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse),
    stderr = await readFile(join(path, "stderr.txt"), "utf8"),
    failure = classifyHostFailure(
      {
        events,
        stderr,
        timed_out: original.timed_out,
        spawn_error: original.spawn_error,
      },
      original.changed,
      original.metrics,
    ),
    patchReview = review.reviews.find((row) => row.slot === original.slot);
  const status =
    failure.status === "infrastructure_invalid"
      ? failure.status
      : (patchReview?.final_status ?? original.status);
  if (failure.task_progress && !patchReview)
    throw Error("Executed task lacks patch review: " + original.slot);
  rows.push({
    slot: original.slot,
    id: original.id,
    repetition: original.repetition,
    condition: original.condition,
    original_status: original.status,
    status,
    outcome_reason:
      failure.reason ??
      (patchReview?.accepted ? "reviewed_scoped_correction" : null),
    task_progress: failure.task_progress,
    eligible: status !== "infrastructure_invalid",
    agent_elapsed_ms: original.agent_elapsed_ms,
    setup_ms: original.setup_ms,
    assessment_ms: original.assessment_ms,
    exit_code: original.exit_code,
    timed_out: original.timed_out,
    focused_regression_passed: original.focused_regression.passed,
    new_protected_existing_failures:
      original.original_selected_tests.new_failures.length,
    metrics: original.metrics,
    patch_review: patchReview
      ? {
          accepted: patchReview.accepted,
          task_constraints_met: patchReview.task_constraints_met,
          reviewer: patchReview.reviewer,
        }
      : null,
    raw_report: join(
      "eval/runs/phase5-pilot",
      runId,
      original.slot,
      "report.json",
    ).replaceAll("\\", "/"),
  });
}
const count = (predicate) => rows.filter(predicate).length,
  eligible = rows.filter((row) => row.eligible),
  treatment = eligible.filter((row) => row.condition === "B"),
  pairs = [];
for (const a of eligible.filter((row) => row.condition === "A")) {
  const b = eligible.find(
    (row) =>
      row.id === a.id &&
      row.repetition === a.repetition &&
      row.condition === "B",
  );
  if (!b) continue;
  const complete =
    a.metrics.usage.input_tokens !== null &&
    b.metrics.usage.input_tokens !== null &&
    !a.outcome_reason?.startsWith("account_limit") &&
    !b.outcome_reason?.startsWith("account_limit");
  if (!complete) continue;
  pairs.push({
    id: a.id,
    repetition: a.repetition,
    A: {
      status: a.status,
      agent_elapsed_ms: a.agent_elapsed_ms,
      usage: a.metrics.usage,
      commands: a.metrics.command_count,
    },
    B: {
      status: b.status,
      agent_elapsed_ms: b.agent_elapsed_ms,
      usage: b.metrics.usage,
      commands: b.metrics.command_count,
      pre_edit_delivery: b.metrics.pre_edit_delivery,
      pre_edit_useful_span_delivery: b.metrics.pre_edit_useful_span_delivery,
      context_delivery_ms: b.metrics.time_to_context_delivery_ms,
      retrieval_ms: b.metrics.retrieval_ms,
      engine_tokens: b.metrics.returned_engine_tokens,
      engine_payload_bytes: b.metrics.engine_payload_bytes,
      observed_tool_result_json_bytes: b.metrics.observed_mcp_result_json_bytes,
    },
    difference_B_minus_A: {
      agent_elapsed_ms: b.agent_elapsed_ms - a.agent_elapsed_ms,
      input_tokens: b.metrics.usage.input_tokens - a.metrics.usage.input_tokens,
      uncached_input_tokens:
        b.metrics.usage.uncached_input_tokens -
        a.metrics.usage.uncached_input_tokens,
      output_tokens:
        b.metrics.usage.output_tokens - a.metrics.usage.output_tokens,
      commands: b.metrics.command_count - a.metrics.command_count,
    },
  });
}
const available = rows.filter((row) => row.metrics.usage.input_tokens !== null);
const summary = {
  schema_version: 1,
  operation: "phase5_pilot_audit",
  created_at: new Date().toISOString(),
  run_id: runId,
  status: "complete_reduced_pilot_under_attempt_ceiling",
  raw_summary_sha256: sha(await readFile(join(output, "summary.json"))),
  patch_review_sha256: sha(
    await readFile(join(root, "eval/labels/phase5-patch-review.json")),
  ),
  assigned_attempts: rows.length,
  attempt_ceiling_consumed: rows.length === 20,
  eligible_started_tasks: eligible.length,
  completed_task_attempts: count((row) => row.status === "task_success"),
  account_interrupted_after_progress: count(
    (row) => row.outcome_reason === "account_limit_after_task_progress",
  ),
  infrastructure_invalid: count(
    (row) => row.status === "infrastructure_invalid",
  ),
  complete_pairs: pairs.length,
  all_assignments_by_condition: Object.fromEntries(
    ["A", "B"].map((condition) => {
      const group = rows.filter((row) => row.condition === condition);
      return [
        condition,
        {
          assigned: group.length,
          eligible: group.filter((row) => row.eligible).length,
          task_success: group.filter((row) => row.status === "task_success")
            .length,
          task_failure: group.filter((row) => row.status === "task_failure")
            .length,
          infrastructure_invalid: group.filter((row) => !row.eligible).length,
        },
      ];
    }),
  ),
  uptake: {
    eligible_B: treatment.length,
    context_invoked: treatment.filter((row) => row.metrics.context_attempts > 0)
      .length,
    pre_edit_nonempty_delivery: treatment.filter(
      (row) => row.metrics.pre_edit_delivery,
    ).length,
    pre_edit_labeled_span_delivery: treatment.filter(
      (row) => row.metrics.pre_edit_useful_span_delivery,
    ).length,
    all_assigned_B: rows.filter((row) => row.condition === "B").length,
    expansions: treatment.reduce(
      (sum, row) => sum + row.metrics.expand_attempts,
      0,
    ),
    interpretation:
      "2/2 eligible B attempts received context before an observed edit; 2/10 assigned B slots when infrastructure-invalid sessions are also displayed. Too small to establish general adoption. Useful labeled-span delivery is a distinct metric.",
  },
  usage: {
    available_records: available.length,
    assigned_records: rows.length,
    known_input_tokens_sum: available.reduce(
      (sum, row) => sum + row.metrics.usage.input_tokens,
      0,
    ),
    known_output_tokens_sum: available.reduce(
      (sum, row) => sum + row.metrics.usage.output_tokens,
      0,
    ),
    total_usage: null,
    billing_cost: null,
    reason:
      "Final usage missing on interrupted/rejected attempts; visible sums are not total account consumption. Cached/reasoning fields are not added again.",
  },
  sessions_not_provider_requests: true,
  model_task_sessions: rows.length,
  capability_sessions_separate: true,
  no_additional_attempts_authorized: true,
  holdout_sessions: 0,
  harness_stop_rule_violation: {
    observed: true,
    cause:
      "Detector matched rate limit/quota exceeded but missed the provider's usage-limit wording and stderr-only 429 waits. It should have stopped after the third task session; seventeen later reservations are retained and corrected as infrastructure-invalid.",
    corrected_with:
      "host-failures.mjs, immediate runtime termination, and focused regression tests; no model calls used for verification",
  },
  matched_pairs: pairs,
  tool_invoked_subgroup: {
    matched_pairs: pairs.filter(
      (pair) =>
        rows.find(
          (row) =>
            row.id === pair.id &&
            row.repetition === pair.repetition &&
            row.condition === "B",
        ).metrics.context_attempts > 0,
    ).length,
    interpretation:
      "Descriptive selected subgroup only; not causal. The additional interrupted B run has no eligible matched A counterpart.",
  },
  limitations: [
    "Only one complete pair and two effective task IDs from the same globstar family; no representative benefit estimate or equivalence claim",
    "Quota interruption is an external resource failure, not evidence that retrieval caused the incomplete patch",
    "Both completed patches were reviewed by the implementation agent, not an independent human",
    "Original protected selected tests plus focused behavior and reviewed agent-added tests; full upstream npm/lint/coverage unavailable",
    "Windows loopback remains reachable; known project/history, personal state and peer paths were denied",
    "Backend model revision, billing cost and unexposed compaction remain unavailable; no new run allowance inferred",
  ],
  rows,
};
await writeFile(
  join(output, "audited-summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
await writeFile(
  join(root, "eval/summaries/phase5-pilot.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      assigned: summary.assigned_attempts,
      eligible: summary.eligible_started_tasks,
      completed: summary.completed_task_attempts,
      interrupted: summary.account_interrupted_after_progress,
      infrastructure_invalid: summary.infrastructure_invalid,
      complete_pairs: pairs.length,
      uptake: summary.uptake,
      pairs,
    },
    null,
    2,
  ),
);
