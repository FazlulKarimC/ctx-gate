import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { verifyFreeze } from "../eval/scripts/verify-freeze.mjs";

test("freeze guard catches changed/missing dependencies and never authorizes agent runs", async (t) => {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "freeze-"));
  t.after(async () => {
    const rel = relative(parent, root);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  await writeFile(join(root, "package-lock.json"), "original");
  const manifest = {
    schema_version: 1,
    source: [{ path: "package-lock.json", sha256: hash("original") }],
  };
  let result = verifyFreeze(root, manifest);
  assert.equal(result.valid, true);
  assert.equal(result.agent_runs_allowed, false);
  await writeFile(join(root, "package-lock.json"), "changed");
  result = verifyFreeze(root, manifest);
  assert.equal(result.valid, false);
  assert.equal(result.mismatches[0].reason, "hash_changed");
  await rm(join(root, "package-lock.json"));
  assert.equal(verifyFreeze(root, manifest).valid, false);
});

test("freeze guard rejects traversal and absolute input before reading outside its root", () => {
  for (const path of [
    "../private",
    "C:/private",
    "C:private",
    "/private",
    "folder\\private",
    "./file",
  ])
    assert.throws(
      () =>
        verifyFreeze(process.cwd(), {
          schema_version: 1,
          source: [{ path, sha256: "0".repeat(64) }],
        }),
      /Invalid frozen/,
    );
});
