import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [runId, qualificationId] = process.argv.slice(2);
for (const id of [runId, qualificationId])
  if (!id || !/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(id))
    throw new Error(
      "Supply run and qualification timestamp IDs, without paths",
    );
const rows = [];
for (let number = 1; number <= 5; number++) {
  const task = "picomatch-d0" + number;
  const output = join(root, "eval/runs/initial-baseline", runId, task);
  const original = JSON.parse(
    await readFile(join(output, "report.json"), "utf8"),
  );
  const base = join(
    root,
    "eval/.cache/qualification",
    qualificationId,
    task,
    "base",
  );
  const patched = join(root, "eval/.cache/workspaces", runId, task);
  const assessments = {};
  for (const [kind, path] of [
    ["base", base],
    ["patched", patched],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(root, "eval/labels/picomatch-existing.cjs"), path],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (result.error || ![0, 1].includes(result.status))
      throw new Error(
        "Supplemental assessment unavailable: " +
          task +
          " " +
          kind +
          " " +
          result.stderr,
      );
    assessments[kind] = JSON.parse(result.stdout);
  }
  const previous = new Set(assessments.base.failures.map((row) => row.name));
  const newFailures = assessments.patched.failures.filter(
    (row) => !previous.has(row.name),
  );
  const diffs = [];
  for (const change of original.changes) {
    if (!change.before || !change.after) {
      diffs.push({
        path: change.path,
        note: "Added/deleted file requires separate review",
      });
      continue;
    }
    const diff = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "diff",
        "--no-index",
        "--",
        join(base, change.path),
        join(patched, change.path),
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    if (![0, 1].includes(diff.status))
      throw new Error("Diff unavailable: " + task + " " + change.path);
    diffs.push({ path: change.path, patch: diff.stdout });
  }
  const supplemental = {
    existing_tests: assessments,
    new_existing_test_failures: newFailures,
    diffs,
  };
  await writeFile(
    join(output, "supplemental-review.json"),
    JSON.stringify(supplemental, null, 2) + "\n",
  );
  rows.push({
    task_id: task,
    status: original.status,
    focused_regression_passed: original.regression_assessment?.passed ?? null,
    existing_tests_base: assessments.base.total,
    existing_tests_patched: assessments.patched.total,
    existing_tests_patched_failed: assessments.patched.failures.length,
    new_existing_test_failures: newFailures.length,
    elapsed_ms: original.elapsed_ms,
    tool_commands: original.tool_commands,
    usage: original.usage,
    changed_paths: original.changes.map((c) => c.path),
    patch_review:
      "See docs/experiments/recovered-baseline.md; original raw status remains unassessed",
    raw_report: join(
      "eval/runs/initial-baseline",
      runId,
      task,
      "report.json",
    ).replaceAll("\\", "/"),
  });
}
const summary = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  run_id: runId,
  qualification_id: qualificationId,
  condition: "A",
  purpose: "host-only instrumentation; no ctxgate tools",
  attempts: rows.length,
  focused_regressions_passed: rows.filter((r) => r.focused_regression_passed)
    .length,
  supplemental_new_test_failures: rows.reduce(
    (n, r) => n + r.new_existing_test_failures,
    0,
  ),
  model_requested: "gpt-6.1-sol",
  reasoning_requested: "high",
  model_resolved: null,
  controlled_comparison_ready: false,
  limitations: [
    "memory/tool isolation unverified; not a causal comparison",
    "all tasks from Picomatch; d03/d04 share a fix family",
    "selected existing tests use an inspected describe/it subset, not upstream npm test/lint/coverage",
    "focused passing regressions plus source review do not prove all behaviors correct",
    "cached input is a subset of input; missing pricing stays unavailable",
  ],
  rows,
};
await mkdir(join(root, "eval/summaries"), { recursive: true });
await writeFile(
  join(root, "eval/summaries/recovered-baseline.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    attempts: summary.attempts,
    focused_passed: summary.focused_regressions_passed,
    new_existing_failures: summary.supplemental_new_test_failures,
  }),
);
