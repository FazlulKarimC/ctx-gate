import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { exportTree } from "./git-tree.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = JSON.parse(readFileSync("eval/summaries/operational.json"));
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = resolve("eval/runs/operational-followup", runId),
  parent = resolve("eval/.cache/operational-followup", runId);
mkdirSync(output, { recursive: true });
mkdirSync(parent, { recursive: true });
const paths = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) collect(file);
    else paths.push(file);
  }
}
collect("src");
paths.push(
  "eval/scripts/operational-followup.mjs",
  "eval/scripts/operational-followup-worker.mjs",
);
const source = paths.sort().map((path) => {
  const destination = join(output, "source", path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(path, destination);
  return { path: path.split(sep).join("/"), sha256: hash(readFileSync(path)) };
});
writeFileSync(
  join(output, "registration.json"),
  JSON.stringify(
    {
      registered_at: new Date().toISOString(),
      original_run: original.run_id,
      source,
      operations:
        "One corrected cold-cache context and standalone immutable baseline capture per scale; three alternating original/corrected warm context pairs, then corrected expansion and check. No tuning. Verify byte-identical ordinary results. New roots from original immutable fixture baselines. No p95 claim for n=3.",
      correction:
        "Validate output against retained captured source; rebuild/retry once on inconsistent derived excerpts.",
    },
    null,
    2,
  ) + "\n",
);
const modules = {
  original: resolve(".cache/phase7-original-rebuild/index.js"),
  corrected: resolve(".cache/phase7-fixed-dist/index.js"),
};
let sequence = 0;
function observe(label, input) {
  const request = join(output, `${sequence++}-${label}-request.json`);
  writeFileSync(request, JSON.stringify(input));
  const start = performance.now(),
    child = spawnSync(
      process.execPath,
      [resolve("eval/scripts/operational-followup-worker.mjs"), request],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  let payload;
  try {
    payload = JSON.parse(child.stdout);
  } catch {}
  const measured = {
    wall_ms: performance.now() - start,
    exit_code: child.status,
    error: child.error?.message ?? null,
    stderr: child.stderr,
    ...payload,
  };
  writeFileSync(
    request.replace("-request", "-result"),
    JSON.stringify(measured, null, 2) + "\n",
  );
  if (child.status !== 0 || !payload) throw Error("Followup failed: " + label);
  return measured;
}
const results = [];
for (const item of original.results) {
  const root = join(parent, item.name),
    start = performance.now();
  await exportTree(item.root, item.base, root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Operational Followup");
  git("config", "user.email", "followup@example.invalid");
  git("add", "--all");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const base = git("rev-parse", "HEAD");
  const preparation_ms = performance.now() - start,
    cold = observe(item.name + "-cold-context", {
      root,
      module: modules.corrected,
      operation: "context",
    }),
    baseline = observe(item.name + "-baseline-capture", {
      root,
      base,
      module: modules.corrected,
      operation: "baseline_capture",
    }),
    pairs = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const pair = {};
    for (const variant of repetition % 2
      ? ["corrected", "original"]
      : ["original", "corrected"])
      pair[variant] = observe(item.name + "-" + variant, {
        root,
        module: modules[variant],
        operation: "context",
      });
    const identical =
      JSON.stringify(pair.original.result) ===
      JSON.stringify(pair.corrected.result);
    if (!identical)
      throw Error("Normal evidence changed after integrity correction");
    pairs.push({
      original_ms: pair.original.wall_ms,
      corrected_ms: pair.corrected.wall_ms,
      original_rss_kib: pair.original.peak_rss_kib,
      corrected_rss_kib: pair.corrected.peak_rss_kib,
      byte_identical: identical,
    });
  }
  const expanded = observe(item.name + "-expand", {
      root,
      module: modules.corrected,
      operation: "expand",
      reference: cold.result.items[0].reference,
    }),
    checked = observe(item.name + "-check", {
      root,
      base,
      module: modules.corrected,
      operation: "check",
    });
  const result = {
    name: item.name,
    root,
    base,
    preparation_ms,
    cold_context_ms: cold.wall_ms,
    cold_context_peak_rss_kib: cold.peak_rss_kib,
    coverage_complete: cold.result.coverage.complete,
    standalone_baseline_capture_ms: baseline.wall_ms,
    baseline_capture_internal_ms: baseline.result.scan_ms,
    baseline_files: baseline.result.files,
    pairs,
    corrected_expansion_ms: expanded.wall_ms,
    corrected_check_ms: checked.wall_ms,
    corrected_check_exit: checked.result.exit_code,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const summary = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  run_id: runId,
  original_run: original.run_id,
  registration: relative(resolve("."), join(output, "registration.json"))
    .split(sep)
    .join("/"),
  runtime: process.version,
  platform: process.platform,
  results,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
writeFileSync(
  "eval/summaries/operational-followup.json",
  JSON.stringify(summary, null, 2) + "\n",
);
