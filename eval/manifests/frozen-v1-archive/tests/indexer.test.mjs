import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  utimes,
  rename,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  refreshIndex,
  captureWorktree,
  captureCommit,
  buildAnalysisContext,
  parseSource,
  resolveImports,
} from "../dist/index.js";

async function fixture(t) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "indexer-"));
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
function database(root) {
  return new DatabaseSync(join(root, ".ctx/cache/index.sqlite"));
}
function importsFor(view, path) {
  const context = buildAnalysisContext(view);
  const file = view.files.get(path);
  assert.ok(file);
  return resolveImports(file, parseSource(file, context), context);
}

test("cold index resolves aliases/type imports, populates FTS, and warm refresh reuses syntax", async (t) => {
  const root = await fixture(t);
  const cold = refreshIndex(root);
  assert.equal(cold.status, "complete", JSON.stringify(cold.coverage));
  assert.equal(cold.parsed_files, 4);
  const db = database(root);
  try {
    const edges = db
      .prepare("SELECT * FROM imports WHERE source=? ORDER BY ordinal")
      .all("src/ui/view.ts");
    assert.equal(edges[0].target, "src/services/session.ts");
    assert.equal(edges[0].resolution, "resolved_local");
    assert.equal(edges[1].kind, "type_only");
    assert.equal(edges[1].target, "src/models/session.ts");
    assert.ok(
      db
        .prepare(
          "SELECT count(*) total FROM chunk_search WHERE chunk_search MATCH ?",
        )
        .get("subtokens:session").total > 0,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM files WHERE path LIKE ?")
        .get("generated/%").total,
      0,
    );
  } finally {
    db.close();
  }
  const warm = refreshIndex(root);
  assert.equal(warm.generation, cold.generation);
  assert.equal(warm.parsed_files, 0);
  assert.equal(warm.reused_files, 4);
});

test("same-size and timestamp-preserving edits invalidate hashes and replace symbol/search rows", async (t) => {
  const root = await fixture(t);
  const initial = refreshIndex(root);
  const path = join(root, "src/db/session.ts"),
    before = await stat(path),
    text = await readFile(path, "utf8");
  await writeFile(path, text.replaceAll("readSession", "findSession"));
  await utimes(path, before.atime, before.mtime);
  const changed = refreshIndex(root);
  assert.equal(changed.parsed_files, 1);
  assert.equal(changed.reused_files, 3);
  assert.notEqual(changed.view_id, initial.view_id);
  const db = database(root);
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM symbols WHERE name=?")
        .get("readSession").total,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM symbols WHERE name=?")
        .get("findSession").total,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) total FROM chunk_search WHERE chunk_search MATCH ?",
        )
        .get("exact_identifiers:readSession").total,
      0,
    );
  } finally {
    db.close();
  }
});

test("deletions, additions and renames reconcile graph rows without silently resolving missing local targets", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  await rename(join(root, "src/db/session.ts"), join(root, "src/db/moved.ts"));
  const missing = refreshIndex(root);
  assert.equal(missing.removed_files, 1);
  assert.equal(missing.status, "incomplete");
  assert.ok(
    missing.coverage.reasons.some(
      (reason) => reason.code === "unresolved_local",
    ),
  );
  const path = join(root, "src/services/session.ts");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace("../db/session", "../db/moved"),
  );
  const fixed = refreshIndex(root);
  assert.equal(fixed.status, "complete", JSON.stringify(fixed.coverage));
  const db = database(root);
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM files WHERE path=?")
        .get("src/db/session.ts").total,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT target FROM imports WHERE source=?")
        .get("src/services/session.ts").target,
      "src/db/moved.ts",
    );
  } finally {
    db.close();
  }
});

test("config changes invalidate cached resolution and undeclared/dynamic imports remain visible", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  const config = JSON.parse(
    await readFile(join(root, "tsconfig.json"), "utf8"),
  );
  config.compilerOptions.paths["@app/*"] = ["./missing/*"];
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const changed = refreshIndex(root);
  assert.equal(changed.status, "incomplete");
  assert.equal(changed.parsed_files, 4);
  assert.ok(
    changed.coverage.reasons.some(
      (reason) => reason.code === "unsupported_local",
    ),
  );
  await writeFile(
    join(root, "src/ui/extra.ts"),
    'import x from "unregistered"; const dynamic = import(process.env.MODULE);',
  );
  const unknown = refreshIndex(root);
  assert.ok(
    unknown.coverage.reasons.some((reason) => reason.code === "unknown"),
  );
  assert.ok(
    unknown.coverage.reasons.some(
      (reason) => reason.code === "unsupported_local",
    ),
  );
});

