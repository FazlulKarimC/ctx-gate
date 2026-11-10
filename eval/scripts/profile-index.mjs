import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, release, cpus, totalmem } from "node:os";
import { initialize, refreshIndex, captureWorktree } from "../../dist/index.js";
import { exportTree } from "./git-tree.mjs";

// Local analysis only: never executes upstream scripts or calls a model.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = JSON.parse(
  await readFile(join(root, "eval/manifests/corpus.json"), "utf8"),
);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(root, "eval/runs/index-profile", runId);
await mkdir(output, { recursive: true });
const results = [];
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
for (const repo of corpus.repositories) {
  const workspace = join(root, "eval/.cache/index-profile", runId, repo.id);
  const exportStart = performance.now();
  const exported = await exportTree(
    join(root, "eval/.cache/upstream", repo.id),
    repo.observed_head,
    workspace,
  );
  const preparationMs = performance.now() - exportStart;
  await initialize(workspace);
  const cold = refreshIndex(workspace);
  const warm = Array.from({ length: 5 }, () => refreshIndex(workspace));
  const view = captureWorktree(workspace).view;
  const source = [...view.files.values()].find(
    (file) => file.kind === "source" && !file.path.endsWith(".d.ts"),
  );
  if (!source) throw new Error("No source to edit in " + repo.id);
  // One harmless source-byte edit; restore it before leaving the profile workspace.
  await writeFile(
    join(workspace, source.path),
    source.text + "\n// ctxgate indexing profile\n",
  );
  let edit;
  try {
    edit = refreshIndex(workspace);
  } finally {
    await writeFile(join(workspace, source.path), source.text);
  }
  const restored = refreshIndex(workspace);
  const result = {
    repository: repo.id,
    commit: repo.observed_head,
    exported,
    preparation_ms: preparationMs,
    cold,
    warm,
    edit_path: source.path,
    small_edit: edit,
    restored,
    warm_summary_ms: {
      n: warm.length,
      p50: percentile(
        warm.map((r) => r.timings_ms.total),
        0.5,
      ),
      p95: percentile(
        warm.map((r) => r.timings_ms.total),
        0.95,
      ),
    },
    database_bytes: (await stat(cold.database)).size,
  };
  results.push(result);
  console.log(
    JSON.stringify({
      repository: repo.id,
      cold_ms: cold.timings_ms.total,
      warm: result.warm_summary_ms,
      edit_ms: edit.timings_ms.total,
      files: cold.files,
      status: cold.status,
    }),
  );
}
const report = {
  schema_version: 1,
  operation: "index_profile",
  created_at: new Date().toISOString(),
  runtime: process.version,
  platform: {
    system: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    memory_bytes: totalmem(),
  },
  methodology:
    "One cold build and five unchanged refreshes per exported pinned head in one process, followed by a one-file comment edit and restoration. Fresh cache, OS file cache uncontrolled; not cold-disk measurements. p95 is the largest of five observations. No model/upstream scripts. RSS peak is cumulative for the whole process; units KiB on supported Node platforms. Git exports have no .git, so Git subprocess overhead is excluded; real-worktree correctness is separately tested.",
  process_peak_rss_kib: process.resourceUsage().maxRSS,
  results,
};
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const summary = {
  ...report,
  results: results.map(({ cold, warm, small_edit, restored, ...rest }) => ({
    ...rest,
    cold: {
      files: cold.files,
      source_files: cold.source_files,
      bytes: cold.bytes,
      status: cold.status,
      symbols: cold.symbol_count,
      imports: cold.import_count,
      timings_ms: cold.timings_ms,
      coverage_reasons: Object.fromEntries(
        [...new Set(cold.coverage.reasons.map((r) => r.code))].map((code) => [
          code,
          cold.coverage.reasons.filter((r) => r.code === code).length,
        ]),
      ),
    },
    warm_samples_ms: warm.map((r) => r.timings_ms),
    warm_parsed_files: warm.map((r) => r.parsed_files),
    small_edit: {
      parsed_files: small_edit.parsed_files,
      reused_files: small_edit.reused_files,
      timings_ms: small_edit.timings_ms,
    },
    restored_generation: restored.generation,
  })),
};
await writeFile(
  join(root, "eval/summaries/index-profile.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify({ report: join(output, "report.json") }));
