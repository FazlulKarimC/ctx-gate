import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTree } from "./git-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(root, "eval/manifests/corpus.json");
const corpus = JSON.parse(await readFile(manifestPath, "utf8"));
const qualificationId = new Date().toISOString().replace(/[:.]/g, "-");
const prompts = [
  [
    "picomatch-d01",
    "vague_symptom",
    "Patterns such as **.thing.js and **.js incorrectly match files inside nested directories. A double star adjacent to a literal in the same path segment should behave like a single star. Fix this while preserving matching for files in the current segment and standalone **/ directory traversal. Add regression coverage.",
  ],
  [
    "picomatch-d02",
    "vague_symptom",
    "Globstar matching fails for legal POSIX paths containing newline characters. Make ** and nested globstar patterns support these paths without changing default hidden-file behavior. Add regression coverage.",
  ],
  [
    "picomatch-d03",
    "exact_symbol",
    "picomatch.scan(pattern, { parts: true }) returns incomplete pattern parts. Handle patterns without separators, preserve leading/trailing empty segments, and avoid splitting inside nested or escaped parentheses. Keep prefixes out of the returned parts. Add regression coverage.",
  ],
  [
    "picomatch-d04",
    "exact_symbol",
    'picomatch.scan("a/b/*/c", { tokens: true }) should return parts ["a", "b", "*", "c"], just as the explicit parts option does, instead of stopping at the first glob. Fix the tokens-only behavior and add a regression test.',
  ],
  [
    "picomatch-d05",
    "exact_symbol",
    "picomatch basename/matchBase matching with windows: true fails on backslash-separated and mixed-separator paths. For example foo\\bar.js should match bar.js with basename: true and windows: true. Preserve negative matches and add regression coverage.",
  ],
];
const qualifications = [];
for (const [id, category, prompt] of prompts) {
  const task = corpus.tasks.find((item) => item.id === id);
  if (!task || task.split !== "development")
    throw new Error(`Missing development task: ${id}`);
  const upstream = resolve(root, "eval/.cache/upstream", task.repository);
  const snapshots = {};
  const assessments = {};
  for (const [kind, revision] of [
    ["base", task.base_commit],
    ["fixed", task.fix_commit],
  ]) {
    const target = resolve(
      root,
      "eval/.cache/qualification",
      qualificationId,
      id,
      kind,
    );
    snapshots[kind] = await exportTree(upstream, revision, target);
    const result = spawnSync(
      process.execPath,
      [resolve(root, "eval/labels/picomatch-initial.cjs"), id, target],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    if (result.error || ![0, 1].includes(result.status))
      throw new Error(
        `Assessment infrastructure failed: ${result.error?.message ?? result.stderr}`,
      );
    assessments[kind] = {
      ...JSON.parse(result.stdout),
      exit_code: result.status,
    };
  }
  if (assessments.base.passed || !assessments.fixed.passed)
    throw new Error(
      `Regression did not distinguish pre-fix and fixed trees: ${id}`,
    );
  qualifications.push({ id, snapshots, assessments });
  task.prompt = prompt;
  task.category = category;
  task.qualification = "behavioral_regression_verified";
  task.assessment = {
    script: "eval/labels/picomatch-initial.cjs",
    ground_truth_verified: true,
    review_required_after_tests: true,
  };
}
await mkdir(resolve(root, "eval/summaries"), { recursive: true });
await writeFile(
  resolve(root, "eval/summaries/initial-qualification.json"),
  JSON.stringify(qualifications, null, 2) + "\n",
);
await writeFile(manifestPath, JSON.stringify(corpus, null, 2) + "\n");
