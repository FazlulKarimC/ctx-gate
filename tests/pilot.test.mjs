import test from "node:test";
import assert from "node:assert/strict";
import {
  usageMetrics,
  pilotMetrics,
  editingCommand,
} from "../eval/scripts/pilot-metrics.mjs";
import {
  execArgs,
  project,
  protectedPaths,
} from "../eval/scripts/phase5-host.mjs";

test("pilot usage preserves unavailable fields and treats cached input as a subset", () => {
  const events = [
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        output_tokens: 15,
        reasoning_output_tokens: 5,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 150,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_output_tokens: 6,
      },
    },
  ];
  const usage = usageMetrics(events);
  assert.equal(usage.input_tokens, 150);
  assert.equal(usage.uncached_input_tokens, 70);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.billing_cost, null);
  assert.equal(usageMetrics([]).input_tokens, null);
});
test("pilot uptake includes tool errors/non-use and requires completed nonempty evidence before edit", () => {
  const item = {
    type: "mcp_tool_call",
    server: "ctxgate",
    tool: "ctx_context",
    status: "completed",
    error: null,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            items: [
              { reference: { path: "lib/a.js", start_line: 2, end_line: 5 } },
            ],
          }),
        },
      ],
    },
  };
  const make = (events) => ({
    events,
    started_at: "2026-10-26T00:00:00.000Z",
    timeline: events.map((_, index) => ({
      received_at: "2026-10-26T00:00:0" + index + ".000Z",
    })),
  });
  const label = {
    source_spans: [{ path: "lib/a.js", start_line: 4, end_line: 7 }],
  };
  const good = pilotMetrics(
    make([
      { type: "item.completed", item },
      { type: "item.started", item: { type: "file_change" } },
    ]),
    [],
    label,
  );
  assert.equal(good.pre_edit_delivery, true);
  assert.equal(good.pre_edit_useful_span_delivery, true);
  const late = pilotMetrics(
    make([
      { type: "item.started", item: { type: "file_change" } },
      { type: "item.completed", item },
    ]),
    [],
    label,
  );
  assert.equal(late.pre_edit_delivery, false);
  const error = pilotMetrics(
    make([
      {
        type: "item.completed",
        item: { ...item, result: { isError: true, content: [] } },
      },
    ]),
    [],
    label,
  );
  assert.equal(error.context_attempts, 1);
  assert.equal(error.valid_context_responses, 0);
  assert.equal(pilotMetrics(make([]), [], label).context_attempts, 0);
  assert.ok(editingCommand('node -e fs.writeFileSync("lib/a.js", value)'));
  assert.ok(!editingCommand("Get-Content lib/a.js"));
});
test("pilot profile rejects project-local trial roots before a host can start", () => {
  assert.throws(() => protectedPaths(project), /isolated/);
  assert.throws(() => execArgs(project, "prompt"), /isolated/);
});
