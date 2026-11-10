// A correctness follow-up, not another tuned retrieval proposal or timing study.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  context,
  captureWorktree,
  normalizeQuery,
  renderResult,
} from "../../dist/index.js";
import { retrievalInternals } from "../../dist/retrieval/index.js";
import { neighbors } from "../../dist/retrieval/neighbors.js";
import { readNotes } from "../../dist/notes/index.js";
import { IndexStore } from "../../dist/store/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  sha = (data) => createHash("sha256").update(data).digest("hex");
const json = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const summary = await json("eval/summaries/context-features.json"),
  frozen = join(root, "eval/runs/context-features", summary.run_id, "source");
const allowedChanges = [
    "src/notes/index.ts",
    "src/retrieval/neighbors.ts",
    "tests/features.test.mjs",
  ],
  changes = [];
for (const [path, hash] of Object.entries(summary.registration.source_hashes))
  if (sha(await readFile(join(root, path))) !== hash) changes.push(path);
assert.deepEqual(
  changes.sort(),
  allowedChanges.sort(),
  "Only the documented note-boundary correction and regression may change",
);
async function files(path) {
  const all = [];
  for (const entry of await readdir(join(root, path), {
    withFileTypes: true,
  })) {
    const local = path + "/" + entry.name;
    if (entry.isDirectory()) all.push(...(await files(local)));
    else all.push(local);
  }
  return all.sort();
}
const paths = [
  ...(await files("src")),
  "tests/features.test.mjs",
  "eval/scripts/verify-context-guard.mjs",
];
const hashes = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => [path, sha(await readFile(join(root, path)))]),
  ),
);
const manifestPath = join(root, "eval/manifests/context-note-guard.json");
const manifest = {
  schema_version: 1,
  registered_at: new Date().toISOString(),
  frozen_run: summary.run_id,
  reason:
    "Regression reproduced a resolved TS import into .ctx/notes bypassing notes opt-in. Exclude note paths from graph selection/degree and accept only Markdown note files. No ranking, cap, interleaving or budget retuning.",
  changes,
  source_hashes: hashes,
  verification:
    "Compare complete lexical/graph candidate pools and parsed note data in every original study view under frozen and corrected modules. Replay all 80 default-budget payloads exactly. Candidate equivalence plus unchanged packing/budget modules covers the three original allowances; original timings remain those of the frozen implementation.",
};
if (process.argv.includes("--register")) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  console.log("Registered isolated correctness follow-up");
  process.exit(0);
}
const registered = await json("eval/manifests/context-note-guard.json");
assert.deepEqual(registered.source_hashes, hashes);
assert.equal(registered.frozen_run, summary.run_id);
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/typescript/bin/tsc"),
    "--project",
    join(frozen, "tsconfig.json"),
  ],
  { stdio: "pipe" },
);
const oldRetrieval = await import(
    pathToFileURL(join(frozen, "dist/retrieval/index.js")).href
  ),
  oldGraph = await import(
    pathToFileURL(join(frozen, "dist/retrieval/neighbors.js")).href
  ),
  oldNotes = await import(
    pathToFileURL(join(frozen, "dist/notes/index.js")).href
  );
const labels = (await json("eval/labels/development-retrieval.json")).tasks;
let pools = 0,
  noteSets = 0,
  replayed = 0;
const serialized = (parsed) => ({
  ...parsed,
  notes: parsed.notes.map((note) => ({
    ...note,
    scopes: note.scopes.map((scope) => scope.pattern),
  })),
});
for (const label of labels) {
  const workspace = join(
      root,
      "eval/.cache/context-features",
      summary.run_id,
      label.id,
    ),
    view = captureWorktree(workspace).view,
    query = normalizeQuery(label.prompt),
    store = new IndexStore(workspace);
  try {
    const lexical = retrievalInternals.candidates(store.db, query, "v2"),
      oldLexical = oldRetrieval.retrievalInternals.candidates(
        store.db,
        query,
        "v2",
      );
    assert.deepEqual(lexical, oldLexical);
    assert.deepEqual(
      neighbors(store.db, lexical, query, true, label.prompt),
      oldGraph.neighbors(store.db, oldLexical, query, true, label.prompt),
    );
    pools++;
    const sources = [...view.files.values()]
      .filter((file) => file.path.toLowerCase().startsWith(".ctx/notes/"))
      .map((file) => ({
        path: file.path,
        text: file.text,
        content_hash: file.hash,
      }));
    assert.ok(sources.every((file) => file.path.toLowerCase().endsWith(".md")));
    const binding = (path) => {
      const file = store.db
        .prepare(
          "SELECT content_hash FROM files WHERE path=? AND kind!='metadata' AND lower(path) NOT LIKE '.ctx/notes/%'",
        )
        .get(path);
      return file
        ? {
            ...file,
            hasSymbol: (name) =>
              Boolean(
                store.db
                  .prepare(
                    "SELECT 1 FROM symbols WHERE path=? AND name=? LIMIT 1",
                  )
                  .get(path, name),
              ),
          }
        : undefined;
    };
    assert.deepEqual(
      serialized(readNotes(sources, binding, view.case_sensitive)),
      serialized(oldNotes.readNotes(sources, binding, view.case_sensitive)),
    );
    noteSets++;
  } finally {
    store.close();
  }
  const saved = await json(
    "eval/runs/context-features/" +
      summary.run_id +
      "/" +
      label.id +
      "-2000.json",
  );
  for (const [arm, options] of Object.entries({
    L: {},
    G: { neighbors: true },
    N: { notes: true },
    GN: { neighbors: true, notes: true },
  })) {
    const result = await context(workspace, label.prompt, {
      ...options,
      budget_tokens: 2000,
      encoding: "o200k_base",
      lexical_version: "v2",
    });
    assert.equal(
      renderResult(result),
      renderResult(saved.responses[arm]),
      label.id + " " + arm,
    );
    replayed++;
  }
  console.log(label.id + " guard equivalence verified");
}
const result = {
  schema_version: 1,
  verified_at: new Date().toISOString(),
  registration: registered,
  lexical_and_graph_pools_equal: pools,
  parsed_note_sets_equal: noteSets,
  byte_identical_default_budget_payloads: replayed,
  original_sweep_payloads: summary.verified_payloads,
  timing_remeasured: false,
  tests:
    "Regression failed before correction; full npm run check after correction recorded separately",
};
await writeFile(
  join(root, "eval/summaries/context-note-guard.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify({ pools, noteSets, replayed }));
