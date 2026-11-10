import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context, expand, renderResult } from "../../dist/index.js";
import {
  GEMINI_ASSIGNMENTS,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MODEL,
  GEMINI_PREFERRED_EFFORT,
  GEMINI_TIMEOUT_MS,
} from "./phase8-gemini-plan.mjs";
import { verifyFreeze } from "./verify-freeze.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyPath = join(project, "eval/manifests/phase8-gemini-policy.json");
const freezePath = join(project, "eval/manifests/evaluation-freeze.json");
const ledgerPath = join(project, "eval/runs/phase8-gemini/attempts.jsonl");

const within = (parent, target) => {
  const rel = relative(parent, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

export function geminiToolDeclarations(condition = "A") {
  const tools = [
    {
      name: "read_workspace_file",
      description: "Read a UTF-8 text file inside the isolated task workspace.",
      parameters: {
        type: "OBJECT",
        properties: { path: { type: "STRING" } },
        required: ["path"],
      },
    },
    {
      name: "write_workspace_file",
      description:
        "Write a UTF-8 text file inside the isolated task workspace.",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING" },
          content: { type: "STRING" },
        },
        required: ["path", "content"],
      },
    },
  ];
  if (condition === "B") {
    tools.push(
      {
        name: "ctx_context",
        description:
          "Retrieve budgeted lexical evidence from the repository before editing.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING" },
            budget_tokens: { type: "INTEGER" },
            encoding: { type: "STRING" },
          },
          required: ["query"],
        },
      },
      {
        name: "ctx_expand",
        description: "Expand a source-bound ctxgate reference.",
        parameters: {
          type: "OBJECT",
          properties: {
            reference_json: { type: "STRING" },
            budget_tokens: { type: "INTEGER" },
          },
          required: ["reference_json"],
        },
      },
    );
  }
  return [{ functionDeclarations: tools }];
}

export async function invokeGeminiTool(workspace, condition, call) {
  const args = call.args ?? {};
  if (call.name === "read_workspace_file") {
    const target = resolve(workspace, String(args.path ?? ""));
    if (!within(workspace, target))
      return { error: "Path outside isolated workspace denied" };
    return { content: await readFile(target, "utf8") };
  }
  if (call.name === "write_workspace_file") {
    const target = resolve(workspace, String(args.path ?? ""));
    if (!within(workspace, target))
      return { error: "Path outside isolated workspace denied" };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(args.content ?? ""), "utf8");
    return { written: true, path: String(args.path) };
  }
  if (condition === "B" && call.name === "ctx_context") {
    const res = await context(workspace, String(args.query ?? ""), {
      encoding: args.encoding === "cl100k_base" ? "cl100k_base" : "o200k_base",
      budget_tokens: Number(args.budget_tokens ?? 2000),
      neighbors: false,
      notes: false,
    });
    return { result: renderResult(res) };
  }
  if (condition === "B" && call.name === "ctx_expand") {
    const ref = JSON.parse(String(args.reference_json ?? "{}"));
    const res = await expand(workspace, ref, {
      encoding: "o200k_base",
      budget_tokens: Number(args.budget_tokens ?? 1000),
      notes: false,
    });
    return { result: renderResult(res) };
  }
  return { error: `Unsupported tool: ${call.name}` };
}

export async function callGeminiFlash({
  apiKey,
  prompt,
  condition = "A",
  endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
}) {
  const response = await fetch(
    `${endpoint}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: geminiToolDeclarations(condition),
        generationConfig: {
          temperature: 0,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw Error(
      `Gemini API error (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const freeze = verifyFreeze(
    project,
    JSON.parse(await readFile(freezePath, "utf8")),
  );
  if (
    !freeze.valid ||
    policy.model !== GEMINI_MODEL ||
    policy.reasoning_effort !== GEMINI_PREFERRED_EFFORT ||
    policy.max_attempts !== GEMINI_MAX_ATTEMPTS ||
    JSON.stringify(policy.assignments) !== JSON.stringify(GEMINI_ASSIGNMENTS)
  ) {
    console.error("Gemini policy or evaluation freeze check failed");
    process.exit(2);
  }
  if (!process.argv.includes("--execute")) {
    console.log(
      JSON.stringify(
        {
          operation: "phase8_gemini_preview",
          execution: false,
          source_integrity: freeze.valid,
          host_mode: policy.host_mode,
          model: GEMINI_MODEL,
          reasoning_effort: GEMINI_PREFERRED_EFFORT,
          assignments: GEMINI_ASSIGNMENTS.length,
          model_calls: 0,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "GEMINI_API_KEY is required when running with --execute (direct Gemini API).",
    );
    process.exit(2);
  }
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, "");
}
