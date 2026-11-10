import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { context, renderResult, LEXICAL_VARIANTS } from "../dist/index.js";
import { spawnSync } from "node:child_process";
import { retrievalInternals } from "../dist/retrieval/index.js";
import { responseBudget } from "../dist/retrieval/budget.js";

async function fixture(t) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "refinement-"));
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

test("v2 retains an anchor entry and the relevant body window inside the same long-function chunk", async (t) => {
  const root = await fixture(t),
    lines = ["export function locateRecords(value: unknown, query: string) {"];
  for (let i = 1; i < 120; i++)
    lines.push(
      i === 62
        ? '  if (typeof value === "boolean") return value;'
        : "  // generic query preparation " + i,
    );
  lines.push("return query;", "}");
  await writeFile(join(root, "src/long.ts"), lines.join("\n"));
  const old = await context(root, "symbol:locateRecords boolean", {
    lexical_version: "v1",
    budget_tokens: 4000,
  });
  const improved = await context(root, "symbol:locateRecords boolean", {
    lexical_version: "v2",
    budget_tokens: 4000,
  });
  assert.ok(
    !old.items.some(
      (item) =>
        item.reference.path === "src/long.ts" &&
        item.excerpt.includes("typeof value"),
    ),
  );
  const selected = improved.items.filter(
    (item) => item.reference.path === "src/long.ts",
  );
  assert.ok(selected.some((item) => item.excerpt.includes("typeof value")));
  assert.ok(
    selected.some((item) =>
      item.excerpt.includes("export function locateRecords"),
    ),
  );
  assert.ok(selected.length <= 2);
  assert.equal(
    renderResult(
      await context(root, "symbol:locateRecords boolean", {
        lexical_version: "v2",
        budget_tokens: 4000,
      }),
    ),
    renderResult(improved),
  );
});

test("v2 bound limits packing work and skips identical shrinking attempts on one-line candidates", async () => {
  const query = {
    terms: ["unfit"],
    symbols: [],
    paths: [],
    phrases: [],
    truncated: false,
  };
  const ranked = Array.from({ length: 200 }, (_, i) => ({
    path: "src/unfit" + i + ".ts",
    content_hash: "c".repeat(64),
    kind: "source",
    start_line: 1,
    end_line: 1,
    file_end: 1,
    text: "// unfit " + "x".repeat(5000),
    tier: 2,
    rank: i,
    reason: "lexical match",
    focus: 1,
  }));
  const run = async (variant) => {
    const { counter, budget } = await responseBudget(700, {});
    let calls = 0;
    const original = counter.count;
    counter.count = (text) => {
      calls++;
      return original(text);
    };
    const result = retrievalInternals.packResult(
      {
        schema_version: 1,
        operation: "context",
        root_id: "a".repeat(64),
        view_id: "b".repeat(64),
        generation: 1,
        evidence_trust: "repository_data",
        status: "no_match",
        coverage: {
          complete: true,
          checked_files: 200,
          skipped_files: 0,
          reasons: [],
        },
        coverage_reason_count: 0,
        diagnostics: [],
        items: [],
        budget,
      },
      ranked,
      query,
      counter,
      variant,
    );
    return { result, calls };
  };
  const old = await run("v1"),
    improved = await run("v2");
  assert.equal(improved.result.status, "budget_too_small");
  assert.ok(improved.calls < 100, JSON.stringify(improved));
  assert.ok(old.calls > improved.calls * 5);
  assert.equal(
    improved.result.budget.count,
    Math.ceil(Buffer.byteLength(renderResult(improved.result)) / 3),
  );
  assert.equal(LEXICAL_VARIANTS.v2.packing_candidates, 40);
});

test("unknown lexical versions are rejected and anchor-only queries preserve the v1 evidence", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    () => context(root, "readSession", { lexical_version: "unknown" }),
    /lexical_version/,
  );
  const old = await context(root, "symbol:readSession", {
    lexical_version: "v1",
  });
  const improved = await context(root, "symbol:readSession", {
    lexical_version: "v2",
  });
  assert.deepEqual(improved, old);
  const cli = spawnSync(
    process.execPath,
    [
      resolve("dist/cli/index.js"),
      "context",
      "--root",
      root,
      "--query",
      "readSession",
      "--lexical-version",
      "v1",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, "ok");
  assert.equal(
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli/index.js"),
        "context",
        "--root",
        root,
        "--query",
        "readSession",
        "--lexical-version",
        "invalid",
      ],
      { encoding: "utf8" },
    ).status,
    2,
  );
});
