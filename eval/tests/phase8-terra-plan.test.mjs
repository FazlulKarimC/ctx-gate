import test from "node:test";
import assert from "node:assert/strict";
import {
  TERRA_ASSIGNMENTS,
  TERRA_MAX_ATTEMPTS,
  TERRA_MODEL,
  TERRA_TIMEOUT_MS,
  chooseTerraEffort,
} from "../scripts/phase8-terra-plan.mjs";

test("Active pilot plan fixes six untouched task pairs and alternates first arm", () => {
  assert.equal(TERRA_MODEL, "gemini-flash-3.8");
  assert.equal(TERRA_TIMEOUT_MS, 240_000);
  assert.equal(TERRA_ASSIGNMENTS.length, TERRA_MAX_ATTEMPTS);
  assert.equal(new Set(TERRA_ASSIGNMENTS.map((row) => row.slot)).size, 12);
  const byTask = Map.groupBy(TERRA_ASSIGNMENTS, (row) => row.id);
  assert.deepEqual(
    [...byTask.keys()],
    [
      "picomatch-h07",
      "picomatch-h08",
      "json-server-h07",
      "json-server-h09",
      "fastify-h01",
      "fastify-h03",
    ],
  );
  for (const rows of byTask.values())
    assert.deepEqual(rows.map((row) => row.condition).sort(), ["A", "B"]);
  assert.deepEqual(
    [...byTask.values()].map((rows) => rows[0].condition),
    ["B", "A", "B", "A", "B", "A"],
  );
});

test("Active plan prefers low reasoning effort and otherwise only accepts a returned default", () => {
  assert.equal(
    chooseTerraEffort({
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    }),
    "low",
  );
  assert.equal(
    chooseTerraEffort({
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    }),
    "high",
  );
  assert.equal(
    chooseTerraEffort({
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    }),
    null,
  );
});
