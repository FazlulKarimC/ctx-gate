import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import {
  initialize,
  context,
  expand,
  refreshIndex,
  renderResult,
  normalizeQuery,
} from "../dist/index.js";
import { digest } from "../dist/workspace/snapshot.js";
import { IndexStore } from "../dist/store/index.js";
import { readNotes, selectNotes } from "../dist/notes/index.js";
import { neighbors } from "../dist/retrieval/neighbors.js";
import { retrievalInternals } from "../dist/retrieval/index.js";
import { tokenCounter } from "../dist/retrieval/budget.js";

async function fixture(t) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "features-"));
  t.after(async () => {
    const path = relative(parent, root);
    assert.ok(!path.startsWith("..") && !isAbsolute(path));
    await rm(root, { recursive: true, force: true });
  });
  await initialize(root);
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src/anchor.ts"),
    'import { storage } from "./dependency.js";\nimport type { Model } from "./model.js";\nexport function anchor() { return storage(); }\n',
  );
  await writeFile(
    join(root, "src/dependency.ts"),
    'import { second } from "./second.js";\nexport function storage() { return second(); }\n',
  );
  await writeFile(
    join(root, "src/model.ts"),
    "export interface Model { id: string }\n",
  );
  await writeFile(
    join(root, "src/second.ts"),
    "export function second() { return 1; }\n",
  );
  return root;
}
function markdown(id = "decision", extra = {}) {
  const data = {
    id,
    title: "Storage design",
    review_status: "accepted",
    scopes: ["src/**"],
    rationale: "Keep the documented storage contract.",
    reviewer: "test reviewer",
    last_reviewed_revision: "test revision",
    evidence: [],
    ...extra,
  };
  return (
    "---\n" +
    Object.entries(data)
      .map(([key, value]) => key + ": " + JSON.stringify(value))
      .join("\n") +
    "\n---\nStorage rationale is repository data.\n"
  );
}
async function note(root, text, name = "decision.md") {
  await writeFile(join(root, ".ctx/notes", name), text);
}
const source = (text, path = ".ctx/notes/note.md") => ({
  path,
  text,
  content_hash: digest(text),
});

test("note parsing bounds YAML, rejects duplicate identity, and keeps review separate from freshness", () => {
  const hash = digest("current");
  assert.equal(
    readNotes([source(markdown(), ".ctx/notes/invalid.ts")], () => undefined)
      .invalid,
    1,
  );
  const binding = (path) =>
    path === "src/a.ts"
      ? { content_hash: hash, hasSymbol: (name) => name === "present" }
      : undefined;
  for (const [evidence, state] of [
    [[], "unbound"],
    [[{ path: "src/a.ts", content_hash: hash, symbol: "present" }], "current"],
    [[{ path: "src/a.ts", content_hash: digest("old") }], "needs_review"],
    [[{ path: "src/gone.ts", content_hash: hash }], "target_missing"],
    [
      [{ path: "src/a.ts", content_hash: hash, symbol: "unknown" }],
      "needs_review",
    ],
  ]) {
    const parsed = readNotes([source(markdown("n", { evidence }))], binding);
    assert.equal(parsed.invalid, 0);
    assert.equal(parsed.notes[0].metadata.freshness, state);
    assert.equal(parsed.notes[0].data.review_status, "accepted");
  }
  const accepted = markdown(),
    proposed = markdown("p", { review_status: "proposed" }),
    deprecated = markdown("d", { review_status: "deprecated" });
  const all = readNotes(
    [
      source(accepted),
      source(proposed, ".ctx/notes/p.md"),
      source(deprecated, ".ctx/notes/d.md"),
    ],
    binding,
  );
  assert.ok(
    all.notes
      .filter((note) => note.data.review_status !== "accepted")
      .every((note) => note.metadata === undefined),
  );
  assert.deepEqual(
    selectNotes(
      all.notes,
      normalizeQuery("storage"),
      ["src/a.ts"],
      ["src/a.ts"],
    ).notes.map((n) => n.data.id),
    ["decision"],
  );
  for (const text of [
    accepted.replace("title:", "id: duplicate\ntitle:"),
    accepted.replace('title: "Storage design"', "title: &alias [*alias]"),
    accepted.replace('title: "Storage design"', "title: !custom value"),
    accepted.replace('scopes: ["src/**"]', 'scopes: ["../**"]'),
    "---\nid: bad\n---\n",
    accepted + "x".repeat(65536),
  ])
    assert.equal(readNotes([source(text)], binding).invalid, 1);
  const duplicates = readNotes(
    [source(accepted), source(accepted, ".ctx/notes/other.md")],
    binding,
  );
  assert.equal(duplicates.invalid, 2);
  assert.equal(duplicates.notes.length, 0);
  assert.equal(
    readNotes(
      Array.from({ length: 101 }, (_, i) =>
        source(markdown("n" + i), ".ctx/notes/" + i + ".md"),
      ),
      binding,
    ).limited,
    true,
  );
});

