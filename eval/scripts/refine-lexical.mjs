import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { context, captureWorktree, renderResult } from "../../dist/index.js";
import { tokenCounter } from "../../dist/retrieval/budget.js";
import { relevanceMetrics, aggregateRelevance } from "./relevance-metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const json = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const registration = await json("eval/manifests/lexical-v2-refinement.json");
const pool = await json("eval/manifests/agent-pool.json"),
  review = await json("eval/labels/candidate-review.json");
if (
  pool.selection_hash !== registration.agent_pool_selection_hash ||
  pool.review_sha256 !==
    sha(await readFile(join(root, "eval/labels/candidate-review.json")))
)
  throw new Error("Qualified metadata pool changed");
const protectedFamilies = new Set([
  ...review.protected_diagnostic_families,
  ...pool.tasks
    .filter((row) => row.split === "development")
    .map((row) => row.family),
]);
if (
  pool.tasks
    .filter((row) => row.split === "holdout")
    .some((row) => protectedFamilies.has(row.family))
)
  throw new Error("Cross-split family gate failed");
for (const [path, hash] of Object.entries(registration.source_hashes))
  if (sha(await readFile(join(root, path))) !== hash)
    throw new Error("Frozen refinement input changed: " + path);
const labels = await json("eval/labels/development-retrieval.json"),
  original = await json("eval/summaries/lexical-baseline.json");
if (
  sha(await readFile(join(root, "eval/labels/development-retrieval.json"))) !==
    registration.labels_sha256 ||
  labels.tasks.length !== 20
)
  throw new Error("Require fixed 20 diagnostic labels");
const corpus = await json("eval/manifests/corpus.json");
if (
  labels.tasks.some(
    (label) =>
      !corpus.tasks.some(
        (task) => task.id === label.id && task.split === "development",
      ),
  )
)
  throw new Error("Holdout query prohibited");
