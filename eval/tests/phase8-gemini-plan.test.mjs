import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  GEMINI_ASSIGNMENTS,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MODEL,
  GEMINI_PREFERRED_EFFORT,
  GEMINI_TIMEOUT_MS,
  chooseGeminiEffort,
} from "../scripts/phase8-gemini-plan.mjs";
import { geminiToolDeclarations } from "../scripts/phase8-gemini-run.mjs";

test("Gemini Flash 3.8 (low reasoning) pilot fixes six task pairs and alternates first arm", () => {
  assert.equal(GEMINI_MODEL, "gemini-flash-3.8");
  assert.equal(GEMINI_PREFERRED_EFFORT, "low");
  assert.equal(GEMINI_TIMEOUT_MS, 240_000);
  assert.equal(GEMINI_ASSIGNMENTS.length, GEMINI_MAX_ATTEMPTS);
  assert.equal(new Set(GEMINI_ASSIGNMENTS.map((row) => row.slot)).size, 12);
  const byTask = Map.groupBy(GEMINI_ASSIGNMENTS, (row) => row.id);
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

test("Gemini plan prefers low reasoning effort and exposes ctx tools only in condition B", () => {
  assert.equal(
    chooseGeminiEffort({
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    }),
    "low",
  );
  assert.equal(geminiToolDeclarations("A")[0].functionDeclarations.length, 2);
  assert.equal(geminiToolDeclarations("B")[0].functionDeclarations.length, 4);
});
