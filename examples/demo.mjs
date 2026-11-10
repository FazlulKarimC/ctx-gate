import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  initialize,
  context,
  expand,
  renderResult,
  check,
} from "../dist/index.js";

if (process.versions.node.split(".")[0] !== "24")
  throw Error("Select Node 24 before running this demo.");
const project = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  parent = join(project, ".cache/portfolio-demo");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, "run-")),
  root = join(output, "fixture");
const rel = relative(parent, root);
assert(!rel.startsWith("..") && !isAbsolute(rel));
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};
const json = (name, value) =>
  save(join(output, name), JSON.stringify(value, null, 2) + "\n");
const files = {
  "package.json": JSON.stringify({
    name: "ctxgate-synthetic-demo",
    private: true,
    type: "module",
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src"],
  }),
  "src/math/sum.ts":
    "export function sum(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n",
  "src/db/session.ts":
    "export function readSession(id: string) {\n  return { id, expiresAt: 0 };\n}\n",
  "src/services/session.ts": 'export { readSession } from "../db/session";\n',
  "src/ui/view.ts":
    'import { readSession } from "../services/session";\nexport function displaySession(id: string) { return readSession(id); }\n',
};
for (const [path, text] of Object.entries(files))
  await save(join(root, path), text);
await initialize(root);
const policy = {
  schema_version: 1,
  roots: ["src"],
  rules: [
    {
      id: "ui-no-db",
      kind: "deny_import",
      from: "src/ui/**",
      to: "src/db/**",
      explanation: "UI uses the service boundary.",
    },
  ],
};
const configText = JSON.stringify(policy, null, 2) + "\n";
await save(join(root, ".ctx/config.json"), configText);
await mkdir(join(output, "empty-hooks"));
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=" + join(output, "empty-hooks"),
      "-c",
      "commit.gpgsign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ).trim();
git("init", "--quiet");
git("config", "user.name", "ctx-gate demo");
git("config", "user.email", "demo@example.invalid");
git("add", "--all");
git("commit", "--quiet", "-m", "Synthetic trusted baseline");
const base = git("rev-parse", "HEAD");

const brief = await context(root, "symbol:sum", {
  encoding: "o200k_base",
  budget_tokens: 2000,
});
assert.equal(brief.status, "ok");
assert.equal(brief.items[0].reference.path, "src/math/sum.ts");
assert.match(brief.items[0].excerpt, /function sum/);
assert(brief.budget.count <= 2000 && brief.budget.bytes <= 16384);
assert.equal(brief.budget.bytes, Buffer.byteLength(renderResult(brief)));
await json("01-symbol-discovery.json", brief);

// Deliberately synthetic vocabulary counterexample, not a benchmark task.
const vocabulary = await context(root, "addition over numeric entries", {
  encoding: "o200k_base",
  budget_tokens: 2000,
});
assert.equal(vocabulary.status, "no_match");
assert.match(await readFile(join(root, "src/math/sum.ts"), "utf8"), /a \+ b/);
await json("02-vocabulary-limitation.json", vocabulary);

const ref = brief.items[0].reference,
  expanded = await expand(root, ref, {
    encoding: "o200k_base",
    budget_tokens: 1000,
  });
assert.equal(expanded.status, "expanded");
await json("03-valid-expansion.json", expanded);
await save(
  join(root, ref.path),
  "// Source bytes changed after the reference.\n" + files[ref.path],
);
const stale = await expand(root, ref, {
  encoding: "o200k_base",
  budget_tokens: 1000,
});
assert.equal(stale.status, "stale_reference");
assert.equal(stale.items.length, 0);
assert.notEqual(stale.replacement.content_hash, ref.content_hash);
await json("04-stale-reference.json", stale);

const clean = check(root, { base, mode: "required" });
assert.equal(clean.exit_code, 0);
assert.equal(clean.coverage.complete, true);
await save(
  join(root, "src/ui/view.ts"),
  'export { readSession } from "../db/session";\n',
);
const denied = check(root, { base, mode: "required" });
assert.equal(denied.exit_code, 1);
assert.equal(denied.counts.new, 1);
assert.equal(denied.findings[0].target, "src/db/session.ts");
await json("05-boundary-rejected.json", denied);
const cli = spawnSync(
  process.execPath,
  [
    join(project, "dist/cli/index.js"),
    "check",
    "--root",
    root,
    "--base",
    base,
    "--mode",
    "required",
    "--json",
  ],
  { encoding: "utf8", windowsHide: true, timeout: 20000 },
);
assert.equal(cli.status, 1);
assert.equal(JSON.parse(cli.stdout).counts.new, 1);
await json("05-required-cli.json", {
  exit_code: cli.status,
  report: JSON.parse(cli.stdout),
});

await save(
  join(root, ".ctx/config.json"),
  JSON.stringify({ schema_version: 1, roots: ["elsewhere"], rules: [] }),
);
const bypass = check(root, { base, mode: "required" });
assert.equal(bypass.exit_code, 1);
assert.equal(bypass.counts.new, 1);
assert.equal(bypass.candidate_policy_changed, true);
await json("06-candidate-policy-cannot-bypass.json", bypass);
await save(join(root, ".ctx/config.json"), configText);
await save(join(root, "src/ui/view.ts"), files["src/ui/view.ts"]);
const repaired = check(root, { base, mode: "required" });
assert.equal(repaired.exit_code, 0);
assert.equal(repaired.counts.new, 0);
await json("07-service-boundary-restored.json", repaired);

const summary = {
  schema_version: 1,
  operation: "offline_portfolio_demo",
  runtime: process.version,
  verified: true,
  model_calls: 0,
  synthetic: true,
  output,
  fixture: root,
  baseline: base,
  discovery: {
    query: "symbol:sum",
    first_path: brief.items[0].reference.path,
    budget: brief.budget,
  },
  vocabulary_limitation: {
    query: "addition over numeric entries",
    status: vocabulary.status,
    known_helper: "src/math/sum.ts",
  },
  freshness: {
    before: expanded.status,
    after_edit: stale.status,
    stale_excerpt_withheld: stale.items.length === 0,
  },
  checking: {
    clean: clean.exit_code,
    violation: denied.exit_code,
    candidate_policy_bypass: bypass.exit_code,
    repaired: repaired.exit_code,
  },
  interpretation:
    "Reproducible synthetic mechanics: exact-anchor discovery, a lexical vocabulary miss, freshness and direct-boundary enforcement. No agent benefit, latency or general accuracy estimate.",
};
await json("summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
