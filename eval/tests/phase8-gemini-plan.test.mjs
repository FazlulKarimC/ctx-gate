import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../dist/index.js";
import {
  GEMINI_ASSIGNMENTS,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MODEL,
  GEMINI_PREFERRED_EFFORT,
  GEMINI_TIMEOUT_MS,
  chooseGeminiEffort,
} from "../scripts/phase8-gemini-plan.mjs";
import {
  geminiToolDeclarations,
  runGeminiAgentSession,
} from "../scripts/phase8-gemini-run.mjs";
import { pilotMetrics } from "../scripts/pilot-metrics.mjs";

test("Gemini 3.8 Flash (low reasoning) pilot fixes six task pairs and alternates first arm", () => {
  assert.equal(GEMINI_MODEL, "gemini-3.8-flash");
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
  assert.equal(geminiToolDeclarations("A")[0].functionDeclarations.length, 4);
  assert.equal(geminiToolDeclarations("B")[0].functionDeclarations.length, 6);
});

test("multi-turn Gemini function-calling loop executes ctx_context and workspace edits without temperature parameter", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ctxgate-gemini-loop-"));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "gemini-loop-fixture", type: "module" }),
  );
  await writeFile(
    join(workspace, "src/math.ts"),
    "export function add(a: number, b: number) { return a - b; }\n",
  );
  await initialize(workspace);

  const requests = [];
  let turnIndex = 0;
  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.equal(body.generationConfig.temperature, undefined);
    assert.deepEqual(body.generationConfig.thinkingConfig, {
      thinkingLevel: "LOW",
    });
    turnIndex++;
    if (turnIndex === 1) {
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call-1",
                      name: "ctx_context",
                      args: {
                        query: "symbol:add",
                        budget_tokens: 2000,
                        encoding: "o200k_base",
                      },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            cachedContentTokenCount: 0,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 10,
          },
        }),
      };
    }
    if (turnIndex === 2) {
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call-2",
                      name: "write_workspace_file",
                      args: {
                        path: "src/math.ts",
                        content:
                          "export function add(a: number, b: number) { return a + b; }\n",
                      },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 300,
            cachedContentTokenCount: 100,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 12,
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Fixed add implementation in src/math.ts." }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 350,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 15,
          thoughtsTokenCount: 5,
        },
      }),
    };
  };

  const telemetry = [];
  const session = await runGeminiAgentSession({
    workspace,
    condition: "B",
    prompt: "Fix add(a, b) so it returns a + b.",
    apiKey: "test-key",
    fetchImpl: mockFetch,
    onToolObservation: (obs) => telemetry.push(obs),
  });

  assert.equal(session.model_turn_completed, true);
  assert.equal(session.stop_batch, false);
  assert.equal(requests.length, 3);
  const secondTurnUserReply = requests[1].contents.at(-1);
  assert.equal(secondTurnUserReply.role, "user");
  assert.equal(secondTurnUserReply.parts[0].functionResponse.id, "call-1");
  assert.equal(
    secondTurnUserReply.parts[0].functionResponse.name,
    "ctx_context",
  );
  assert.match(
    await readFile(join(workspace, "src/math.ts"), "utf8"),
    /a \+ b/,
  );

  const metrics = pilotMetrics(session, telemetry, {
    source_spans: [{ path: "src/math.ts", start_line: 1, end_line: 1 }],
  });
  assert.equal(metrics.context_attempts, 1);
  assert.equal(metrics.valid_context_responses, 1);
  assert.equal(metrics.pre_edit_delivery, true);
  assert.equal(metrics.pre_edit_useful_span_delivery, true);
  assert.equal(metrics.usage.input_tokens, 770);
  assert.equal(metrics.usage.cached_input_tokens, 300);
  assert.equal(metrics.usage.output_tokens, 70);
});
