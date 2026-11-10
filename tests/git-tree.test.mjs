import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { exportTree } from "../eval/scripts/git-tree.mjs";

test("batched commit export reads immutable blobs rather than changed worktree files", async (t) => {
  const testRoot = resolve(".cache/tests");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "ctxgate-git-test-"));
  t.after(async () => {
    const rel = relative(testRoot, root);
    assert.ok(
      rel.startsWith("ctxgate-git-test-") &&
        !rel.includes("..") &&
        !isAbsolute(rel),
    );
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  await mkdir(repo);
  const hooks = join(root, "empty-hooks");
  await mkdir(hooks);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${hooks}`,
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  git("init", "--quiet");
  await writeFile(
    join(repo, "source with spaces.js"),
    'export const value = "committed";\n',
  );
  await writeFile(join(repo, "package.json"), '{"name":"original"}');
  git("add", ".");
  git(
    "-c",
    "user.name=ctxgate test",
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
  await writeFile(
    join(repo, "source with spaces.js"),
    'export const value = "dirty";\n',
  );
  await writeFile(join(repo, "package.json"), '{"name":"changed"}');
  const destination = join(root, "snapshot");
  const result = await exportTree(repo, commit, destination);
  assert.equal(result.files, 2);
  assert.equal(
    await readFile(join(destination, "source with spaces.js"), "utf8"),
    'export const value = "committed";\n',
  );
  assert.equal(
    await readFile(join(destination, "package.json"), "utf8"),
    '{"name":"original"}',
  );
  await assert.rejects(
    exportTree(repo, "HEAD", join(root, "unsafe")),
    /immutable/,
  );
});
