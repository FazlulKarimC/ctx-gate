import test from "node:test";
import assert from "node:assert/strict";
import { evaluationOutcome } from "../scripts/evaluation-outcome.mjs";
const passing = {
  focused: { exit_code: 0 },
  controls: { exit_code: 0 },
  existing: { exit_code: 0 },
};
test("observed quota-after-progress failure cannot become success from passing partial-patch tests", () => {
  assert.equal(
    evaluationOutcome({
      host_failure: {
        status: "task_failure",
        reason: "account_limit_after_task_progress",
      },
      timed_out: false,
      model_turn_completed: false,
      assessment: passing,
    }),
    "task_failure",
  );
});
test("an infrastructure failure remains excluded despite passing candidate tests", () => {
  assert.equal(
    evaluationOutcome({
      host_failure: { status: "infrastructure_invalid" },
      timed_out: false,
      model_turn_completed: true,
      assessment: passing,
    }),
    "infrastructure_invalid",
  );
});
test("a genuine task deadline remains failure even if a partial patch passes tests", () => {
  assert.equal(
    evaluationOutcome({
      host_failure: { status: "eligible" },
      timed_out: true,
      model_turn_completed: false,
      assessment: passing,
    }),
    "task_failure",
  );
});
test("normal completion and passing checks remain unassessed until patch review", () => {
  assert.equal(
    evaluationOutcome({
      host_failure: { status: "eligible" },
      timed_out: false,
      model_turn_completed: true,
      assessment: passing,
    }),
    "unassessed",
  );
});
