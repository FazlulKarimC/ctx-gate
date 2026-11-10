import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { check, renderCheck, CheckResultSchema } from "../dist/index.js";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function fixture(t) {
  const parent = resolve(".cache/tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "checker-"));
  cpSync(resolve("tests/fixtures/basic-project"), root, {
    recursive: true,
    filter: (path) => !path.includes(sep + "cache"),
  });
  t.after(() => {
    const rel = relative(parent, root);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Checker Test");
  git(root, "config", "user.email", "checker@example.invalid");
  const write = (path, text) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = () => {
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "fixture");
    return git(root, "rev-parse", "HEAD");
  };
  const base = commit();
  return { root, base, write, commit };
}
const direct = 'export { readSession } from "@app/db/session";\n';
const required = (root, base, extra = {}) =>
  check(root, { base, mode: "required", ...extra });

test("direct rules compare complete views, retain old debt across line movement, and show deletion", (t) => {
  const { root, base, write, commit } = fixture(t);
  assert.equal(required(root, base).exit_code, 0);
  write("src/ui/view.ts", direct);
  let report = required(root, base);
  assert.equal(report.exit_code, 1);
  assert.equal(report.counts.new, 1);
  assert.equal(report.findings[0].source, "src/ui/view.ts");
  assert.equal(report.findings[0].target, "src/db/session.ts");
  const debt = commit();
  write("src/ui/view.ts", "\n\n" + direct);
  report = required(root, debt);
  assert.equal(report.exit_code, 0);
  assert.equal(report.counts.existing, 1);
  assert.equal(report.findings[0].baseline_line, 1);
  assert.equal(report.findings[0].line, 3);
  rmSync(join(root, "src/ui"), { recursive: true });
  report = required(root, debt);
  assert.equal(report.exit_code, 0);
  assert.equal(report.counts.removed, 1);
  assert.equal(report.findings[0].observed_in, "baseline");
});

test("trusted policy and ignores defeat candidate config/global/info exclusions", (t) => {
  const { root, base, write } = fixture(t);
  write("src/ui/new.ts", direct);
  write(
    ".ctx/config.json",
    JSON.stringify({
      schema_version: 1,
      roots: ["elsewhere"],
      exclude: ["src"],
      rules: [],
    }),
  );
  write(".gitignore", "src/ui/new.ts\n");
  write(".git/info/exclude", "src/ui/new.ts\n");
  write("local-ignore", "src/ui/new.ts\n");
  git(root, "config", "core.excludesFile", join(root, "local-ignore"));
  let report = required(root, base);
  assert.equal(report.exit_code, 1);
  assert.equal(report.counts.new, 1);
  assert.equal(report.candidate_policy_changed, true);
  write(".ctx/config.json", "{ broken JSON");
  report = required(root, base);
  assert.equal(report.exit_code, 1);
});

test("trusted ignores and explicit exclusions apply, including nested ignore files", (t) => {
  const { root, write, commit } = fixture(t);
  write("src/ui/.gitignore", "ignored.ts\n");
  write("src/ui/ignored.ts", direct);
  const config = JSON.parse(
    readFileSync(join(root, ".ctx/config.json"), "utf8"),
  );
  config.exclude = ["src/ui/excluded.ts"];
  write(".ctx/config.json", JSON.stringify(config));
  write("src/ui/excluded.ts", direct);
  const base = commit();
  const report = required(root, base);
  assert.equal(report.exit_code, 0, JSON.stringify(report.coverage));
});

test("commit comparisons never resolve against live files or populate the index cache", (t) => {
  const { root, base, write, commit } = fixture(t);
  write("src/ui/new.ts", direct);
  const target = commit();
  write("tsconfig.json", "{broken");
  rmSync(join(root, "src/db"), { recursive: true });
  const report = required(root, base, { target });
  assert.equal(report.exit_code, 1);
  assert.equal(report.counts.new, 1);
  assert.equal(report.coverage.complete, true);
  assert.equal(existsSync(join(root, ".ctx/cache")), false);
});

test("type-only edges are opt-in; runtime reexports and local alias precedence are enforced", (t) => {
  const { root, base, write } = fixture(t);
  write("src/ui/view.ts", 'export type { Session } from "@app/db/session";\n');
  assert.equal(required(root, base).exit_code, 0);
  const policy = JSON.parse(
    readFileSync(join(root, ".ctx/config.json"), "utf8"),
  );
  policy.rules[0].edge_kinds = ["runtime", "type_only"];
  let report = required(root, base, { policy });
  assert.equal(report.counts.new, 1);
  assert.equal(report.findings[0].edge_kind, "type_only");
  write(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { "@app/db": "1.0.0" } }),
  );
  write("src/ui/view.ts", direct);
  report = required(root, base);
  assert.equal(report.exit_code, 1);
});

