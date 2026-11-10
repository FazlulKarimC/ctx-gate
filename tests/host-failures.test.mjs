import test from "node:test";
import assert from "node:assert/strict";
import {
  isAccountLimit,
  classifyHostFailure,
} from "../eval/scripts/host-failures.mjs";
import { runProcess } from "../eval/scripts/phase5-host.mjs";
test("usage-limit wording and stderr-only 429 waits stop the batch without blaming unexecuted tasks", () => {
  for (const message of [
    "You’ve hit your usage limit. Try again at 10:00 PM.",
    "You've hit your usage limit.",
    "429 Too Many Requests",
    "usage_limit_reached",
    "insufficient_quota",
  ]) {
    assert.ok(isAccountLimit(message));
    const failure = classifyHostFailure(
      { events: [{ type: "turn.started" }], stderr: message, timed_out: true },
      [],
      { command_count: 0 },
    );
    assert.equal(failure.status, "infrastructure_invalid");
    assert.equal(failure.stop_batch, true);
  }
  const interrupted = classifyHostFailure(
    {
      events: [
        { type: "turn.started" },
        {
          type: "turn.failed",
          error: { message: "You’ve hit your usage limit." },
        },
      ],
      stderr: "",
    },
    [{ path: "test/a.js" }],
    { command_count: 1 },
  );
  assert.equal(interrupted.status, "task_failure");
  assert.equal(interrupted.reason, "account_limit_after_task_progress");
  assert.equal(interrupted.stop_batch, true);
  assert.equal(
    classifyHostFailure(
      {
        events: [
          { type: "turn.started" },
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              aggregated_output: "You’ve hit your usage limit.",
            },
          },
        ],
        stderr: "",
      },
      [],
      { command_count: 1 },
    ).status,
    "eligible",
  );
});
test("runtime kills a synthetic quota-retrying child promptly without any Codex/model call", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "process.stderr.write('You have hit your usage limit.'); setInterval(()=>{},1000)",
    ],
    { cwd: process.cwd(), timeout_ms: 10000 },
  );
  assert.equal(result.account_limit_detected, true);
  assert.equal(result.timed_out, false);
  assert.ok(result.elapsed_ms < 5000);
  assert.equal(result.events.length, 0);
});
