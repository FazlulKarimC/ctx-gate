import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  initialize,
  doctor,
  ConfigSchema,
  NoteSchema,
  CoverageSchema,
  CheckResultSchema,
  ReferenceSchema,
} from "../dist/index.js";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "ctxgate-test-"));
  t.after(async () => {
    const path = relative(resolve(tmpdir()), root);
    assert.ok(
      path.startsWith("ctxgate-test-") &&
        !path.includes("..") &&
        !isAbsolute(path),
    );
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("init is idempotent and preserves project instructions and note content", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "AGENTS.md"), "Existing project guidance\n");
  await writeFile(join(root, ".gitignore"), "custom-build/");
  const first = await initialize(root);
  assert.equal(first.config_created, true);
  assert.equal(first.enabled_rules, 0);
  const config = await readFile(join(root, ".ctx/config.json"), "utf8");
  await writeFile(join(root, ".ctx/notes/existing.md"), "Reviewed decision\n");
  const second = await initialize(root);
  assert.equal(second.config_created, false);
  assert.equal(second.ignore_entry_added, false);
  assert.equal(await readFile(join(root, ".ctx/config.json"), "utf8"), config);
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "Existing project guidance\n",
  );
  assert.equal(
    await readFile(join(root, ".ctx/notes/existing.md"), "utf8"),
    "Reviewed decision\n",
  );
  assert.equal(
    await readFile(join(root, ".gitignore"), "utf8"),
    "custom-build/\n/.ctx/cache/\n",
  );
});

test("existing configuration is validated and retained, including configured rules", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, ".ctx"));
  const config = JSON.stringify({
    schema_version: 1,
    budget_tokens: 1000,
    rules: [
      {
        id: "ui-db",
        kind: "deny_import",
        from: "src/ui/**",
        to: "src/db/**",
        explanation: "Use the service boundary",
      },
    ],
  });
  await writeFile(join(root, ".ctx/config.json"), config);
  const result = await initialize(root);
  assert.equal(result.enabled_rules, 1);
  assert.equal(await readFile(join(root, ".ctx/config.json"), "utf8"), config);
});

test("invalid existing config fails without rewriting it or project ignores", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, ".ctx"));
  await writeFile(join(root, ".ctx/config.json"), "{invalid");
  await assert.rejects(initialize(root));
  assert.equal(
    await readFile(join(root, ".ctx/config.json"), "utf8"),
    "{invalid",
  );
  assert.ok(!(await readdir(root)).includes(".gitignore"));
});

test("config rejects unsafe roots, unknown fields and duplicate rule IDs", () => {
  for (const path of [
    "../outside",
    "/outside",
    "C:/outside",
    "src/../../outside",
    "src\\outside",
  ])
    assert.equal(
      ConfigSchema.safeParse({ schema_version: 1, roots: [path] }).success,
      false,
    );
  assert.equal(
    ConfigSchema.safeParse({ schema_version: 1, shell_command: "untrusted" })
      .success,
    false,
  );
  const rule = {
    id: "same",
    kind: "deny_import",
    from: "src/**",
    to: "db/**",
    explanation: "Boundary",
  };
  assert.equal(
    ConfigSchema.safeParse({ schema_version: 1, rules: [rule, rule] }).success,
    false,
  );
});

test("review metadata, stale spans and incomplete verdicts cannot masquerade as validated state", () => {
  assert.equal(
    NoteSchema.safeParse({
      id: "intent",
      title: "Intent",
      review_status: "accepted",
      scopes: ["src/**"],
      rationale: "Reason",
    }).success,
    false,
  );
  assert.equal(
    CoverageSchema.safeParse({
      complete: true,
      checked_files: 1,
      skipped_files: 1,
      reasons: [],
    }).success,
    false,
  );
  assert.equal(
    ReferenceSchema.safeParse({
      schema_version: 1,
      root_id: "a".repeat(64),
      view_id: "view",
      path: "src/a.ts",
      content_hash: "a".repeat(64),
      start_line: 20,
      end_line: 10,
    }).success,
    false,
  );
  assert.equal(
    CheckResultSchema.safeParse({
      schema_version: 1,
      operation: "check",
      baseline_id: "base",
      target_id: "target",
      policy_hash: "a".repeat(64),
      coverage: {
        complete: false,
        checked_files: 1,
        skipped_files: 1,
        reasons: [{ code: "unknown", message: "Unresolved target" }],
      },
      status: "complete",
      findings: [],
    }).success,
    false,
  );
});

test("doctor exercises SQLite FTS5/WAL and does not initialize the workspace", async (t) => {
  const root = await temporary(t);
  const result = await doctor(root);
  assert.equal(result.status, "ready", JSON.stringify(result));
  for (const capability of ["sqlite_version", "fts5", "wal"])
    assert.ok(result.checks.find((check) => check.name === capability)?.passed);
  assert.deepEqual(await readdir(root), []);
  assert.equal(result.capabilities.retrieval, true);
});

test("CLI returns structured failure for unsupported commands and valid JSON for diagnostics", async (t) => {
  const root = await temporary(t);
  const cli = resolve("dist/cli/index.js");
  const failure = spawnSync(
    process.execPath,
    [cli, "unsupported-command", "--root", root, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(failure.status, 2);
  assert.equal(JSON.parse(failure.stderr).status, "unavailable");
  const success = spawnSync(
    process.execPath,
    [cli, "doctor", "--root", root, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).operation, "doctor");
  assert.equal(JSON.parse(success.stdout).capabilities.checking, true);
});
