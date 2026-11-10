import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  context,
  expand,
  renderResult,
  normalizeQuery,
  ContextResultSchema,
  ExpandResultSchema,
} from "../dist/index.js";
import { tokenCounter } from "../dist/retrieval/budget.js";

async function fixture(t) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "retrieval-"));
  await cp(resolve("tests/fixtures/basic-project"), root, {
    recursive: true,
    filter: (path) => !path.includes(sep + "cache"),
  });
  t.after(async () => {
    const rel = relative(parent, root);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function accounted(result, counter) {
  const text = renderResult(result);
  assert.equal(result.budget.bytes, Buffer.byteLength(text));
  assert.equal(
    result.budget.count,
    counter ? counter.count(text) : Math.ceil(Buffer.byteLength(text) / 3),
  );
  assert.ok(result.budget.count <= result.budget.limit);
  assert.ok(result.budget.bytes <= result.budget.byte_limit);
}
async function exactExcerpts(root, result) {
  for (const item of result.items) {
    const lines = (
      await readFile(join(root, item.reference.path), "utf8")
    ).split("\n");
    assert.equal(
      item.excerpt,
      lines
        .slice(item.reference.start_line - 1, item.reference.end_line)
        .join("\n"),
    );
    assert.equal(item.omitted_before, item.reference.start_line > 1);
    assert.equal(item.omitted_after, item.reference.end_line < lines.length);
  }
}

test("query normalization splits identifiers, bounds terms, and treats FTS punctuation as data", () => {
  const query = normalizeQuery(
    'please find HTTPRequestHandler read_session symbol:readSession path:src/db/session.ts "session expired" OR NOT body:*',
  );
  assert.ok(
    query.terms.includes("http") &&
      query.terms.includes("request") &&
      query.terms.includes("handler"),
  );
  assert.ok(query.terms.includes("read") && query.terms.includes("session"));
  assert.ok(query.symbols.includes("readSession"));
  assert.ok(
    normalizeQuery("inspect Service.find and picomatch.scan").symbols.includes(
      "scan",
    ),
  );
  assert.deepEqual(query.paths, ["src/db/session.ts"]);
  assert.ok(query.phrases.includes("session expired"));
  assert.ok(!query.terms.includes("please"));
  const limited = normalizeQuery(
    Array.from({ length: 60 }, (_, i) => "term" + i).join(" "),
  );
  assert.equal(limited.terms.length, 32);
  assert.equal(limited.truncated, true);
  assert.throws(() => normalizeQuery(" "), /empty/);
  assert.throws(() => normalizeQuery("x".repeat(8193)), /8192/);
});

test("context ranks exact source anchors, returns real spans, accounts for its entire envelope and stays deterministic", async (t) => {
  const root = await fixture(t);
  const cold = await context(root, "symbol:readSession");
  assert.equal(cold.status, "ok");
  assert.equal(cold.items[0].reference.path, "src/db/session.ts");
  assert.equal(cold.items[0].reason, "exact symbol");
  assert.equal(cold.budget.limit, 2000);
  assert.equal(cold.budget.method, "estimate");
  assert.equal(ContextResultSchema.safeParse(cold).success, true);
  accounted(cold);
  await exactExcerpts(root, cold);
  const warm = await context(root, "symbol:readSession");
  assert.deepEqual(warm, cold);
  const path = await context(root, "path:src/services/session.ts");
  assert.equal(path.items[0].reference.path, "src/services/session.ts");
});

test("optional terms survive irrelevant query words and quoted error matches center on the behavior", async (t) => {
  const root = await fixture(t);
  const lines = Array.from({ length: 220 }, (_, i) => "// unrelated line " + i);
  lines[167] =
    'export function expireSession() { throw new Error("Session expiry is invalid"); }';
  await writeFile(join(root, "src/expiry.ts"), lines.join("\n"));
  const result = await context(
    root,
    'investigate zzznoSuchWord "Session expiry is invalid"',
  );
  assert.equal(result.status, "ok");
  assert.equal(result.items[0].reference.path, "src/expiry.ts");
  assert.match(result.items[0].excerpt, /throw new Error/);
  assert.ok(
    result.items[0].reference.start_line <= 168 &&
      result.items[0].reference.end_line >= 168,
  );
  accounted(result);
  await exactExcerpts(root, result);
});

test("lexical baseline excludes decision notes and has explicit no-match and stopword-only behavior", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, ".ctx/notes/poison.md"),
    "UniquelyPoisonedDecisionToken",
  );
  assert.equal(
    (await context(root, "UniquelyPoisonedDecisionToken")).status,
    "no_match",
  );
  const noMatch = await context(root, "ZzzNeverPresentIdentifier");
  assert.equal(noMatch.status, "no_match");
  assert.deepEqual(noMatch.items, []);
  accounted(noMatch);
  assert.equal(
    (await context(root, "please help me with the code")).status,
    "no_match",
  );
  const punctuation = await context(
    root,
    '" OR NOT * ^ : {} () -- "; DROP TABLE files;',
  );
  accounted(punctuation);
  assert.equal((await context(root, "readSession")).status, "ok");
});