test("note scopes do not promote unrelated generic rationale", () => {
  const parsed = readNotes(
    [
      source(markdown("generic", { scopes: ["**"] })),
      source(
        markdown("specific", { scopes: ["src/ui/**"] }),
        ".ctx/notes/s.md",
      ),
    ],
    () => undefined,
  );
  assert.equal(
    selectNotes(
      parsed.notes,
      normalizeQuery("unrelated"),
      ["src/ui/view.ts"],
      ["src/ui/view.ts"],
    ).notes[0].data.id,
    "specific",
  );
  assert.equal(
    selectNotes(parsed.notes, normalizeQuery("storage"), [], ["src/ui/view.ts"])
      .notes.length,
    2,
  );
  assert.equal(
    selectNotes(
      parsed.notes,
      normalizeQuery("unrelated"),
      ["lib/x.ts"],
      ["lib/x.ts"],
    ).notes.length,
    0,
  );
});

test("one-hop expansion preserves edge kind, excludes second hops, and is independently optional", async (t) => {
  const root = await fixture(t),
    query = "symbol:anchor";
  const control = await context(root, query, { budget_tokens: 4000 });
  assert.equal(control.features, undefined);
  assert.ok(control.items.every((item) => !item.relationship && !item.note));
  const graph = await context(root, query, {
    neighbors: true,
    budget_tokens: 4000,
  });
  assert.ok(
    graph.items.some(
      (item) =>
        item.reference.path === "src/dependency.ts" &&
        item.relationship.edge_kind === "runtime",
    ),
  );
  assert.ok(
    graph.items.some(
      (item) =>
        item.reference.path === "src/model.ts" &&
        item.relationship.edge_kind === "type_only",
    ),
  );
  assert.ok(
    !graph.items.some((item) => item.reference.path === "src/second.ts"),
  );
  assert.equal(
    renderResult(
      await context(root, query, {
        neighbors: false,
        notes: false,
        budget_tokens: 4000,
      }),
    ),
    renderResult(control),
  );
  const cli = spawnSync(
    process.execPath,
    [
      "dist/cli/index.js",
      "context",
      "--root",
      root,
      "--query",
      query,
      "--neighbors",
      "--budget",
      "4000",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(JSON.parse(cli.stdout).features.neighbors);
});

test("high-degree incoming expansion ranks relevant late importers before scan caps and suppresses unmatched hubs", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 205; i++)
    await writeFile(
      join(root, "src/a" + String(i).padStart(3, "0") + ".ts"),
      'import { anchor } from "./anchor.js"; export const value = anchor();\n',
    );
  await writeFile(
    join(root, "src/z-relevant.ts"),
    'import { anchor } from "./anchor.js"; export const cancellationTimeout = anchor();\n',
  );
  refreshIndex(root);
  const store = new IndexStore(root);
  try {
    const seed = retrievalInternals
      .candidates(store.db, normalizeQuery("path:src/anchor.ts"), "v2")
      .slice(0, 1);
    const relevant = neighbors(
      store.db,
      seed,
      normalizeQuery("path:src/anchor.ts cancellation timeout"),
      true,
      "cancellation timeout",
    );
    assert.ok(
      relevant.candidates.some(
        (row) =>
          row.path === "src/z-relevant.ts" &&
          row.relationship.direction === "incoming",
      ),
    );
    assert.equal(relevant.stats.high_degree_seeds, 1);
    assert.ok(relevant.stats.suppressed_unmatched >= 205);
    assert.ok(relevant.stats.capped);
    const ordinary = neighbors(
      store.db,
      seed,
      normalizeQuery("path:src/anchor.ts"),
      true,
      "",
    );
    assert.ok(
      ordinary.candidates.every(
        (row) => row.relationship.direction === "outgoing",
      ),
    );
    const usages = neighbors(
      store.db,
      seed,
      normalizeQuery("path:src/anchor.ts usages"),
      true,
      "usages",
    );
    assert.equal(usages.candidates[0].relationship.direction, "incoming");
    assert.ok(usages.candidates.length <= 20);
  } finally {
    store.close();
  }
});