test("unresolved/malformed/dynamic imports fail coverage, while out-of-rule unknowns and declared externals do not", (t) => {
  const { root, base, write } = fixture(t);
  write("src/services/unknown.ts", 'import "./missing";');
  assert.equal(required(root, base).exit_code, 0);
  write("src/ui/new.ts", 'import "./missing";');
  let report = required(root, base);
  assert.equal(report.exit_code, 2);
  assert.equal(report.status, "incomplete");
  write("src/ui/new.ts", 'const name="x"; import(name);');
  assert.equal(required(root, base).exit_code, 2);
  write("src/ui/new.ts", "export const = ;");
  assert.equal(required(root, base).exit_code, 2);
  write(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { react: "1.0.0" } }),
  );
  write("src/ui/new.ts", 'import "react"; import "node:fs";');
  assert.equal(required(root, base).exit_code, 0);
  for (const dependency of ["workspace:*", "file:../somewhere"]) {
    write(
      "package.json",
      JSON.stringify({ dependencies: { react: dependency } }),
    );
    assert.equal(required(root, base).exit_code, 2);
  }
  write(
    "package.json",
    JSON.stringify({ name: "react", exports: { ".": "./missing.ts" } }),
  );
  assert.equal(required(root, base).exit_code, 2);
});

test("incomplete comparisons do not invent new violations or prove removals", (t) => {
  const { root, write, commit } = fixture(t);
  write("src/ui/unknown.ts", 'import "./missing";');
  const base = commit();
  write("src/ui/new.ts", direct);
  let report = required(root, base);
  assert.equal(report.exit_code, 2);
  assert.equal(report.counts.new, 0);
  assert.equal(report.counts.unclassified, 1);
  write("src/ui/unknown.ts", "export {};");
  const debt = commit();
  rmSync(join(root, "src/db"), { recursive: true });
  report = required(root, debt);
  assert.equal(report.exit_code, 2);
  assert.equal(report.counts.removed, 0);
  assert.equal(report.counts.unclassified, 1);
});

test("missing baselines, absent/invalid policy, empty bases, and read limits fail visibly", (t) => {
  const { root, base, write } = fixture(t);
  assert.equal(required(root, "f".repeat(40)).exit_code, 2);
  assert.equal(check(root, { base: "empty", mode: "required" }).exit_code, 2);
  const policy = JSON.parse(
    readFileSync(join(root, ".ctx/config.json"), "utf8"),
  );
  write("src/ui/new.ts", direct);
  assert.equal(
    check(root, { base: "empty", policy, mode: "required" }).exit_code,
    1,
  );
  assert.equal(
    required(root, base, { scan_limits: { max_files: 1 } }).exit_code,
    2,
  );
  const noRules = { schema_version: 1, roots: ["src"], rules: [] };
  assert.equal(check(root, { base, policy: noRules }).exit_code, 0);
  assert.equal(required(root, base, { policy: noRules }).exit_code, 2);
  assert.throws(() =>
    required(root, base, {
      policy: { ...policy, rules: [...policy.rules, ...policy.rules] },
    }),
  );
  const report = required(root, base);
  assert.equal(
    CheckResultSchema.safeParse({
      ...report,
      coverage: { ...report.coverage, complete: false },
      status: "complete",
    }).success,
    false,
  );
});

