import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = readFileSync("eval/manifests/holdout-readiness.json"),
  manifest = JSON.parse(bytes),
  parent = resolve("eval/.cache/holdout-qualification");
const reports = readdirSync("eval/runs/holdout-qualification")
  .filter((name) =>
    existsSync(join("eval/runs/holdout-qualification", name, "report.json")),
  )
  .sort()
  .map((name) =>
    JSON.parse(
      readFileSync(
        join("eval/runs/holdout-qualification", name, "report.json"),
      ),
    ),
  );
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = resolve("eval/runs/holdout-audit", runId);
mkdirSync(output, { recursive: true });
const assessmentPaths = [
  "eval/labels/holdout-regressions.cjs",
  "eval/labels/holdout-modern.mjs",
];
const assessments = assessmentPaths.map((path) => {
  copyFileSync(path, join(output, path.split("/").at(-1)));
  return { path, sha256: hash(readFileSync(path)) };
});
copyFileSync(
  "eval/manifests/holdout-readiness.json",
  join(output, "registered-readiness.json"),
);
copyFileSync(
  "eval/scripts/audit-holdout.mjs",
  join(output, "audit-holdout.mjs"),
);
writeFileSync(
  join(output, "registration.json"),
  JSON.stringify(
    {
      registered_at: new Date().toISOString(),
      manifest_sha256: hash(bytes),
      assessments,
      method:
        "Final replay using the same frozen assessment source for all 18 tasks. Reuse protected dependency-prepared source exports; verify pinned changed source/package files before every execution. No retrieval/models/tuning.",
    },
    null,
    2,
  ) + "\n",
);
const results = [];
for (const task of manifest.tasks) {
  const candidates = reports.flatMap((report) =>
    report.results
      .filter(
        (row) =>
          row.id === task.id &&
          row.setup?.status === "ready" &&
          row.before &&
          row.after,
      )
      .map((row) => ({ report, row })),
  );
  const chosen =
    [...candidates]
      .reverse()
      .find((candidate) => candidate.row.status === "fail_before_pass_after") ??
    candidates.at(-1);
  if (!chosen) throw Error("No runnable source setup for " + task.id);
  const result = {
    id: task.id,
    qualification_run: chosen.report.run_id,
    setup: chosen.row.setup,
    base_commit: task.base_commit,
    fix_commit: task.fix_commit,
    assessment_sha256: assessments.find(
      (a) => a.path === task.assessment.script,
    ).sha256,
  };
  for (const [side, commit] of [
    ["before", task.base_commit],
    ["after", task.fix_commit],
  ]) {
    const root = resolve(parent, chosen.report.run_id, task.id, side),
      rel = relative(parent, root);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw Error("Invalid retained root");
    for (const path of [...task.source_files_changed, "package.json"]) {
      const expected = execFileSync(
        "git",
        [
          "-C",
          "eval/.cache/upstream/" + task.repository,
          "show",
          commit + ":" + path,
        ],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 },
      );
      if (hash(readFileSync(join(root, path))) !== hash(expected))
        throw Error(
          "Changed qualification source: " + task.id + " " + side + " " + path,
        );
    }
    const started = performance.now(),
      execution = spawnSync(
        process.execPath,
        [resolve(task.assessment.script), root, task.id],
        {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, NODE_ENV: "test" },
        },
      );
    result[side] = {
      exit_code: execution.status,
      timed_out: execution.error?.code === "ETIMEDOUT",
      elapsed_ms: performance.now() - started,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
  }
  result.verified =
    result.before.exit_code !== 0 &&
    !result.before.timed_out &&
    !/Cannot find module|MODULE_NOT_FOUND|EBADPLATFORM/.test(
      result.before.stderr ?? "",
    ) &&
    result.after.exit_code === 0;
  results.push(result);
  writeFileSync(
    join(output, task.id + ".json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      id: task.id,
      verified: result.verified,
      before: result.before.exit_code,
      after: result.after.exit_code,
    }),
  );
}
const summary = {
  schema_version: 1,
  run_id: runId,
  created_at: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  registration: join(output, "registration.json"),
  readiness_sha256: hash(bytes),
  assessments,
  tasks: results.length,
  verified: results.filter((row) => row.verified).length,
  model_calls: 0,
  holdout_queries: 0,
  agent_runs_allowed: false,
  results,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
writeFileSync(
  "eval/summaries/holdout-readiness.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify({ tasks: summary.tasks, verified: summary.verified }),
);
if (summary.verified !== summary.tasks) process.exitCode = 2;