test("declared external packages need no node_modules while local aliases/workspaces cannot be exempted", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      type: "module",
      dependencies: {
        react: "*",
        "@scope/external": "*",
        "@local/model": "workspace:*",
      },
    }),
  );
  await writeFile(
    join(root, "src/ui/extra.ts"),
    'import React from "react"; import e from "@scope/external/subpath"; import m from "@local/model"; import fs from "node:fs"; type S = import("../models/session").Session;',
  );
  let view = captureWorktree(root).view;
  let edges = importsFor(view, "src/ui/extra.ts");
  assert.deepEqual(
    edges.map((edge) => edge.resolution),
    [
      "external_declared",
      "external_declared",
      "unsupported_local",
      "builtin",
      "resolved_local",
    ],
  );
  assert.equal(edges.at(-1).kind, "type_only");
  const config = JSON.parse(
    await readFile(join(root, "tsconfig.json"), "utf8"),
  );
  config.compilerOptions.paths.react = ["./src/db/session.ts"];
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  view = captureWorktree(root).view;
  edges = importsFor(view, "src/ui/extra.ts");
  assert.equal(edges[0].resolution, "resolved_local");
  assert.equal(edges[0].target, "src/db/session.ts");
});

test("nested ignores, secret defaults and configured limits have explicit coverage behavior", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src/ignored"), { recursive: true });
  await writeFile(join(root, "src/.gitignore"), "ignored/\n");
  await writeFile(
    join(root, "src/ignored/secret.ts"),
    "export const ignored=true;",
  );
  await writeFile(join(root, ".env"), "SECRET=not-real-fixture");
  await writeFile(
    join(root, "src/new.ts"),
    "export const SessionExpiryTimeout=100;",
  );
  const scan = captureWorktree(root);
  assert.equal(scan.view.fileExists("src/new.ts"), true);
  assert.equal(scan.view.readFile("src/ignored/secret.ts"), undefined);
  assert.equal(scan.view.readFile(".env"), undefined);
  assert.equal(scan.view.readFile("../package.json"), undefined);
  const limited = captureWorktree(root, { max_files: 2 });
  assert.equal(limited.coverage.complete, false);
  assert.ok(
    limited.coverage.reasons.some((reason) => reason.code === "file_limit"),
  );
  const bytes = captureWorktree(root, { max_bytes: 512 });
  assert.equal(bytes.coverage.complete, false);
});

test("malformed source is indexed as incomplete and corrupt/incompatible disposable databases rebuild", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  await writeFile(join(root, "src/broken.ts"), "export function broken( {");
  assert.equal(refreshIndex(root).status, "incomplete");
  await rm(join(root, "src/broken.ts"));
  await writeFile(join(root, ".ctx/cache/index.sqlite"), "not a database");
  const recovered = refreshIndex(root);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.recovered_cache, true);
  const db = database(root);
  const row = JSON.parse(
    db.prepare("SELECT payload FROM metadata").get().payload,
  );
  row.schema_version = 999;
  db.prepare("UPDATE metadata SET payload=?").run(JSON.stringify(row));
  db.close();
  assert.equal(refreshIndex(root).recovered_cache, true);
  assert.ok(
    (
      await readFile(join(root, ".ctx/notes/session-boundary.md"), "utf8")
    ).includes("synthetic-fixture-reviewer"),
  );
});

test("two worktrees with equal bytes have isolated cache identity", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const a = refreshIndex(first),
    b = refreshIndex(second);
  assert.notEqual(a.database, b.database);
  assert.notEqual(a.view_id, b.view_id);
  assert.equal(b.parsed_files, 4);
});

test("immutable commit imports and config ignore disagreeing live files and caches", async (t) => {
  const root = await fixture(t);
  const unusual = "src/odd name [δ].ts";
  await writeFile(join(root, unusual), 'export const label = "λ";\n');
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.hooksPath=" + join(root, "nonexistent-hooks"),
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=ctxgate-test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD").trim();
  const first = captureCommit(root, commit);
  assert.equal(first.coverage.complete, true);
  assert.equal(first.view.readFile(unusual), 'export const label = "λ";\n');
  assert.throws(
    () => captureCommit(root, "0".repeat(40)),
    /object access failed/,
  );
  const limited = captureCommit(root, commit, { max_files: 2 });
  assert.equal(limited.coverage.complete, false);
  assert.ok(
    limited.coverage.reasons.some(
      (reason) => reason.code === "git_content_limit",
    ),
  );
  const original = importsFor(first.view, "src/ui/view.ts");
  assert.equal(original[0].target, "src/services/session.ts");
  await rm(join(root, "src/services/session.ts"));
  await writeFile(join(root, "tsconfig.json"), "{}");
  await writeFile(join(root, "package.json"), "{}");
  const second = captureCommit(root, commit);
  assert.equal(second.view.id, first.view.id);
  assert.deepEqual(importsFor(second.view, "src/ui/view.ts"), original);
  assert.equal(second.view.readFile("../external.ts"), undefined);
  assert.throws(() => captureCommit(root, "HEAD"), /immutable/);
});