test("notes stay out of lexical BM25 statistics, including legacy cache migration", async (t) => {
  const root = await fixture(t),
    query = normalizeQuery("storage anchor");
  refreshIndex(root);
  let store = new IndexStore(root),
    before;
  try {
    before = retrievalInternals.candidates(store.db, query, "v2");
  } finally {
    store.close();
  }
  await note(root, markdown() + "storage anchor ".repeat(500));
  refreshIndex(root);
  store = new IndexStore(root);
  try {
    assert.deepEqual(
      retrievalInternals.candidates(store.db, query, "v2"),
      before,
    );
    const row = store.db
      .prepare(
        "SELECT id,text,path FROM chunks WHERE path LIKE '.ctx/notes/%' LIMIT 1",
      )
      .get();
    store.db
      .prepare(
        "INSERT INTO chunk_search(rowid,exact_identifiers,subtokens,path,signature,body) VALUES(?,?,?,?,?,?)",
      )
      .run(row.id, "", "", row.path, "", row.text);
  } finally {
    store.close();
  }
  const migrated = refreshIndex(root);
  assert.equal(refreshIndex(root).generation, migrated.generation);
  store = new IndexStore(root);
  try {
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) n FROM chunk_search WHERE path LIKE '.ctx/notes/%'",
        )
        .get().n,
      0,
    );
    assert.deepEqual(
      retrievalInternals.candidates(store.db, query, "v2"),
      before,
    );
  } finally {
    store.close();
  }
});

test("import expansion cannot bypass the notes opt-in through source files in the notes directory", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, ".ctx/notes/hidden.ts"),
    "export const secretRationale = 42;\n",
  );
  await writeFile(
    join(root, "src/anchor.ts"),
    'import { secretRationale } from "../.ctx/notes/hidden.js";\nexport function anchor() { return secretRationale; }\n',
  );
  const result = await context(root, "symbol:anchor", {
    neighbors: true,
    budget_tokens: 4000,
  });
  assert.ok(
    result.items.every(
      (item) => !item.reference.path.toLowerCase().startsWith(".ctx/notes/"),
    ),
  );
});

test("atomic notes use the whole response budget and explicit expansion revalidates review and bindings", async (t) => {
  const root = await fixture(t),
    target = "src/dependency.ts",
    hash = digest(await readFile(join(root, target)));
  const text = markdown("decision", {
    evidence: [{ path: target, content_hash: hash, symbol: "storage" }],
  });
  await note(root, text);
  const counter = await tokenCounter("o200k_base");
  const full = await context(root, "path:src/anchor.ts storage", {
    notes: true,
    neighbors: true,
    budget_tokens: 4000,
    encoding: "o200k_base",
  });
  const item = full.items.find((item) => item.kind === "note");
  assert.ok(item);
  assert.equal(item.excerpt, text);
  assert.equal(item.note.freshness, "current");
  assert.equal(full.budget.count, counter.count(renderResult(full)));
  assert.equal(full.budget.bytes, Buffer.byteLength(renderResult(full)));
  assert.ok(full.budget.count <= 4000);
  assert.equal(
    (await expand(root, item.reference)).status,
    "unavailable_reference",
  );
  await writeFile(
    join(root, target),
    "export function storage() { return 9; }\n",
  );
  const fresh = await expand(root, item.reference, {
    notes: true,
    budget_tokens: 4000,
  });
  assert.equal(fresh.items[0].note.freshness, "needs_review");
  assert.equal(fresh.items[0].excerpt, text);
  await note(root, text.replace("repository data", "edited data"));
  assert.equal(
    (await expand(root, item.reference, { notes: true })).status,
    "stale_reference",
  );
  await note(root, text.replace('"accepted"', '"proposed"'));
  assert.equal(
    (await expand(root, item.reference, { notes: true })).status,
    "unavailable_reference",
  );
  await note(root, text + "Long rationale. ".repeat(1500));
  const omitted = await context(root, "path:src/anchor.ts storage", {
    notes: true,
    budget_tokens: 1000,
    encoding: "o200k_base",
  });
  assert.ok(!omitted.items.some((item) => item.kind === "note"));
  assert.equal(omitted.omitted_notes[0].id, "decision");
  assert.ok(omitted.budget.count <= 1000);
  const tooSmall = await expand(root, omitted.omitted_notes[0].reference, {
    notes: true,
    budget_tokens: 1000,
    encoding: "o200k_base",
  });
  assert.equal(tooSmall.status, "budget_too_small");
  assert.deepEqual(tooSmall.items, []);
});
