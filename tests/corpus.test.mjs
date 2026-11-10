import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

test("qualified agent pool preserves original inputs and separates held-out fix families from diagnostic exposure", () => {
  const read = (path) => JSON.parse(readFileSync(path, "utf8")),
    sha = (data) => createHash("sha256").update(data).digest("hex");
  const pool = read("eval/manifests/agent-pool.json"),
    review = read("eval/labels/candidate-review.json");
  assert.equal(
    pool.original_manifest_sha256,
    sha(readFileSync("eval/manifests/corpus.json")),
  );
  assert.equal(
    pool.review_sha256,
    sha(readFileSync("eval/labels/candidate-review.json")),
  );
  assert.equal(pool.selection_hash, sha(JSON.stringify(pool.tasks)));
  assert.equal(
    pool.tasks.filter((task) => task.split === "development").length,
    20,
  );
  const holdout = pool.tasks.filter((task) => task.split === "holdout");
  assert.equal(holdout.length, 18);
  assert.equal(new Set(pool.tasks.map((task) => task.id)).size, 38);
  assert.equal(
    new Set(pool.tasks.map((task) => task.source_patch_id)).size,
    38,
  );
  const protectedFamilies = new Set([
    ...review.protected_diagnostic_families,
    ...pool.tasks
      .filter((task) => task.split === "development")
      .map((task) => task.family),
  ]);
  assert.ok(holdout.every((task) => !protectedFamilies.has(task.family)));
  for (const repository of ["picomatch", "json-server", "fastify"])
    assert.equal(
      holdout.filter((task) => task.repository === repository).length,
      6,
    );
  assert.equal(pool.agent_runs_allowed, false);
});
