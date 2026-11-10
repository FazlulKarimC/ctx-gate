import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "../../dist/index.js";
import { tokenCounter } from "../../dist/retrieval/budget.js";

// Profiling only. Wrap the existing counter without changing returned counts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const report = JSON.parse(
  await readFile(join(root, "eval/summaries/lexical-baseline.json"), "utf8"),
);
const labels = JSON.parse(
  await readFile(join(root, "eval/labels/development-retrieval.json"), "utf8"),
);
const started = performance.now();
const counter = await tokenCounter("o200k_base"),
  initialization = performance.now() - started;
const original = counter.count,
  rows = [];
try {
  for (const id of ["picomatch-d01", "picomatch-d03", "fastify-d01"]) {
    let calls = 0,
      time = 0;
    counter.count = (text) => {
      const start = performance.now();
      const count = original(text);
      time += performance.now() - start;
      calls++;
      return count;
    };
    const start = performance.now();
    const result = await context(
      join(root, "eval/.cache/retrieval", report.run_id, id),
      labels.tasks.find((row) => row.id === id).prompt,
      { encoding: "o200k_base", lexical_version: "v1" },
    );
    rows.push({
      id,
      total_ms: performance.now() - start,
      token_count_calls: calls,
      token_count_ms: time,
      items: result.items.length,
      counted_tokens: result.budget.count,
    });
  }
} finally {
  counter.count = original;
}
await writeFile(
  join(root, "eval/summaries/packing-profile.json"),
  JSON.stringify(
    {
      created_at: new Date().toISOString(),
      purpose:
        "Separate post-study instrumentation only; counter wrapper returns unchanged counts. No production changes or ranking retuning.",
      tokenizer_initialization_ms: initialization,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(rows, null, 2));
