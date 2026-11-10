import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { existsSync } from "node:fs";
import {
  initialize,
  context,
  captureWorktree,
  normalizeQuery,
} from "../../dist/index.js";
import { retrievalInternals } from "../../dist/retrieval/index.js";
import { responseBudget, tokenCounter } from "../../dist/retrieval/budget.js";
import { exportTree } from "./git-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const corpus = await readJson(join(root, "eval/manifests/corpus.json"));
const labelPath = join(root, "eval/labels/development-retrieval.json");
const labels = await readJson(labelPath),
  registration = await readJson(join(root, "eval/manifests/lexical-v1.json"));
if (
  labels.tasks.length !== 20 ||
  labels.tasks.some(
    (label) =>
      !corpus.tasks.some(
        (task) => task.id === label.id && task.split === "development",
      ),
  )
)
  throw new Error(
    "Require the 20 registered development candidates; never query holdout",
  );
const labelHash = hash(await readFile(labelPath)),
  configurationHash = hash(JSON.stringify(registration));
const preparedIndex = process.argv.indexOf("--prepared");
let preparation;
if (preparedIndex >= 0)
  preparation = await readJson(resolve(process.argv[preparedIndex + 1]));
else {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const output = join(root, "eval/runs/retrieval", runId);
  await mkdir(output, { recursive: true });
  const tasks = [];
  for (const label of labels.tasks) {
    const task = corpus.tasks.find((task) => task.id === label.id),
      workspace = join(root, "eval/.cache/retrieval", runId, task.id);
    const start = performance.now();
    const exported = await exportTree(
      join(root, "eval/.cache/upstream", task.repository),
      task.base_commit,
      workspace,
    );
    tasks.push({
      id: task.id,
      repository: task.repository,
      base_commit: task.base_commit,
      workspace,
      exported,
      preparation_ms: performance.now() - start,
    });
  }
  preparation = {
    schema_version: 1,
    run_id: runId,
    output,
    label_hash: labelHash,
    configuration_hash: configurationHash,
    tasks,
  };
  await writeFile(
    join(output, "prepared.json"),
    JSON.stringify(preparation, null, 2) + "\n",
  );
}
if (
  preparation.label_hash !== labelHash ||
  preparation.configuration_hash !== configurationHash
)
  throw new Error("Labels/config changed after preparation; prepare a new run");
// Post-study guard revision; original measurements/runner remain archived.
if (
  !/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(preparation.run_id) ||
  resolve(preparation.output) !==
    join(root, "eval/runs/retrieval", preparation.run_id)
)
  throw new Error("Prepared output must stay in this evaluation run directory");
if (
  preparation.tasks.length !== 20 ||
  new Set(preparation.tasks.map((task) => task.id)).size !== 20
)
  throw new Error(
    "Require exactly 20 distinct prepared development candidates",
  );
for (const task of preparation.tasks) {
  const registered = corpus.tasks.find(
    (row) => row.id === task.id && row.split === "development",
  );
  if (
    !registered ||
    registered.base_commit !== task.base_commit ||
    registered.repository !== task.repository ||
    resolve(task.workspace) !==
      join(root, "eval/.cache/retrieval", preparation.run_id, task.id)
  )
    throw new Error(
      "Prepared workspace does not match the registered isolated pre-fix task",
    );
  if (existsSync(join(task.workspace, ".ctx/cache/index.sqlite")))
    throw new Error(
      "Prepared workspace is already indexed; prepare fresh workspaces for a cold study",
    );
}
for (const [path, expected] of Object.entries(
  registration.source_hashes ?? {},
)) {
  if (path === "eval/scripts/retrieval-study.mjs") continue;
  if (hash(await readFile(join(root, path))) !== expected)
    throw new Error(
      "Frozen production input changed: " +
        path +
        "; register a new comparison version",
    );
}
const invalid = [];
for (const task of preparation.tasks) {
  const label = labels.tasks.find((label) => label.id === task.id);
  for (const span of label.source_spans) {
    const lines = (
      await readFile(join(task.workspace, span.path), "utf8")
    ).split("\n");
    if (
      span.start_line < 1 ||
      span.end_line > lines.length ||
      span.start_line > span.end_line
    )
      invalid.push({ task: task.id, ...span, file_lines: lines.length });
  }
}
console.log(
  JSON.stringify({
    prepared: join(preparation.output, "prepared.json"),
    invalid_spans: invalid,
  }),
);
if (invalid.length || process.argv.includes("--prepare-only"))
  process.exit(invalid.length ? 2 : 0);

