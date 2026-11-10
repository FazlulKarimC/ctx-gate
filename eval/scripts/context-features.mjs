import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { context, captureWorktree, renderResult } from "../../dist/index.js";
import { tokenCounter } from "../../dist/retrieval/budget.js";
import { relevanceMetrics, mean, percentile } from "./relevance-metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  sha = (data) => createHash("sha256").update(data).digest("hex");
const json = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const save = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
};
const registrationPath = join(root, "eval/manifests/context-features.json");
const recipes = {
  picomatch: {
    title: "Public glob API compatibility",
    scopes: ["lib/**"],
    rationale:
      "The pre-fix README documents glob matching, parsing, scanning and options as public behavior. Preserve documented behavior across these interfaces.",
    body: "Evaluation-only research note summarizing pre-fix README content. Picomatch exposes matching, parse and scan interfaces with glob options and Bash-style features. This note adds no task-specific helper or future fix. Its reviewer is the implementation agent, not an upstream maintainer or independent human reviewer.",
  },
  "json-server": {
    title: "Documented JSON resource interface",
    scopes: ["src/**"],
    rationale:
      "The pre-fix README describes a JSON-backed REST resource API and query parameters. Preserve documented resource and query behavior when changing implementation.",
    body: "Evaluation-only research note summarizing pre-fix README content. JSON Server presents array and object resources over HTTP and documents filtering, sorting and pagination. This note adds no task-specific helper or future fix. Its reviewer is the implementation agent, not an upstream maintainer or independent human reviewer.",
  },
  fastify: {
    title: "Documented extension interface",
    scopes: ["lib/**", "fastify.js"],
    rationale:
      "The pre-fix README describes routes and extension through hooks, plugins and decorators. Preserve documented extension behavior when changing implementation.",
    body: "Evaluation-only research note summarizing pre-fix README content. Fastify exposes a web framework with route handling and extension interfaces. This note adds no task-specific helper or future fix. Its reviewer is the implementation agent, not an upstream maintainer or independent human reviewer.",
  },
};
async function files(path) {
  const result = [];
  for (const entry of await readdir(join(root, path), {
    withFileTypes: true,
  })) {
    const name = path + "/" + entry.name;
    if (entry.isDirectory()) result.push(...(await files(name)));
    else result.push(name);
  }
  return result.sort();
}
const inputs = [
  ...(await files("src")),
  ...(await files("tests")),
  ...(await files("eval/scripts")),
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".npmrc",
  "eval/manifests/context-feature-policy.json",
  "eval/manifests/corpus.json",
  "eval/manifests/agent-pool.json",
  "eval/labels/candidate-review.json",
  "eval/labels/development-retrieval.json",
];
const hashes = Object.fromEntries(
  await Promise.all(
    inputs.map(async (path) => [path, sha(await readFile(join(root, path)))]),
  ),
);
if (process.argv.includes("--register")) {
  await save(registrationPath, {
    schema_version: 1,
    registered_at: new Date().toISOString(),
    version: "context-features-v1",
    source_hashes: hashes,
    recipes,
    budgets: [1000, 2000, 4000],
    encoding: "o200k_base",
    repetitions: 1,
    order:
      "Rotate L/G/N/GN by case index plus budget index. One warm observation per case/arm/budget; timings descriptive, no inferential speed claim.",
    required_control:
      "Before creating new note-present study copies, all 20 original v2 replies must be byte-identical. Original roots and traces stay untouched.",
    note_provenance:
      "Three fixed repo-level researcher recipes based on pre-fix README inspection, not task symptoms/patches. Author/reviewer: implementation agent. Active authoring/review minutes unavailable; automatic instantiation time measured separately. These generic summaries cannot establish hidden-rationale usefulness.",
    model_calls: 0,
    holdout_queries: 0,
    no_post_result_tuning: true,
  });
  console.log("Registered context-feature study before queries");
  process.exit(0);
}
const registration = await json("eval/manifests/context-features.json");
if (
  JSON.stringify(registration.source_hashes) !== JSON.stringify(hashes) ||
  JSON.stringify(registration.recipes) !== JSON.stringify(recipes)
)
  throw Error(
    "Frozen study source changed; do not overwrite registration after seeing results",
  );
const labels = (await json("eval/labels/development-retrieval.json")).tasks,
  corpus = await json("eval/manifests/corpus.json");