test("lockfiles are resolver metadata and cannot crowd lexical evidence", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "package-lock.json"),
    '{"lockfileVersion":3,"marker":"LockOnlySentinel"}',
  );
  const result = await context(root, "LockOnlySentinel");
  assert.equal(result.status, "no_match");
  accounted(result);
});

test("candidate selection includes tests/docs/config, bounds per-file crowding, and never forces a full quota", async (t) => {
  const root = await fixture(t);
  const configPath = join(root, ".ctx/config.json"),
    config = JSON.parse(await readFile(configPath, "utf8"));
  config.roots = ["."];
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(root, "test"));
  await writeFile(
    join(root, "test/fresh.test.ts"),
    'const marker="RareSentinelMessage";',
  );
  await writeFile(
    join(root, "README.md"),
    "RareSentinelMessage is the behavior under test.",
  );
  await writeFile(
    join(root, "settings.json"),
    '{"diagnostic":"RareSentinelMessage"}',
  );
  await writeFile(
    join(root, "src/crowded.ts"),
    Array.from({ length: 400 }, (_, i) => "// RareSentinelMessage " + i).join(
      "\n",
    ),
  );
  const result = await context(root, "RareSentinelMessage", {
    encoding: "cl100k_base",
    budget_tokens: 4000,
  });
  assert.ok(result.items.some((item) => item.kind === "test"));
  assert.ok(result.items.some((item) => item.kind === "documentation"));
  assert.ok(result.items.some((item) => item.kind === "config"));
  assert.ok(
    result.items.filter((item) => item.reference.path === "src/crowded.ts")
      .length <= 2,
  );
  assert.ok(result.items.length <= 6);
  accounted(result, await tokenCounter("cl100k_base"));
});

test("exact encoding and independent byte caps include Unicode, special-token text, metadata and omissions", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "src/unicode.ts"),
    Array.from(
      { length: 100 },
      () => "// UnicodeBudgetSentinel مرحبا 世界 🌍 <|endoftext|>",
    ).join("\n"),
  );
  const result = await context(root, "UnicodeBudgetSentinel", {
    encoding: "o200k_base",
    budget_tokens: 1000,
    max_bytes: 2400,
  });
  assert.equal(result.budget.method, "exact");
  assert.equal(result.budget.counter, "o200k_base");
  assert.equal(result.status, "ok");
  assert.equal(result.budget.truncated, true);
  accounted(result, await tokenCounter("o200k_base"));
  await exactExcerpts(root, result);
  const configPath = join(root, ".ctx/config.json"),
    config = JSON.parse(await readFile(configPath, "utf8"));
  config.budget_tokens = 1000;
  await writeFile(configPath, JSON.stringify(config));
  const remaining = await context(root, "readSession", {
    remaining_tokens: 700,
  });
  assert.equal(remaining.budget.limit, 700);
  accounted(remaining);
  await assert.rejects(
    () => context(root, "session", { remaining_tokens: 8 }),
    /metadata/,
  );
  await assert.rejects(
    () => context(root, "session", { budget_tokens: 4001 }),
    /4000/,
  );
  await assert.rejects(
    () => context(root, "session", { encoding: "unknown" }),
    /encoding/,
  );
});