function measure(result, label, view) {
  const sourceFiles = new Set(label.source_spans.map((span) => span.path));
  const usefulFiles = new Set([
    ...sourceFiles,
    ...label.existing_tests.filter((path) => view.fileExists(path)),
  ]);
  const overlaps = (a, b) =>
    a.path === b.path &&
    a.start_line <= b.end_line &&
    b.start_line <= a.end_line;
  const refs = result.items.map((item) => item.reference);
  const hitSpans = label.source_spans.filter((span) =>
    refs.some((ref) => overlaps(span, ref)),
  );
  const lines = new Set(),
    found = new Set();
  for (const span of label.source_spans)
    for (let line = span.start_line; line <= span.end_line; line++) {
      const key = span.path + ":" + line;
      lines.add(key);
      if (
        refs.some(
          (ref) =>
            ref.path === span.path &&
            ref.start_line <= line &&
            ref.end_line >= line,
        )
      )
        found.add(key);
    }
  return {
    source_file_hit: refs.some((ref) => sourceFiles.has(ref.path)),
    source_span_hit: hitSpans.length > 0,
    source_span_recall: hitSpans.length / label.source_spans.length,
    labeled_source_line_recall: found.size / lines.size,
    labeled_useful_file_precision: refs.length
      ? refs.filter((ref) => usefulFiles.has(ref.path)).length / refs.length
      : null,
    item_count: refs.length,
    no_match: result.status === "no_match",
    budget_count: result.budget.count,
    bytes: result.budget.bytes,
    coverage_complete: result.coverage.complete,
    selected_spans: refs.map(({ path, start_line, end_line }) => ({
      path,
      start_line,
      end_line,
    })),
  };
}
function liveCandidates(view, query) {
  if (!query.terms.length) return [];
  const files = [...view.files.values()]
    .filter(
      (file) =>
        file.kind !== "metadata" &&
        !file.path.toLowerCase().startsWith(".ctx/notes/"),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hits = [];
  for (let offset = 0; offset < files.length; offset += 64) {
    const group = files.slice(offset, offset + 64);
    const args = [
      "--json",
      "--no-ignore",
      "--hidden",
      "--fixed-strings",
      "--ignore-case",
      ...query.terms.flatMap((term) => ["-e", term]),
      "--",
      ...group.map((file) => file.path),
    ];
    const run = spawnSync("rg", args, {
      cwd: view.root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error || ![0, 1].includes(run.status))
      throw new Error(
        "Live-search infrastructure failure: " +
          (run.error?.message ?? run.stderr),
      );
    for (const line of run.stdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "match")
        hits.push({
          path: event.data.path.text.replaceAll("\\", "/"),
          line: event.data.line_number,
        });
    }
  }
  hits.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line,
  );
  const perFile = new Map(),
    output = [];
  for (const hit of hits) {
    const prior = perFile.get(hit.path) ?? [];
    if (
      prior.length >= 2 ||
      prior.some((line) => Math.abs(hit.line - line) <= 17)
    )
      continue;
    const file = view.files.get(hit.path);
    if (!file)
      throw new Error("ripgrep returned a path outside the eligible view");
    const lineCount = file.text.split("\n").length;
    output.push({
      path: hit.path,
      content_hash: file.hash,
      kind: file.kind,
      start_line: 1,
      end_line: lineCount,
      file_end: lineCount,
      text: file.text,
      tier: 0,
      rank: 0,
      reason: "fixed live-text match",
      focus: hit.line,
    });
    prior.push(hit.line);
    perFile.set(hit.path, prior);
    if (output.length === 200) break;
  }
  return output;
}
const tokenizerStart = performance.now();
await tokenCounter(registration.tokenizer);
const tokenizerInit = performance.now() - tokenizerStart;
const rows = [],
  negativeControls = [];