test("NodeNext package import and self-reference conditions distinguish import from require", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*"],
    }),
  );
  const conditions = {
    import: "./src/mode-import.mts",
    require: "./src/mode-require.cts",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      type: "module",
      imports: { "#mode": conditions },
      exports: { ".": conditions },
    }),
  );
  await writeFile(
    join(root, "src/mode-import.mts"),
    "export const mode='import';",
  );
  await writeFile(
    join(root, "src/mode-require.cts"),
    "export const mode='require';",
  );
  await writeFile(
    join(root, "src/caller.mts"),
    'import {mode} from "#mode"; import * as self from "fixture";',
  );
  await writeFile(
    join(root, "src/caller.cts"),
    'import mode = require("#mode"); import self = require("fixture");',
  );
  const view = captureWorktree(root).view;
  const es = importsFor(view, "src/caller.mts"),
    cjs = importsFor(view, "src/caller.cts");
  assert.ok(
    es.every(
      (edge) =>
        edge.resolution === "resolved_local" &&
        edge.target === "src/mode-import.mts" &&
        edge.mode === "import",
    ),
    JSON.stringify(es),
  );
  assert.ok(
    cjs.every(
      (edge) =>
        edge.resolution === "resolved_local" &&
        edge.target === "src/mode-require.cts" &&
        edge.mode === "require",
    ),
    JSON.stringify(cjs),
  );
});

test("missing Git configuration cannot fall back to an untracked worktree extension", async (t) => {
  const root = await fixture(t);
  const config = JSON.parse(
    await readFile(join(root, "tsconfig.json"), "utf8"),
  );
  config.extends = "./untracked-options.json";
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.hooksPath=" + join(root, "no-hooks"),
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const revision = git("rev-parse", "HEAD").trim();
  await writeFile(join(root, "untracked-options.json"), "{}");
  const context = buildAnalysisContext(captureCommit(root, revision).view);
  assert.ok(
    context.reasons.some((reason) => reason.code === "configuration_error"),
  );
});

test("actual Git worktrees stay isolated and branch switches reconcile cached symbols", async (t) => {
  const root = await fixture(t);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.hooksPath=" + join(root, "no-hooks"),
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const base = git("rev-parse", "HEAD").trim();
  const other = join(root, "linked-worktree");
  git("worktree", "add", "--detach", other, base);
  const initial = refreshIndex(root),
    linked = refreshIndex(other);
  assert.notEqual(initial.database, linked.database);
  assert.notEqual(initial.view_id, linked.view_id);
  await writeFile(join(root, "src/new.ts"), "export const branchOnly = true;");
  git("add", "src/new.ts");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "new source",
  );
  refreshIndex(root);
  git("checkout", "--detach", base);
  const switched = refreshIndex(root);
  assert.equal(switched.removed_files, 1);
  const db = database(root);
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM symbols WHERE name=?")
        .get("branchOnly").total,
      0,
    );
  } finally {
    db.close();
  }
  assert.equal(refreshIndex(other).generation, linked.generation);
});

test("two independent index processes publish complete generations without mixed rows", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 30; i++)
    await writeFile(
      join(root, "src", "extra" + i + ".ts"),
      "export const value" + i + " = " + i + ";",
    );
  const run = () =>
    new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [resolve("dist/cli/index.js"), "index", "--root", root, "--json"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (err += data));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          assert.equal(code, 0, err);
          done(JSON.parse(out));
        } catch (error) {
          reject(error);
        }
      });
    });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.every((result) => result.status === "complete"));
  const db = database(root);
  try {
    assert.equal(
      db.prepare("SELECT count(*) total FROM symbols").get().total,
      34,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) total FROM symbols WHERE name=?")
        .get("value0").total,
      1,
    );
  } finally {
    db.close();
  }
});

test("unused scope and corrupt syntax-cache entries are explicit or reparsed, never false clean hits", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  const db = database(root);
  db.prepare("UPDATE files SET facts=? WHERE path=?").run(
    "{bad",
    "src/db/session.ts",
  );
  db.close();
  assert.equal(refreshIndex(root).parsed_files, 1);
  const path = join(root, ".ctx/config.json"),
    config = JSON.parse(await readFile(path, "utf8"));
  config.roots = ["./missing"];
  await writeFile(path, JSON.stringify(config));
  const result = refreshIndex(root);
  assert.equal(result.status, "incomplete");
  assert.ok(
    result.coverage.reasons.some((reason) => reason.code === "missing_scope"),
  );
});