test("an oversized matching line produces bounded budget failure rather than broken provenance", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "src/huge.ts"),
    'export const GiganticTarget = "' + "λ".repeat(10000) + '";',
  );
  const result = await context(root, "GiganticTarget", { budget_tokens: 700 });
  assert.equal(result.status, "budget_too_small");
  assert.deepEqual(result.items, []);
  accounted(result);
});

test("incomplete index coverage stays visible without overflowing the brief", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 20; i++)
    await writeFile(
      join(root, "src/unknown" + i + ".ts"),
      'import value from "undeclared' + i + '";',
    );
  const result = await context(root, "readSession", { budget_tokens: 700 });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage_reason_count >= 20);
  assert.equal(result.coverage.reasons[0].code, "incomplete_index");
  accounted(result);
});

test("expansion validates file bytes, preserves references on unrelated edits and rejects stale content", async (t) => {
  const root = await fixture(t);
  const initial = await context(root, "readSession");
  const ref = initial.items[0].reference;
  const first = await expand(root, ref, { encoding: "cl100k_base" });
  assert.equal(first.status, "expanded");
  assert.equal(ExpandResultSchema.safeParse(first).success, true);
  accounted(first, await tokenCounter("cl100k_base"));
  await exactExcerpts(root, first);
  await writeFile(
    join(root, "src/unrelated.ts"),
    "export const unrelated=true;",
  );
  const unrelated = await expand(root, ref);
  assert.equal(unrelated.status, "expanded");
  assert.notEqual(unrelated.view_id, ref.view_id);
  const path = join(root, ref.path),
    old = await readFile(path, "utf8");
  await writeFile(path, old.replaceAll("readSession", "findSession"));
  const stale = await expand(root, ref);
  assert.equal(stale.status, "stale_reference");
  assert.deepEqual(stale.items, []);
  assert.notEqual(stale.replacement.content_hash, ref.content_hash);
  accounted(stale);
  assert.equal((await expand(root, stale.replacement)).status, "expanded");
});

test("expansion rejects cross-root, escaped, deleted, newly excluded and note references", async (t) => {
  const root = await fixture(t),
    other = await fixture(t);
  const ref = (await context(root, "readSession")).items[0].reference;
  assert.equal((await expand(other, ref)).status, "invalid_reference");
  await assert.rejects(() => expand(root, { ...ref, path: "../outside.ts" }));
  assert.equal(
    (await expand(root, { ...ref, end_line: 999999 })).status,
    "invalid_reference",
  );
  const configPath = join(root, ".ctx/config.json"),
    config = JSON.parse(await readFile(configPath, "utf8"));
  config.exclude = [ref.path];
  await writeFile(configPath, JSON.stringify(config));
  assert.equal((await expand(root, ref)).status, "unavailable_reference");
  config.exclude = [];
  await writeFile(configPath, JSON.stringify(config));
  await rm(join(root, ref.path));
  assert.equal((await expand(root, ref)).status, "unavailable_reference");
  assert.equal(
    (await expand(root, { ...ref, path: ".ctx/notes/session-boundary.md" }))
      .status,
    "unavailable_reference",
  );
});

test("CLI emits one counted JSON representation, accepts a structured reference and rejects malformed inputs", async (t) => {
  const root = await fixture(t);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli/index.js"), ...args, "--root", root, "--json"],
      { encoding: "utf8" },
    );
  const result = run(
    "context",
    "--query",
    "readSession",
    "--encoding",
    "cl100k_base",
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.stdout, renderResult(parsed));
  const expanded = run(
    "expand",
    "--ref",
    JSON.stringify(parsed.items[0].reference),
  );
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.equal(JSON.parse(expanded.stdout).status, "expanded");
  assert.equal(run("expand", "--ref", "oops").status, 2);
  assert.equal(
    run("context", "--query", "session", "--budget", "-1").status,
    2,
  );
  assert.equal(
    run("context", "--query", "session", "--remaining", "1").status,
    2,
  );
});
