import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destination = resolve(root, "eval/manifests/corpus.json");
try {
  await readFile(destination);
  throw new Error(
    "Corpus is already registered. Do not overwrite frozen task IDs.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const specs = [
  {
    id: "picomatch",
    upstream: "micromatch/picomatch",
    role: "library",
    development: 8,
    source: /^(lib\/.*\.js|index\.js|posix\.js)$/,
  },
  {
    id: "json-server",
    upstream: "typicode/json-server",
    role: "API service",
    development: 6,
    source: /^(src|lib)\/.*\.[jt]s$/,
  },
  {
    id: "fastify",
    upstream: "fastify/fastify",
    role: "modular HTTP framework",
    development: 6,
    source: /^(lib\/.*\.js|fastify\.js)$/,
  },
];
const repositories = [];
const tasks = [];
for (const spec of specs) {
  console.log(`Inspecting ${spec.id} historical task candidates...`);
  const repo = resolve(root, "eval/.cache/upstream", spec.id);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    }).trim();
  const head = git("rev-parse", "HEAD");
  const pkg = JSON.parse(git("show", `${head}:package.json`));
  const listing = git("ls-tree", "-r", "-l", head);
  const eligible = listing
    .split("\n")
    .map((line) => line.match(/^\d+ blob \w+\s+(\d+)\t(.+)$/))
    .filter(Boolean)
    .filter((match) => /\.(?:[cm]?[jt]sx?|md|json|jsonc)$/i.test(match[2]));
  const candidates = git(
    "log",
    "--no-merges",
    "--format=%H",
    "--regexp-ignore-case",
    "--grep=fix",
    head,
  ).split("\n");
  const selected = [];
  for (const sha of candidates) {
    const title = git("show", "-s", "--format=%s", sha);
    if (
      /^(docs?|test|chore|ci|build|perf|bump|merge)|fix\(types|fix\(deps|security|redos|prototype|pollut|inject/i.test(
        title,
      )
    )
      continue;
    const parents = git("show", "-s", "--format=%P", sha).split(" ");
    if (parents.length !== 1) continue;
    try {
      git("cat-file", "-e", `${parents[0]}^{commit}`);
    } catch {
      continue;
    }
    const changed = git(
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sha,
    ).split("\n");
    const testFiles = changed.filter((path) =>
      /(^|\/)(test|tests)\/|\.test\.[jt]s$/.test(path),
    );
    const sourceFiles = changed.filter(
      (path) => spec.source.test(path) && !testFiles.includes(path),
    );
    if (!sourceFiles.length || !testFiles.length) continue;
    selected.push({ sha, base: parents[0], title, sourceFiles, testFiles });
    if (selected.length === spec.development + 6) break;
  }
  if (selected.length !== spec.development + 6)
    throw new Error(
      `${spec.id}: need ${spec.development + 6} qualified metadata candidates, found ${selected.length}. Deepen history before registration.`,
    );
  // Split alternating chronological candidates, never by model performance.
  const heldoutIndices = new Set([1, 3, 5, 7, 9, 11]);
  let devIndex = 0;
  let heldoutIndex = 0;
  for (let index = 0; index < selected.length; index++) {
    const candidate = selected[index];
    const split = heldoutIndices.has(index) ? "holdout" : "development";
    const sequence = split === "holdout" ? ++heldoutIndex : ++devIndex;
    tasks.push({
      id: `${spec.id}-${split === "holdout" ? "h" : "d"}${String(sequence).padStart(2, "0")}`,
      repository: spec.id,
      split,
      category: null,
      qualification: "metadata_verified_behavior_pending",
      base_commit: candidate.base,
      fix_commit: candidate.sha,
      title: candidate.title,
      source_files_changed: candidate.sourceFiles,
      assessment_files_changed: candidate.testFiles,
      provenance_url: `https://github.com/${spec.upstream}/commit/${candidate.sha}`,
      prompt: null,
      assessment: null,
    });
  }
  repositories.push({
    id: spec.id,
    upstream: `https://github.com/${spec.upstream}`,
    clone_url: `https://github.com/${spec.upstream}.git`,
    role: spec.role,
    observed_head: head,
    license: pkg.license,
    engines: pkg.engines ?? null,
    package_manager: pkg.packageManager ?? null,
    scripts: pkg.scripts,
    eligible_file_count_at_head: eligible.length,
    eligible_bytes_at_head: eligible.reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    ),
    setup_status: "not_executed",
    category_balance_status: "pending_manual_qualification",
  });
}
const corpus = {
  schema_version: 1,
  registered_on: "2026-10-26",
  status: "candidate_ids_frozen_qualification_in_progress",
  selection:
    "Newest non-merge runtime fixes in fetched history with source and test changes; alternate held-out indices 1,3,5,7,9,11 before behavior inspection. No performance-based selection.",
  category_policy:
    "Category is unassigned until task evidence is inspected; no fabricated cross-file balance. Eligibility replacements need a ledger entry before tuning.",
  repositories,
  tasks,
};
await mkdir(dirname(destination), { recursive: true });
const content = JSON.stringify(corpus, null, 2) + "\n";
await writeFile(destination, content, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      repositories: repositories.map((repo) => ({
        id: repo.id,
        eligible_files: repo.eligible_file_count_at_head,
        eligible_bytes: repo.eligible_bytes_at_head,
      })),
      development: tasks.filter((task) => task.split === "development").length,
      holdout: tasks.filter((task) => task.split === "holdout").length,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
    null,
    2,
  ),
);