if (
  labels.length !== 20 ||
  labels.some(
    (label) =>
      !corpus.tasks.some(
        (task) => task.id === label.id && task.split === "development",
      ),
  )
)
  throw Error("Fixed development diagnostics only");
const baseline = await json("eval/summaries/lexical-baseline.json"),
  refinement = await json("eval/summaries/lexical-refinement.json");
const runId = new Date().toISOString().replace(/[:.]/g, "-"),
  output = join(root, "eval/runs/context-features", runId);
await mkdir(output, { recursive: true });
await save(join(output, "registration.json"), registration);
for (const path of inputs) {
  const target = join(output, "source", path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, path), target, { errorOnExist: true, force: false });
}
const counter = await tokenCounter(registration.encoding),
  rows = [];
let verifiedPayloads = 0,
  verifiedExcerpts = 0,
  controls = 0;
const arms = {
  L: {},
  G: { neighbors: true },
  N: { notes: true },
  GN: { neighbors: true, notes: true },
};
function labeledLines(result, label) {
  const set = new Set();
  for (const span of label.source_spans)
    for (let line = span.start_line; line <= span.end_line; line++)
      if (
        result.items.some(
          (item) =>
            item.reference.path === span.path &&
            item.reference.start_line <= line &&
            line <= item.reference.end_line,
        )
      )
        set.add(span.path + ":" + line);
  return set;
}
for (let index = 0; index < labels.length; index++) {
  const label = labels[index],
    task = corpus.tasks.find((task) => task.id === label.id),
    original = join(root, "eval/.cache/retrieval", baseline.run_id, label.id);
  const control = await context(original, label.prompt, {
    budget_tokens: 2000,
    encoding: registration.encoding,
    lexical_version: "v2",
  });
  const saved = await json(
    "eval/runs/lexical-refinement/" +
      refinement.run_id +
      "/" +
      label.id +
      ".json",
  );
  if (renderResult(control) !== renderResult(saved.responses.v2))
    throw Error("v2 control drift: " + label.id);
  controls++;
  const workspace = join(root, "eval/.cache/context-features", runId, label.id);
  await mkdir(dirname(workspace), { recursive: true });
  await cp(original, workspace, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => {
      const local = relative(original, path).split(sep).join("/");
      return ![".ctx/cache", "node_modules", ".git"].some(
        (skip) => local === skip || local.startsWith(skip + "/"),
      );
    },
  });
  const recipe = recipes[task.repository];
  if (!recipe) throw Error("Unknown repo recipe");
  const startNote = performance.now(),
    readme = await readFile(join(workspace, "README.md"));
  const front = {
    id: "research-readme-contract",
    title: recipe.title,
    review_status: "accepted",
    scopes: recipe.scopes,
    rationale: recipe.rationale,
    reviewer: "ctxgate-evaluation-review (implementation agent)",
    last_reviewed_revision: task.base_commit,
    evidence: [{ path: "README.md", content_hash: sha(readme) }],
  };
  const note =
    "---\n" +
    Object.entries(front)
      .map(([key, value]) => key + ": " + JSON.stringify(value))
      .join("\n") +
    "\n---\n" +
    recipe.body +
    "\n";
  await writeFile(
    join(workspace, ".ctx/notes/research-readme-contract.md"),
    note,
  );
  const authoringMs = performance.now() - startNote,
    view = captureWorktree(workspace).view;
  // Warm the shared generation and tokenizer before descriptive response timings.
  await context(workspace, label.prompt, {
    budget_tokens: 2000,
    encoding: registration.encoding,
  });
  for (
    let budgetIndex = 0;
    budgetIndex < registration.budgets.length;
    budgetIndex++
  ) {
    const budget = registration.budgets[budgetIndex],
      responses = {},
      armRows = {};
    const order = Object.keys(arms),
      rotation = (index + budgetIndex) % order.length;
    order.push(...order.splice(0, rotation));
    for (const arm of order) {
      const start = performance.now(),
        response = await context(workspace, label.prompt, {
          ...arms[arm],
          budget_tokens: budget,
          encoding: registration.encoding,
          lexical_version: "v2",
        }),
        elapsed = performance.now() - start;
      const rendered = renderResult(response);
      if (
        response.view_id !== view.id ||
        response.budget.count !== counter.count(rendered) ||
        response.budget.bytes !== Buffer.byteLength(rendered) ||
        response.budget.count > budget ||
        response.budget.bytes > response.budget.byte_limit
      )
        throw Error("Envelope/view budget invalid");
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
          throw Error("Excerpt provenance invalid");
        if (
          item.note &&
          (item.excerpt !== note || item.note.freshness !== "current")
        )
          throw Error("Atomic/fresh note invalid");
        verifiedExcerpts++;
      }
      if (
        !arms[arm].notes &&
        response.items.some((item) => item.note || item.kind === "note")
      )
        throw Error("Notes leaked into control");
      verifiedPayloads++;
      responses[arm] = response;
      armRows[arm] = {
        metrics: relevanceMetrics(response, label, view),
        elapsed_ms: elapsed,
        neighbors: response.items.filter((item) => item.relationship).length,
        notes: response.items.filter((item) => item.note).length,
        omitted_notes: response.omitted_notes?.length ?? 0,
        graph: response.features?.neighbors ?? null,
      };
    }
    const originalLines = labeledLines(responses.L, label);
    for (const arm of Object.keys(arms)) {
      const selected = labeledLines(responses[arm], label);
      armRows[arm].added_labeled_lines = [...selected].filter(
        (line) => !originalLines.has(line),
      );
      armRows[arm].displaced_labeled_lines = [...originalLines].filter(
        (line) => !selected.has(line),
      );
    }
    const row = {
      id: label.id,
      repository: task.repository,
      category: label.category,
      budget,
      view_id: view.id,
      note_sha256: sha(note),
      automatic_note_instantiation_ms: authoringMs,
      arms: armRows,
    };
    rows.push(row);
    await save(join(output, label.id + "-" + budget + ".json"), {
      row,
      responses,
    });
  }
  console.log(label.id + " verified (" + verifiedPayloads + " payloads)");
}
const aggregates = [];
for (const budget of registration.budgets)
  for (const arm of Object.keys(arms)) {
    const selected = rows.filter((row) => row.budget === budget),
      data = selected.map((row) => row.arms[arm]);
    aggregates.push({
      budget,
      arm,
      n: data.length,
      file_hits: data.filter((row) => row.metrics.source_file_hit).length,
      span_hits: data.filter((row) => row.metrics.source_span_hit).length,
      mean_span_recall: mean(data.map((row) => row.metrics.source_span_recall)),
      mean_labeled_line_recall: mean(
        data.map((row) => row.metrics.labeled_source_line_recall),
      ),
      mean_tokens: mean(data.map((row) => row.metrics.budget_count)),
      warm_p50_ms: percentile(
        data.map((row) => row.elapsed_ms),
        0.5,
      ),
      warm_p95_ms: percentile(
        data.map((row) => row.elapsed_ms),
        0.95,
      ),
      neighbor_items: data.reduce((n, row) => n + row.neighbors, 0),
      note_items: data.reduce((n, row) => n + row.notes, 0),
      omitted_notes: data.reduce((n, row) => n + row.omitted_notes, 0),
      added_labeled_lines: data.reduce(
        (n, row) => n + row.added_labeled_lines.length,
        0,
      ),
      displaced_labeled_lines: data.reduce(
        (n, row) => n + row.displaced_labeled_lines.length,
        0,
      ),
    });
  }
