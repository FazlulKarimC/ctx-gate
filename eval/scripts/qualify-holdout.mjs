import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  readdirSync,
  realpathSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { exportTree } from "./git-tree.mjs";

const input = readFileSync("eval/manifests/holdout-readiness.json"),
  manifest = JSON.parse(input),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const selected = process.argv
  .find((arg) => arg.startsWith("--tasks="))
  ?.slice(8)
  .split(",");
const tasks = selected
  ? manifest.tasks.filter((task) => selected.includes(task.id))
  : manifest.tasks;
if (selected && tasks.length !== selected.length)
  throw Error("Unknown/duplicate task selection");
const runtimeOnly = process.argv.includes("--runtime-only");
const legacyCompatibility = process.argv.includes("--runtime-only-legacy");
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        operation: "holdout_assessment_preview",
        tasks: tasks.map((task) => task.id),
        model_calls: 0,
        installs:
          "--execute installs runtime dependencies with lifecycle scripts disabled and runs protected behavioral assessments only; no retrieval or agents.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = resolve("eval/runs/holdout-qualification", runId),
  parent = resolve("eval/.cache/holdout-qualification", runId),
  dependencyParent = resolve(".cache/hdeps");
mkdirSync(output, { recursive: true });
mkdirSync(parent, { recursive: true });
mkdirSync(dependencyParent, { recursive: true });
copyFileSync(
  "eval/manifests/holdout-readiness.json",
  join(output, "registered-readiness.json"),
);
const scripts = [
  "eval/scripts/qualify-holdout.mjs",
  "eval/scripts/git-tree.mjs",
  "eval/labels/holdout-regressions.cjs",
  "eval/labels/holdout-modern.mjs",
];
for (const path of scripts) {
  const destination = join(output, "source", path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(path, destination);
}
writeFileSync(
  join(output, "registration.json"),
  JSON.stringify(
    {
      schema_version: 1,
      registered_at: new Date().toISOString(),
      readiness_sha256: sha(input),
      scripts: scripts.map((path) => ({
        path,
        sha256: sha(readFileSync(path)),
      })),
      model_calls: 0,
      holdout_queries: 0,
    },
    null,
    2,
  ) + "\n",
);
const git = (repo, args) =>
  execFileSync("git", ["-C", "eval/.cache/upstream/" + repo, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const npmCli =
  process.env.npm_execpath ??
  (process.platform === "win32"
    ? join(
        process.env.ProgramFiles ?? "C:/Program Files",
        "nodejs/node_modules/npm/bin/npm-cli.js",
      )
    : realpathSync(
        execFileSync("which", ["npm"], { encoding: "utf8" }).trim(),
      ));
const dependencies = new Map(),
  results = [];
for (const task of tasks) {
  const taskRuntimeOnly =
    runtimeOnly ||
    (legacyCompatibility &&
      ["json-server-h07", "json-server-h08"].includes(task.id));
  console.log(JSON.stringify({ event: "task_start", id: task.id }));
  const pkg = JSON.parse(
      git(task.repository, ["show", task.base_commit + ":package.json"]),
    ),
    dependencyKey = sha(
      JSON.stringify({
        dependencies: pkg.dependencies ?? {},
        runtime_only: taskRuntimeOnly,
      }),
    ),
    deps = join(dependencyParent, dependencyKey);
  let setup = dependencies.get(dependencyKey);
  if (!setup) {
    mkdirSync(deps, { recursive: true });
    let lockText;
    try {
      lockText = git(task.repository, [
        "show",
        task.base_commit + ":package-lock.json",
      ]);
    } catch {}
    const cleanPackage = { ...pkg };
    delete cleanPackage.scripts;
    delete cleanPackage.workspaces;
    // Preserve lock-compatible declared dependencies. Dev deps are omitted at install.
    writeFileSync(
      join(deps, "package.json"),
      JSON.stringify(cleanPackage, null, 2) + "\n",
    );
    if (taskRuntimeOnly) {
      delete cleanPackage.devDependencies;
      writeFileSync(
        join(deps, "package.json"),
        JSON.stringify(cleanPackage, null, 2) + "\n",
      );
    }
    if (lockText && !taskRuntimeOnly)
      writeFileSync(join(deps, "package-lock.json"), lockText);
    const started = performance.now(),
      args = [
        npmCli,
        lockText && !taskRuntimeOnly ? "ci" : "install",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--cache",
        resolve("eval/.cache/npm"),
      ];
    const installed = Object.keys(pkg.dependencies ?? {}).length
      ? spawnSync(process.execPath, args, {
          cwd: deps,
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        })
      : {
          status: 0,
          stdout: "No runtime dependencies; installation skipped.",
          stderr: "",
        };
    writeFileSync(
      join(output, dependencyKey + "-install.log"),
      (installed.stdout ?? "") + "\n" + (installed.stderr ?? ""),
    );
    setup = {
      dependency_key: dependencyKey,
      status: installed.status === 0 ? "ready" : "infrastructure_invalid",
      elapsed_ms: performance.now() - started,
      source_lock_available: !!lockText,
      dependency_mode: taskRuntimeOnly
        ? "runtime_only_regenerated_lock"
        : "upstream_package_and_lock_when_available",
      lock_sha256: existsSync(join(deps, "package-lock.json"))
        ? sha(readFileSync(join(deps, "package-lock.json")))
        : null,
      error: installed.error?.message ?? null,
      exit_code: installed.status,
    };
    dependencies.set(dependencyKey, setup);
    if (
      Object.keys(pkg.dependencies ?? {}).length &&
      setup.status === "ready"
    ) {
      const locks = resolve("eval/manifests/holdout-locks");
      mkdirSync(locks, { recursive: true });
      copyFileSync(
        join(deps, "package-lock.json"),
        join(locks, dependencyKey + ".json"),
      );
    }
  }
  const result = {
    id: task.id,
    base_commit: task.base_commit,
    fix_commit: task.fix_commit,
    setup,
  };
  if (setup.status !== "ready") {
    results.push({ ...result, status: "setup_incomplete" });
    continue;
  }
  for (const [side, commit] of [
    ["before", task.base_commit],
    ["after", task.fix_commit],
  ]) {
    const root = join(parent, task.id, side);
    await exportTree("eval/.cache/upstream/" + task.repository, commit, root);
    if (Object.keys(pkg.dependencies ?? {}).length) {
      try {
        symlinkSync(
          join(deps, "node_modules"),
          join(root, "node_modules"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (!["EPERM", "EACCES"].includes(error.code)) throw error;
        cpSync(join(deps, "node_modules"), join(root, "node_modules"), {
          recursive: true,
        });
      }
    }
    if (["json-server-h04", "json-server-h05"].includes(task.id)) {
      for (const entry of readdirSync(join(root, "src"), {
        withFileTypes: true,
      })) {
        if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          const path = join(root, "src", entry.name),
            source = readFileSync(path, "utf8");
          const compiled = ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          });
          writeFileSync(path.replace(/\.ts$/, ".js"), compiled.outputText);
        }
      }
    }
    const start = performance.now(),
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
      signal: execution.signal,
      timed_out: execution.error?.code === "ETIMEDOUT",
      elapsed_ms: performance.now() - start,
      stdout: execution.stdout,
      stderr: execution.stderr,
      error: execution.error?.message ?? null,
    };
  }
  result.status =
    result.before.exit_code !== 0 &&
    !/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EBADPLATFORM/.test(
      result.before.stderr ?? "",
    ) &&
    !result.before.timed_out &&
    result.after.exit_code === 0
      ? "fail_before_pass_after"
      : "needs_review";
  results.push(result);
  writeFileSync(
    join(output, task.id + ".json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      event: "task_complete",
      id: task.id,
      status: result.status,
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
  readiness_sha256: sha(input),
  tasks: results.length,
  verified: results.filter(
    (result) => result.status === "fail_before_pass_after",
  ).length,
  model_calls: 0,
  holdout_queries: 0,
  agent_runs_allowed: false,
  results,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
if (existsSync("eval/summaries/holdout-qualification.json"))
  copyFileSync(
    "eval/summaries/holdout-qualification.json",
    join(output, "previous-summary.json"),
  );
writeFileSync(
  "eval/summaries/holdout-qualification.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    tasks: summary.tasks,
    verified: summary.verified,
    report: join(output, "report.json"),
  }),
);
if (summary.verified !== summary.tasks) process.exitCode = 2;
