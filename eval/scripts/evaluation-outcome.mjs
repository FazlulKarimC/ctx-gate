// Post-run audit / future-harness helper. Does not alter registered run records.
export function evaluationOutcome({
  host_failure,
  timed_out,
  model_turn_completed,
  assessment,
}) {
  if (
    ["infrastructure_invalid", "product_failure", "task_failure"].includes(
      host_failure.status,
    )
  )
    return host_failure.status;
  if (timed_out) return "task_failure";
  if (!model_turn_completed) return "infrastructure_invalid";
  if (
    [assessment.focused, assessment.controls, assessment.existing]
      .filter(Boolean)
      .some((check) => check.exit_code !== 0)
  )
    return "task_failure";
  return "unassessed"; // Passing tests still requires patch review.
}
