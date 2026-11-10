import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";

test("evaluation preview does not execute tasks and real batches reject missing capability evidence", () => {
  const preview = spawnSync(
    process.execPath,
    ["eval/scripts/run-initial.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).action, "preview");
  const denied = spawnSync(
    process.execPath,
    ["eval/scripts/run-initial.mjs", "--execute"],
    { encoding: "utf8" },
  );
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /successful filesystem capability probe/);
});

test("retrieval study rejects malformed preparation before querying or touching upstream snapshots", async (t) => {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "study-guard-"));
  t.after(async () => {
    const rel = relative(parent, directory);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    await rm(directory, { recursive: true, force: true });
  });
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  const id = "2026-10-26T00-00-00-000Z",
    path = join(directory, "prepared.json");
  const registration = JSON.parse(
    await readFile("eval/manifests/lexical-v1.json", "utf8"),
  );
  await writeFile(
    path,
    JSON.stringify({
      run_id: id,
      output: resolve("eval/runs/retrieval", id),
      label_hash: sha(await readFile("eval/labels/development-retrieval.json")),
      configuration_hash: sha(JSON.stringify(registration)),
      tasks: [],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["eval/scripts/retrieval-study.mjs", "--prepared", path],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /20 distinct prepared/);
});