test("bounded pages preserve full verdict and counts; changed view/options invalidate cursors", (t) => {
  const { root, base, write, commit } = fixture(t);
  write("src/ui/debt.ts", direct);
  const debt = commit();
  for (let index = 0; index < 6; index++)
    write(`src/ui/new${index}.ts`, direct);
  const options = { page_size: 1, max_bytes: 4096 };
  let report = required(root, debt, options);
  assert.equal(report.exit_code, 1);
  assert.equal(report.counts.new, 6);
  assert.equal(report.counts.existing, 1);
  assert.equal(report.page.returned, 1);
  const seen = [report.findings[0].id],
    cursor = report.next_cursor;
  while (report.next_cursor) {
    report = required(root, debt, { ...options, cursor: report.next_cursor });
    assert.equal(report.exit_code, 1);
    assert.equal(Buffer.byteLength(renderCheck(report)), report.response_bytes);
    assert.ok(report.response_bytes <= 4096);
    seen.push(...report.findings.map((f) => f.id));
  }
  assert.equal(new Set(seen).size, 7);
  assert.equal(
    required(root, debt, { ...options, page_size: 2, cursor }).status,
    "stale_cursor",
  );
  write("src/ui/new0.ts", "\n" + direct);
  assert.equal(
    required(root, debt, { ...options, cursor }).status,
    "stale_cursor",
  );
  const small = required(root, base, { max_bytes: 2048 });
  assert.ok(small.response_bytes <= 2048);
  assert.ok(["complete", "report_too_small"].includes(small.status));
});

test("CLI required immutable-commit check returns 0/1/2 independently of shell editing", (t) => {
  const { root, base, write, commit } = fixture(t);
  const run = (target) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli/index.js"),
        "check",
        "--root",
        root,
        "--base",
        base,
        "--target",
        target,
        "--mode",
        "required",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
  assert.equal(run(base).status, 0);
  write("src/ui/new.ts", direct);
  const target = commit();
  let result = run(target);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).counts.new, 1);
  write("src/ui/new.ts", 'import "./missing";');
  result = run(commit());
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).coverage.complete, false);
});

test("unsupported Git submodule scope and absent trusted roots cannot pass required checks", (t) => {
  const { root, base } = fixture(t);
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${base},src/ui/vendor`,
  );
  git(root, "commit", "--quiet", "-m", "gitlink");
  const target = git(root, "rev-parse", "HEAD");
  const report = required(root, base, { target });
  assert.equal(report.exit_code, 2);
  assert.ok(
    report.coverage.reasons.some((reason) =>
      reason.code.endsWith("uninspected_scope"),
    ),
  );
  assert.equal(
    required(root, base, {
      policy: { schema_version: 1, roots: ["absent"], rules: [] },
    }).exit_code,
    2,
  );
});

test("oversized finding returns a bounded error and never a clean truncated report", (t) => {
  const { root, base, write } = fixture(t);
  write("src/ui/new.ts", direct);
  const policy = JSON.parse(
    readFileSync(join(root, ".ctx/config.json"), "utf8"),
  );
  policy.rules[0].explanation = "é".repeat(1024);
  const report = required(root, base, { policy, max_bytes: 2048 });
  assert.equal(report.status, "report_too_small");
  assert.equal(report.exit_code, 2);
  assert.equal(report.counts.new, 1);
  assert.equal(report.findings.length, 0);
  assert.equal(report.response_bytes, Buffer.byteLength(renderCheck(report)));
  assert.ok(report.response_bytes <= 2048);
});
