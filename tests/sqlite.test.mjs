import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";

test("selected SQLite binding supports FTS5, rollback, WAL readers and single-writer contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctxgate-sqlite-"));
  const first = new DatabaseSync(join(root, "test.sqlite"));
  let second;
  try {
    assert.equal(
      first.prepare("PRAGMA journal_mode = WAL").get().journal_mode,
      "wal",
    );
    first.exec("CREATE VIRTUAL TABLE evidence USING fts5(content)");
    first.prepare("INSERT INTO evidence VALUES (?)").run("session expiry");
    assert.equal(
      first
        .prepare("SELECT count(*) hits FROM evidence WHERE evidence MATCH ?")
        .get("expiry").hits,
      1,
    );
    first.exec("CREATE TABLE files(path TEXT PRIMARY KEY)");
    second = new DatabaseSync(join(root, "test.sqlite"));
    second.exec("PRAGMA busy_timeout = 0");
    first.exec("BEGIN IMMEDIATE");
    first.prepare("INSERT INTO files VALUES (?)").run("uncommitted.ts");
    assert.equal(
      second.prepare("SELECT count(*) total FROM files").get().total,
      0,
    );
    assert.throws(() => second.exec("BEGIN IMMEDIATE"), /locked/);
    first.exec("ROLLBACK");
    assert.equal(
      first.prepare("SELECT count(*) total FROM files").get().total,
      0,
    );
    second.exec("BEGIN IMMEDIATE");
    second.prepare("INSERT INTO files VALUES (?)").run("committed.ts");
    second.exec("COMMIT");
    assert.equal(
      first.prepare("SELECT count(*) total FROM files").get().total,
      1,
    );
  } finally {
    second?.close();
    first.close();
    const rel = relative(resolve(tmpdir()), root);
    assert.ok(
      rel.startsWith("ctxgate-sqlite-") &&
        !rel.includes("..") &&
        !isAbsolute(rel),
    );
    await rm(root, { recursive: true, force: true });
  }
});
