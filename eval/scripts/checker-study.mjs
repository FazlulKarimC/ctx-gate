import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { check } from "../../dist/index.js";
import { runRequiredCheck } from "./run-required-check.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const registration = readFileSync("eval/manifests/checker-cases.json");
const manifest = JSON.parse(registration),
  started = new Date().toISOString();
const output = resolve("eval/runs/checker", started.replaceAll(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const source = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!["cache", "node_modules"].includes(entry.name)) collect(file);
    } else source.push(file);
  }
}
for (const path of ["src", "tests", "eval/scripts", ".github/workflows"])
  collect(path);
source.push(
  "eval/manifests/checker-cases.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
);
const files = source.sort().map((path) => {
  const bytes = readFileSync(path);
  const destination = join(output, "source", path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  writeFileSync(destination, bytes);
  return {
    path: path.split(sep).join("/"),
    sha256: hash(bytes),
    bytes: bytes.length,
  };
});
writeFileSync(
  join(output, "registration.json"),
  JSON.stringify(
    { started_at: started, manifest_sha256: hash(registration), source: files },
    null,
    2,
  ) + "\n",
);
const parent = resolve(".cache/checker-study");
mkdirSync(parent, { recursive: true });
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const results = [];
for (const item of manifest.cases) {
  const root = mkdtempSync(join(parent, item.id + "-"));
  try {
    cpSync(resolve("tests/fixtures/basic-project"), root, {
      recursive: true,
      filter: (path) => !path.includes(sep + "cache"),
    });
    const write = (path, text, child = false) => {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      if (child)
        execFileSync(process.execPath, [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
          join(root, path),
          text,
        ]);
      else writeFileSync(join(root, path), text);
    };
    write(".ctx/config.json", JSON.stringify(manifest.policy));
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Checker Study");
    git(root, "config", "user.email", "checker@example.invalid");
    for (const [path, text] of Object.entries(item.base_files ?? {}))
      write(path, text);
    const commit = () => {
      git(root, "add", "--all");
      git(root, "commit", "--quiet", "--allow-empty", "-m", "fixture");
      return git(root, "rev-parse", "HEAD");
    };
    const base = commit();
    for (const [path, text] of Object.entries(item.target_files))
      write(path, text, item.write_via_child);
    for (const path of item.remove ?? []) {
      const absolute = resolve(root, path),
        rel = relative(root, absolute);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw Error("Invalid fixture deletion");
      rmSync(absolute);
    }
    const start = performance.now(),
      report = check(root, { base, mode: "required" }),
      elapsed_ms = performance.now() - start;
    writeFileSync(
      join(output, item.id + ".json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    const matches = Object.entries(item.expected).every(
      ([key, value]) =>
        (key === "exit_code" ? report.exit_code : report.counts[key]) === value,
    );
    results.push({
      id: item.id,
      expected: item.expected,
      matched: matches,
      exit_code: report.exit_code,
      counts: report.counts,
      coverage: report.coverage,
      elapsed_ms,
      direct: item.direct,
      transitive: item.transitive,
    });
    if (
      ["service-transitive", "runtime-import", "missing-local"].includes(
        item.id,
      )
    ) {
      const target = commit(),
        smoke = runRequiredCheck({ root, base, target, policy: base });
      if (smoke.status !== item.expected.exit_code)
        throw Error("Required CI helper smoke failed: " + item.id);
      writeFileSync(join(output, item.id + "-ci.json"), smoke.stdout);
    }
  } finally {
    const rel = relative(parent, root);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw Error("Invalid cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
}
const complete = results.filter((row) => row.coverage.complete),
  positive = complete.filter((row) => row.expected.new > 0),
  negative = complete.filter((row) => row.expected.new === 0);
const summary = {
  schema_version: 1,
  started_at: started,
  finished_at: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  manifest_sha256: hash(registration),
  source_manifest: relative(resolve("."), join(output, "registration.json"))
    .split(sep)
    .join("/"),
  total: results.length,
  matched: results.filter((row) => row.matched).length,
  complete: complete.length,
  incomplete: results.length - complete.length,
  accuracy_on_complete: {
    true_positive: positive.filter((row) => row.counts.new > 0).length,
    false_negative: positive.filter((row) => row.counts.new === 0).length,
    true_negative: negative.filter((row) => row.counts.new === 0).length,
    false_positive: negative.filter((row) => row.counts.new > 0).length,
  },
  ci_helper_exits_verified: [0, 1, 2],
  results,
};
writeFileSync(
  "eval/summaries/checker.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
if (summary.matched !== summary.total) process.exitCode = 1;
