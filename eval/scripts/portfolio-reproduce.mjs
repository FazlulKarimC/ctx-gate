import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  realpath,
  mkdtemp,
} from "node:fs/promises";
import { dirname, join, resolve, delimiter, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
if (process.versions.node.split(".")[0] !== "24")
  throw Error("Select Node 24 first.");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  parent = join(project, ".cache/portfolio-reproduce");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, "run-")),
  root = join(output, "source");
await mkdir(root);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schema_version: 1,
  operation: "clean_source_copy_reproduction",
  created_at: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  output,
  root,
  model_calls: 0,
  git_commit: null,
  source_copy: {},
  stages: [],
  passed: false,
};
const selected = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "examples/demo.mjs",
  "tests/fixtures",
  "tests/retrieval.test.mjs",
  "tests/checker.test.mjs",
];
for (const path of selected) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await cp(join(project, path), join(root, path), {
    recursive: true,
    filter: (path) => !/[\\/]\.ctx[\\/]cache(?:[\\/]|$)/.test(path),
  });
}
async function inventory(prefix = "") {
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) await inventory(path);
    else {
      const bytes = await readFile(join(root, path));
      if (digest(bytes) !== digest(await readFile(join(project, path))))
        throw Error("Source-copy mismatch: " + path);
      report.source_copy[path] = digest(bytes);
    }
  }
}
await inventory();
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
env.PATH = dirname(process.execPath) + delimiter + (process.env.PATH ?? "");
async function npmCli() {
  const candidates = [
    process.env.CTXGATE_NPM_CLI,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
  ].filter(Boolean);
  try {
    if (process.platform === "win32") {
      for (const file of execFileSync("where.exe", ["npm.cmd"], {
        encoding: "utf8",
        windowsHide: true,
      })
        .trim()
        .split(/\r?\n/))
        candidates.push(join(dirname(file), "node_modules/npm/bin/npm-cli.js"));
    } else
      candidates.push(
        await realpath(
          execFileSync("which", ["npm"], { encoding: "utf8" }).trim(),
        ),
      );
  } catch {}
  for (const file of candidates) {
    try {
      if (basename(file) === "npm-cli.js" && (await stat(file)).isFile())
        return file;
    } catch {}
  }
  throw Error(
    "npm CLI not found. Set CTXGATE_NPM_CLI to your installed npm-cli.js; no global setup is changed.",
  );
}
async function run(name, args, timeout = 180000) {
  const start = performance.now(),
    result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
  await writeFile(join(output, name + ".stdout.txt"), result.stdout ?? "");
  await writeFile(join(output, name + ".stderr.txt"), result.stderr ?? "");
  const value = {
    name,
    exit_code: result.status,
    error: result.error?.message ?? null,
    elapsed_ms: performance.now() - start,
  };
  report.stages.push(value);
  return { ...value, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
try {
  const npm = await npmCli(),
    cache = join(project, "eval/.cache/npm");
  let installed = await run("install-offline", [
    npm,
    "ci",
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--cache",
    cache,
  ]);
  if (
    installed.exit_code !== 0 &&
    /ENOTCACHED/.test(installed.stderr + installed.stdout) &&
    process.argv.includes("--allow-network")
  )
    installed = await run("install-locked-network", [
      npm,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
    ]);
  if (installed.exit_code !== 0)
    throw Error(
      "Locked install failed; inspect retained install logs. Offline cache may need --allow-network on a trusted network.",
    );
  if ((await run("build", ["node_modules/typescript/bin/tsc"])).exit_code !== 0)
    throw Error("Clean build failed");
  const doctor = await run("doctor", ["dist/cli/index.js", "doctor", "--json"]);
  if (doctor.exit_code !== 0) throw Error("Doctor failed");
  const tests = await run("selected-tests", [
    "--test",
    "--test-reporter=tap",
    "tests/retrieval.test.mjs",
    "tests/checker.test.mjs",
  ]);
  report.selected_test_count = Number(
    tests.stdout.match(/# tests (\d+)/)?.[1] ?? 0,
  );
  if (tests.exit_code !== 0 || !report.selected_test_count)
    throw Error("Selected correctness tests failed");
  const demo = await run("demo", ["examples/demo.mjs"]);
  if (demo.exit_code !== 0) throw Error("Clean-copy demo failed");
  report.demo = JSON.parse(demo.stdout);
  report.passed = report.demo.verified === true;
} catch (error) {
  report.error = error.message;
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(project, "eval/summaries/portfolio-reproduction.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      output,
      passed: report.passed,
      selected_test_count: report.selected_test_count ?? null,
      stages: report.stages,
      error: report.error ?? null,
    },
    null,
    2,
  ),
);
process.exitCode = report.passed ? 0 : 2;
