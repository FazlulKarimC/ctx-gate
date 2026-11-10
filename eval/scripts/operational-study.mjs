import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";

const policyBytes = readFileSync("eval/manifests/operational-policy.json"),
  policy = JSON.parse(policyBytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  output = resolve("eval/runs/operational", runId),
  parent = resolve("eval/.cache/operational", runId);
mkdirSync(output, { recursive: true });
mkdirSync(parent, { recursive: true });
const files = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) collect(file);
    else files.push(file);
  }
}
collect("src");
collect("eval/scripts");
files.push(
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "eval/manifests/operational-policy.json",
);
const source = files.sort().map((path) => {
  const bytes = readFileSync(path),
    destination = join(output, "source", path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  writeFileSync(destination, bytes);
  return { path: path.split(sep).join("/"), sha256: sha(bytes) };
});
writeFileSync(
  join(output, "registration.json"),
  JSON.stringify(
    {
      schema_version: 1,
      registered_at: new Date().toISOString(),
      policy_sha256: sha(policyBytes),
      source,
    },
    null,
    2,
  ) + "\n",
);
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
function write(root, path, text) {
  mkdirSync(resolve(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}
function fixture(name, count, documents = 0) {
  const root = mkdtempSync(join(parent, name + "-")),
    start = performance.now();
  write(
    root,
    ".ctx/config.json",
    JSON.stringify({
      schema_version: 1,
      roots: ["src"],
      rules: [
        {
          id: "ui-no-db",
          kind: "deny_import",
          from: "src/ui/**",
          to: "src/db/**",
          explanation: "Use a service boundary.",
        },
      ],
    }),
  );
  write(root, ".gitignore", ".ctx/cache/\n");
  write(root, "package.json", '{"name":"operational-fixture","private":true}');
  write(
    root,
    "tsconfig.json",
    '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}',
  );
  write(
    root,
    "src/ui/view.ts",
    'export { feature00000 } from "../services/item00000";\n',
  );
  write(root, "src/db/storage.ts", "export const readStorage = () => 1;\n");
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(5, "0"),
      header = `export function feature${id}(value: number) { return value + ${i}; }\n`;
    write(
      root,
      `src/services/item${id}.ts`,
      header +
        "// " +
        ("deterministic body " + id + " ")
          .repeat(30)
          .slice(0, Math.max(0, policy.source_body_bytes - header.length - 4)) +
        "\n",
    );
  }
  for (let i = 0; i < documents; i++)
    write(
      root,
      `src/blobs/doc${i}.md`,
      "A".repeat(policy.byte_probe.bytes_per_document - 1) + "\n",
    );
  const generation_ms = performance.now() - start,
    gitStart = performance.now();
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Operational Fixture");
  git(root, "config", "user.email", "operations@example.invalid");
  git(root, "add", "--all");
  git(
    root,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  );
  const base = git(root, "rev-parse", "HEAD");
  return {
    root,
    base,
    generation_ms,
    git_preparation_ms: performance.now() - gitStart,
  };
}
let sequence = 0;
async function observe(label, input) {
  const request = join(
    output,
    `${String(sequence++).padStart(4, "0")}-${label}-request.json`,
  );
  writeFileSync(request, JSON.stringify(input));
  const start = performance.now();
  const observation = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      [resolve("eval/scripts/operational-worker.mjs"), request],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      timed_out = false;
    const timer = setTimeout(() => {
      timed_out = true;
      if (process.platform === "win32" && child.pid) {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
          });
        } catch {
          child.kill();
        }
      } else child.kill("SIGKILL");
    }, policy.operation_timeout_ms);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.length > 8 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (bytes) => {
      stderr = (stderr + bytes).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        wall_ms: performance.now() - start,
        timed_out,
        error: error.message,
      });
    });
    child.on("close", (exit_code, signal) => {
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {}
      done({
        wall_ms: performance.now() - start,
        timed_out,
        exit_code,
        signal,
        stderr,
        ...payload,
        ...(!payload ? { error: "Missing worker result" } : {}),
      });
    });
  });
  writeFileSync(
    request.replace("-request.json", "-result.json"),
    JSON.stringify(observation, null, 2) + "\n",
  );
  const { result, ...metrics } = observation;
  return {
    ...metrics,
    status: result?.status,
    coverage_complete: result?.coverage?.complete,
    coverage_reason_count: result?.coverage?.reasons?.length,
    files: result?.files,
    bytes: result?.bytes,
    parsed_files: result?.parsed_files,
    reused_files: result?.reused_files,
    timings_ms: result?.timings_ms,
    check_exit: result?.exit_code,
    counts: result?.counts,
    reference: result?.items?.[0]?.reference,
  };
}
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const summarize = (samples) => ({
  n: samples.length,
  p50_ms: percentile(
    samples.map((sample) => sample.wall_ms),
    0.5,
  ),
  p95_ms: percentile(
    samples.map((sample) => sample.wall_ms),
    0.95,
  ),
  max_peak_rss_kib: Math.max(
    ...samples.map((sample) => sample.peak_rss_kib ?? 0),
  ),
  failures: samples.filter(
    (sample) =>
      sample.error ||
      sample.timed_out ||
      sample.exit_code !== 0 ||
      sample.coverage_complete === false,
  ).length,
});
const results = [];
const cases = [
  ...policy.file_scales.map((count) => ({
    name: `files-${count + 6}`,
    count,
    repetitions: policy.warm_repetitions,
  })),
  {
    name: "bytes-near-100MiB",
    count: 1,
    documents: policy.byte_probe.documents,
    repetitions: policy.byte_probe.repetitions,
  },
];
for (const item of cases) {
  console.log(JSON.stringify({ event: "case_start", name: item.name }));
  const prepared = fixture(item.name, item.count, item.documents),
    { root, base } = prepared,
    result = { ...item, ...prepared, samples: {}, summaries: {} };
  result.cold_index = await observe(item.name + "-cold-index", {
    root,
    operation: "index",
  });
  if (
    result.cold_index.error ||
    result.cold_index.timed_out ||
    result.cold_index.coverage_complete === false
  ) {
    result.stopped = "cold indexing failed/incomplete";
    results.push(result);
    continue;
  }
  for (let repetition = 0; repetition < item.repetitions; repetition++) {
    const specs = [
      ["warm_index", { operation: "index" }],
      ["context_estimate", { operation: "context", encoding: "estimate" }],
      ["context_exact", { operation: "context", encoding: "o200k_base" }],
      ["expand", { operation: "expand" }],
      ["check_worktree", { operation: "check", base }],
      ["check_commit", { operation: "check", base, target: base }],
    ];
    for (const [name, spec] of specs) {
      if (name === "expand") {
        spec.reference = result.samples.context_estimate.at(-1)?.reference;
        if (!spec.reference) throw Error("No expansion reference");
      }
      const measured = await observe(item.name + "-" + name, { root, ...spec });
      (result.samples[name] ??= []).push(measured);
      if (
        measured.error ||
        measured.timed_out ||
        measured.exit_code !== 0 ||
        measured.coverage_complete === false ||
        (measured.check_exit !== undefined && measured.check_exit !== 0)
      ) {
        result.stopped = "Failed " + name;
        break;
      }
    }
    console.log(
      JSON.stringify({
        event: "repetition",
        name: item.name,
        repetition: repetition + 1,
      }),
    );
    if (result.stopped) break;
  }
  if (result.stopped) {
    results.push(result);
    writeFileSync(
      join(output, item.name + "-summary.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    continue;
  }
  const editPath = join(root, "src/services/item00000.ts"),
    original = readFileSync(editPath, "utf8");
  writeFileSync(editPath, original + "\n// small byte edit\n");
  result.small_edit_index = await observe(item.name + "-small-edit", {
    root,
    operation: "index",
  });
  result.edited_context = await observe(item.name + "-edited-context", {
    root,
    operation: "context",
  });
  result.completed_change_check = await observe(item.name + "-changed-check", {
    root,
    operation: "check",
    base,
  });
  result.cache_bytes = readdirSync(join(root, ".ctx/cache"))
    .filter((name) => !name.includes("recovered"))
    .reduce(
      (sum, name) => sum + statSync(join(root, ".ctx/cache", name)).size,
      0,
    );
  for (const [name, samples] of Object.entries(result.samples))
    result.summaries[name] = summarize(samples);
  if (item.documents) {
    write(root, "src/blobs/one-over.md", "B".repeat(1048576));
    result.over_total_byte_limit = await observe(item.name + "-over-total", {
      root,
      operation: "capture",
    });
    write(root, "src/blobs/over-file.md", "C".repeat(1048577));
    result.over_file_byte_limit = await observe(item.name + "-over-file", {
      root,
      operation: "capture",
    });
  } else if (item.count === policy.file_scales.at(-1)) {
    for (let i = 0; i < 4; i++)
      write(root, `src/overflow${i}.ts`, `export const overflow${i}=true;`);
    result.over_file_count_limit = await observe(item.name + "-over-count", {
      root,
      operation: "capture",
    });
  }
  results.push(result);
  writeFileSync(
    join(output, item.name + "-summary.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      event: "case_complete",
      name: item.name,
      cold_ms: result.cold_index.wall_ms,
      summaries: result.summaries,
    }),
  );
}
const summary = {
  schema_version: 1,
  run_id: runId,
  created_at: new Date().toISOString(),
  runtime: process.version,
  platform: {
    system: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    memory_bytes: totalmem(),
  },
  registration: relative(resolve("."), join(output, "registration.json"))
    .split(sep)
    .join("/"),
  policy_sha256: sha(policyBytes),
  methodology: policy.method,
  budgets: policy.budgets,
  results,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
mkdirSync("eval/summaries", { recursive: true });
if (existsSync("eval/summaries/operational.json"))
  copyFileSync(
    "eval/summaries/operational.json",
    join(output, "previous-summary.json"),
  );
writeFileSync(
  "eval/summaries/operational.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify({ report: join(output, "report.json") }));
