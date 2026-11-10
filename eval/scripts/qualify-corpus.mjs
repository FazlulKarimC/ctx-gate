import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));
const corpus = await read("eval/manifests/corpus.json"),
  review = await read("eval/labels/candidate-review.json");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const originalHash = sha(
  await readFile(join(root, "eval/manifests/corpus.json")),
);
if (
  review.original_decisions.length !== 38 ||
  new Set(review.original_decisions.map((row) => row.id)).size !== 38
)
  throw new Error("Review every original ID exactly once");
const active = [],
  audit = [];
for (const task of [...corpus.tasks, ...review.replacements]) {
  const decision =
    review.original_decisions.find((row) => row.id === task.id) ?? task;
  const repository = corpus.repositories.find(
    (row) => row.id === task.repository,
  );
  if (
    !decision.family ||
    !["exact_symbol", "vague_symptom", "cross_file"].includes(decision.category)
  )
    throw new Error("Missing review " + task.id);
  const options = {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  };
  const git = (...args) =>
    execFileSync(
      "git",
      ["-C", join(root, "eval/.cache/upstream", task.repository), ...args],
      options,
    );
  const parents = git("show", "-s", "--format=%P", task.fix_commit)
    .trim()
    .split(" ");
  if (parents.length !== 1 || parents[0] !== task.base_commit)
    throw new Error("Not the pinned pre-fix parent: " + task.id);
  git("merge-base", "--is-ancestor", task.fix_commit, repository.observed_head);
  const diff = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    task.base_commit,
    task.fix_commit,
    "--",
    ...task.source_files_changed,
  );
  const sourcePatch = execFileSync("git", ["patch-id", "--stable"], {
    ...options,
    input: diff,
  })
    .trim()
    .split(" ")[0];
  if (!sourcePatch) throw new Error("Missing source change: " + task.id);
  for (const path of task.source_files_changed)
    if (!/\.[cm]?[jt]sx?$/.test(path))
      throw new Error("Unsupported source extension: " + task.id);
  let pkg = {};
  try {
    pkg = JSON.parse(git("show", task.base_commit + ":package.json"));
  } catch {
    /* Absence is reported, not fabricated. */
  }
  const evidence = {
    id: task.id,
    origin: decision.origin,
    disposition: decision.disposition,
    reason: decision.reason,
    category: decision.category,
    family: decision.family,
    fix_commit: task.fix_commit,
    base_commit: task.base_commit,
    source_patch_id: sourcePatch,
    source_diff_sha256: sha(diff),
    committed_at: git("show", "-s", "--format=%cI", task.fix_commit).trim(),
    package_version: pkg.version ?? null,
    engines: pkg.engines ?? null,
  };
  audit.push(evidence);
  if (decision.disposition === "retain_agent_pool")
    active.push({
      ...task,
      category: decision.category,
      family: decision.family,
      qualification:
        task.qualification === "behavioral_regression_verified"
          ? task.qualification
          : "metadata_qualified_behavior_pending",
      review_reason: decision.reason,
      source_patch_id: sourcePatch,
      provenance_url:
        task.provenance_url ??
        repository.upstream + "/commit/" + task.fix_commit,
    });
}
const development = active.filter((row) => row.split === "development"),
  holdout = active.filter((row) => row.split === "holdout");
if (
  active.length !== 38 ||
  development.length !== 20 ||
  holdout.length !== 18 ||
  new Set(active.map((row) => row.id)).size !== 38
)
  throw new Error("Need 20 distinct development and 18 distinct holdout IDs");
const protectedFamilies = new Set([
  ...review.protected_diagnostic_families,
  ...development.map((row) => row.family),
]);
const overlaps = holdout.filter((row) => protectedFamilies.has(row.family));
if (overlaps.length)
  throw new Error(
    "Cross-split family overlap: " + overlaps.map((row) => row.id).join(","),
  );
if (new Set(active.map((row) => row.source_patch_id)).size !== active.length)
  throw new Error("Duplicate source patch in active pool");
for (const repository of corpus.repositories)
  if (holdout.filter((row) => row.repository === repository.id).length !== 6)
    throw new Error("Need six held-out tasks per repository");
const groups = Object.fromEntries(
  [...new Set(active.map((row) => row.family))]
    .sort()
    .map((family) => [
      family,
      active.filter((row) => row.family === family).map((row) => row.id),
    ]),
);
const countBy = (rows, key) =>
  Object.fromEntries(
    [...new Set(rows.map((row) => row[key]))]
      .sort()
      .map((value) => [value, rows.filter((row) => row[key] === value).length]),
  );
const selectionHash = sha(JSON.stringify(active));
const manifest = {
  schema_version: 1,
  version: "agent-pool-v2",
  created_at: new Date().toISOString(),
  status: "metadata_and_family_qualified_behavior_pending",
  original_manifest_sha256: originalHash,
  review_sha256: sha(
    await readFile(join(root, "eval/labels/candidate-review.json")),
  ),
  selection_hash: selectionHash,
  policy: "eval/manifests/qualification-policy.json",
  limitations: review.limitations,
  agent_runs_allowed: false,
  tasks: active,
};
const summary = {
  schema_version: 1,
  created_at: manifest.created_at,
  selection_hash: selectionHash,
  original_manifest_unchanged:
    originalHash ===
    sha(await readFile(join(root, "eval/manifests/corpus.json"))),
  original_count: 38,
  excluded_originals: audit.filter(
    (row) => row.disposition === "excluded_agent_pool",
  ).length,
  replacement_count: review.replacements.length,
  active_count: active.length,
  development_count: development.length,
  holdout_count: holdout.length,
  development_families: new Set(development.map((row) => row.family)).size,
  holdout_families: new Set(holdout.map((row) => row.family)).size,
  cross_split_family_overlaps: overlaps,
  exact_source_patch_duplicates: 0,
  categories: {
    development: countBy(development, "category"),
    holdout: countBy(holdout, "category"),
  },
  behaviorally_verified: active.filter(
    (row) => row.qualification === "behavioral_regression_verified",
  ).length,
  holdout_queried: false,
  model_calls: 0,
  related_families: Object.fromEntries(
    Object.entries(groups).filter(([, ids]) => ids.length > 1),
  ),
  audit,
};
if (process.argv.includes("--verify")) {
  const existing = await read("eval/manifests/agent-pool.json");
  if (
    existing.selection_hash !== selectionHash ||
    existing.original_manifest_sha256 !== originalHash ||
    existing.review_sha256 !== manifest.review_sha256
  )
    throw new Error("Qualification inputs differ from frozen pool");
  console.log(
    JSON.stringify({
      status: "verified",
      active: active.length,
      development: development.length,
      holdout: holdout.length,
      holdout_families: summary.holdout_families,
    }),
  );
} else {
  await writeFile(
    join(root, "eval/manifests/agent-pool.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    join(root, "eval/summaries/corpus-qualification.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: "frozen_metadata_pool",
      active: active.length,
      development: development.length,
      holdout: holdout.length,
      categories: summary.categories,
      related_families: summary.related_families,
    }),
  );
}