for (const task of preparation.tasks) {
  const label = labels.tasks.find((label) => label.id === task.id);
  await initialize(task.workspace);
  const scan = captureWorktree(task.workspace),
    query = normalizeQuery(label.prompt);
  const t0 = performance.now(),
    cold = await context(task.workspace, label.prompt, {
      encoding: registration.tokenizer,
      budget_tokens: registration.budget_tokens,
    }),
    coldMs = performance.now() - t0;
  const warmMs = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const t = performance.now();
    const warm = await context(task.workspace, label.prompt, {
      encoding: registration.tokenizer,
      budget_tokens: registration.budget_tokens,
    });
    warmMs.push(performance.now() - t);
    if (JSON.stringify(warm) !== JSON.stringify(cold))
      throw new Error("Non-deterministic unchanged retrieval: " + task.id);
  }
  const liveStart = performance.now(),
    liveScan = captureWorktree(task.workspace),
    ranked = liveCandidates(liveScan.view, query);
  const { counter, budget } = await responseBudget(registration.budget_tokens, {
    encoding: registration.tokenizer,
  });
  const live = retrievalInternals.packResult(
    {
      schema_version: 1,
      operation: "context",
      root_id: retrievalInternals.rootId(liveScan.view.root),
      view_id: liveScan.view.id,
      generation: null,
      evidence_trust: "repository_data",
      status: "no_match",
      coverage: retrievalInternals.compactCoverage(liveScan.coverage),
      coverage_reason_count: liveScan.coverage.reasons.length,
      diagnostics: [],
      items: [],
      budget,
    },
    ranked,
    query,
    counter,
  );
  const liveMs = performance.now() - liveStart;
  const row = {
    id: task.id,
    repository: task.repository,
    category: label.category,
    base_commit: task.base_commit,
    source_spans: label.source_spans,
    cold_indexed_ms: coldMs,
    warm_indexed_ms: warmMs,
    live_text_ms: liveMs,
    R0: measure(live, label, scan.view),
    R1: measure(cold, label, scan.view),
  };
  rows.push(row);
  await writeFile(
    join(preparation.output, task.id + ".json"),
    JSON.stringify({ prompt: label.prompt, row, R0: live, R1: cold }, null, 2) +
      "\n",
  );
  if (
    !negativeControls.some((control) => control.repository === task.repository)
  ) {
    const result = await context(task.workspace, "zzzxqvnonce62837", {
      encoding: registration.tokenizer,
    });
    negativeControls.push({
      repository: task.repository,
      status: result.status,
      items: result.items.length,
    });
  }
  console.log(
    JSON.stringify({
      task: task.id,
      R0_span_hit: row.R0.source_span_hit,
      R1_span_hit: row.R1.source_span_hit,
      cold_ms: coldMs,
      warm_ms: warmMs,
      live_ms: liveMs,
    }),
  );
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
function aggregate(group) {
  return Object.fromEntries(
    ["R0", "R1"].map((condition) => [
      condition,
      {
        n: group.length,
        source_file_hits: group.filter((row) => row[condition].source_file_hit)
          .length,
        source_span_hits: group.filter((row) => row[condition].source_span_hit)
          .length,
        mean_source_span_recall: mean(
          group.map((row) => row[condition].source_span_recall),
        ),
        mean_labeled_line_recall: mean(
          group.map((row) => row[condition].labeled_source_line_recall),
        ),
        mean_labeled_file_precision: mean(
          group
            .filter(
              (row) => row[condition].labeled_useful_file_precision !== null,
            )
            .map((row) => row[condition].labeled_useful_file_precision),
        ),
        mean_counted_tokens: mean(
          group.map((row) => row[condition].budget_count),
        ),
      },
    ]),
  );
}
const report = {
  schema_version: 1,
  runner_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  created_at: new Date().toISOString(),
  registration,
  label_hash: labelHash,
  configuration_hash: configurationHash,
  run_id: preparation.run_id,
  runtime: process.version,
  platform: {
    system: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    memory_bytes: os.totalmem(),
  },
  tokenizer_initialization_ms: tokenizerInit,
  rg_version: spawnSync("rg", ["--version"], { encoding: "utf8" }).stdout.split(
    "\n",
  )[0],
  overall: aggregate(rows),
  by_repository: Object.fromEntries(
    [...new Set(rows.map((row) => row.repository))].map((repo) => [
      repo,
      aggregate(rows.filter((row) => row.repository === repo)),
    ]),
  ),
  by_category: Object.fromEntries(
    [...new Set(rows.map((row) => row.category))].map((category) => [
      category,
      aggregate(rows.filter((row) => row.category === category)),
    ]),
  ),
  negative_controls: negativeControls,
  process_peak_rss_kib: process.resourceUsage().maxRSS,
  rows,
};
await writeFile(
  join(preparation.output, "summary.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(root, "eval/summaries/lexical-baseline.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    summary: join(preparation.output, "summary.json"),
    overall: report.overall,
  }),
);