const runId = new Date().toISOString().replace(/[:.]/g, "-"),
  output = join(root, "eval/runs/lexical-refinement", runId);
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "registration.json"),
  JSON.stringify(registration, null, 2) + "\n",
);
for (const path of [
  "src",
  "tests",
  "eval/scripts",
  "eval/labels",
  "eval/manifests",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".npmrc",
]) {
  const target = join(output, "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, path), target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}
const init = performance.now(),
  counter = await tokenCounter(registration.encoding),
  tokenizerInit = performance.now() - init,
  originalCount = counter.count;
const rows = [],
  negative = [];
let verifiedPayloads = 0,
  verifiedExcerpts = 0;
try {
  for (let index = 0; index < labels.tasks.length; index++) {
    const label = labels.tasks[index],
      workspace = join(
        root,
        "eval/.cache/retrieval",
        original.run_id,
        label.id,
      ),
      view = captureWorktree(workspace).view;
    const previous = await json(
      "eval/runs/retrieval/" + original.run_id + "/" + label.id + ".json",
    );
    const control = await context(workspace, label.prompt, {
      encoding: registration.encoding,
      lexical_version: "v1",
      budget_tokens: registration.budget_tokens,
    });
    if (renderResult(control) !== renderResult(previous.R1))
      throw new Error("v1 did not reproduce the retained control: " + label.id);
    if (
      JSON.stringify(relevanceMetrics(control, label, view)) !==
      JSON.stringify(previous.row.R1)
    )
      throw new Error("Relevance metric drift: " + label.id);
    const result = {
      id: label.id,
      repository: corpus.tasks.find((row) => row.id === label.id).repository,
      category: label.category,
      v1: { timings_ms: [], counter_calls: [], counter_ms: [] },
      v2: { timings_ms: [], counter_calls: [], counter_ms: [] },
    };
    const responses = { v1: control };
    for (
      let repetition = 0;
      repetition < registration.repetitions;
      repetition++
    )
      for (const variant of (index + repetition) % 2
        ? ["v2", "v1"]
        : ["v1", "v2"]) {
        let calls = 0,
          countTime = 0;
        counter.count = (text) => {
          const start = performance.now();
          const count = originalCount(text);
          countTime += performance.now() - start;
          calls++;
          return count;
        };
        const start = performance.now(),
          response = await context(workspace, label.prompt, {
            encoding: registration.encoding,
            budget_tokens: registration.budget_tokens,
            lexical_version: variant,
          }),
          elapsed = performance.now() - start;
        if (
          responses[variant] &&
          renderResult(response) !== renderResult(responses[variant])
        )
          throw new Error(
            "Non-deterministic response: " + label.id + " " + variant,
          );
        responses[variant] = response;
        result[variant].timings_ms.push(elapsed);
        result[variant].counter_calls.push(calls);
        result[variant].counter_ms.push(countTime);
      }
    counter.count = originalCount;
    for (const variant of ["v1", "v2"]) {
      const response = responses[variant],
        text = renderResult(response);
      if (
        originalCount(text) !== response.budget.count ||
        Buffer.byteLength(text) !== response.budget.bytes ||
        response.budget.count > registration.budget_tokens ||
        response.budget.bytes > response.budget.byte_limit
      )
        throw new Error("Budget mismatch");
      verifiedPayloads++;
      for (const item of response.items) {
        const file = view.files.get(item.reference.path);
        if (
          !file ||
          file.hash !== item.reference.content_hash ||
          file.text
            .split("\n")
            .slice(item.reference.start_line - 1, item.reference.end_line)
            .join("\n") !== item.excerpt
        )
          throw new Error("Source provenance mismatch");
        verifiedExcerpts++;
      }
      result[variant].metrics = relevanceMetrics(response, label, view);
    }
    rows.push(result);
    await writeFile(
      join(output, label.id + ".json"),
      JSON.stringify({ result, responses }, null, 2) + "\n",
    );
    if (!negative.some((row) => row.repository === result.repository)) {
      const response = await context(workspace, "zzzxqvnonce62837", {
        encoding: registration.encoding,
        lexical_version: "v2",
      });
      negative.push({
        repository: result.repository,
        status: response.status,
        items: response.items.length,
      });
    }
    console.log(
      JSON.stringify({
        id: label.id,
        v1_span: result.v1.metrics.source_span_hit,
        v2_span: result.v2.metrics.source_span_hit,
        v1_ms: result.v1.timings_ms,
        v2_ms: result.v2.timings_ms,
        v1_counter_calls: result.v1.counter_calls[0],
        v2_counter_calls: result.v2.counter_calls[0],
      }),
    );
    await writeFile(
      join(output, "progress.json"),
      JSON.stringify({ run_id: runId, rows }, null, 2) + "\n",
    );
  }
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify({ error: error.message, completed: rows.length }, null, 2) +
      "\n",
  );
  throw error;
} finally {
  counter.count = originalCount;
}
const overall = {
  v1: aggregateRelevance(rows, "v1"),
  v2: aggregateRelevance(rows, "v2"),
};
const spanLosses = rows
    .filter(
      (row) =>
        row.v1.metrics.source_span_hit && !row.v2.metrics.source_span_hit,
    )
    .map((row) => row.id),
  spanGains = rows
    .filter(
      (row) =>
        !row.v1.metrics.source_span_hit && row.v2.metrics.source_span_hit,
    )
    .map((row) => row.id);
const decision =
  overall.v2.source_span_hits >= overall.v1.source_span_hits &&
  overall.v2.mean_source_span_recall >= overall.v1.mean_source_span_recall &&
  overall.v2.warm_p95_ms < overall.v1.warm_p95_ms
    ? "retain_v2"
    : "retain_v1";
const report = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  run_id: runId,
  registration,
  runtime: process.version,
  platform: {
    system: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    memory_bytes: os.totalmem(),
  },
  tokenizer_initialization_ms: tokenizerInit,
  process_peak_rss_kib: process.resourceUsage().maxRSS,
  all_v1_controls_byte_identical: true,
  verified_payloads: verifiedPayloads,
  verified_source_excerpts: verifiedExcerpts,
  overall,
  decision,
  span_gains: spanGains,
  span_losses: spanLosses,
  lost_source_file_hits: rows
    .filter(
      (row) =>
        row.v1.metrics.source_file_hit && !row.v2.metrics.source_file_hit,
    )
    .map((row) => row.id),
  negative_controls: negative,
  by_category: Object.fromEntries(
    [...new Set(rows.map((row) => row.category))].map((category) => [
      category,
      {
        v1: aggregateRelevance(
          rows.filter((row) => row.category === category),
          "v1",
        ),
        v2: aggregateRelevance(
          rows.filter((row) => row.category === category),
          "v2",
        ),
      },
    ]),
  ),
  rows,
};
await writeFile(
  join(output, "summary.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(root, "eval/summaries/lexical-refinement.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    overall,
    decision,
    span_gains: spanGains,
    span_losses: spanLosses,
    output,
  }),
);