const summary = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  run_id: runId,
  registration,
  platform: {
    node: process.version,
    os: os.type(),
    release: os.release(),
    cpu: os.cpus()[0]?.model,
  },
  verified_controls: controls,
  verified_payloads: verifiedPayloads,
  verified_excerpts: verifiedExcerpts,
  aggregates,
  rows,
  limitations: [
    "Dependent public diagnostic cases, incomplete contextual overlap labels, all tasks have a local source answer; one is a feature case. Not independent behavioral success trials.",
    "One warm observation per arm/task/budget, sequential rotating order with uncontrolled filesystem/OS caches. Descriptive timings only.",
    "Generic researcher notes repeat pre-fix documentation. Source-overlap labels cannot measure decision rationale usefulness; human authoring/review minutes unavailable.",
    "Original roots preserved. Note-present copied roots shared by all arms; view changes from adding note mean new L is not byte-identical to original L, while source rankings remain isolated from note FTS statistics.",
    "No paid/model or holdout calls. Defaults remain lexical-only, both features opt-in. No post-result tuning.",
  ],
};
await save(join(output, "summary.json"), summary);
await save(join(root, "eval/summaries/context-features.json"), summary);
console.log(
  JSON.stringify(
    {
      run_id: runId,
      verified_controls: controls,
      verified_payloads: verifiedPayloads,
      verified_excerpts: verifiedExcerpts,
      aggregates,
    },
    null,
    2,
  ),
);
