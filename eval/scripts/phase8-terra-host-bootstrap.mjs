import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = process.version;
// This cache is deliberately inside the workspace: OS sandbox temporary paths
// can be different for every invocation and would make a verified host vanish.
const hostRoot = join(
  project,
  "eval/.cache/phase8-terra-host",
  "codex-0.163.0",
);
const expectedCommand = join(
  hostRoot,
  "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
);
const npmCli =
  process.env.CTXGATE_NPM_CLI ??
  join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "nodejs/node_modules/npm/bin/npm-cli.js",
  );
const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export async function applyTerraHostPin() {
  const legacy = JSON.parse(
    await readFile(join(project, "eval/manifests/phase8-host.json"), "utf8"),
  );
  if (
    legacy.version !== "codex-cli 0.163.0" ||
    legacy.windows_sandbox !== "mxc"
  )
    throw Error("Unexpected legacy host contract");
  if (!(await exists(expectedCommand))) {
    if (await exists(hostRoot))
      throw Error(
        `Incomplete Terra host exists at ${hostRoot}; remove only that temporary host directory and rerun.`,
      );
    await mkdir(hostRoot, { recursive: true });
    await writeFile(
      join(hostRoot, "package.json"),
      JSON.stringify(
        {
          private: true,
          name: "ctxgate-terra-host",
          dependencies: { "@openai/codex": "0.163.0" },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await copyFile(
      join(project, "eval/manifests/phase8-host-runtime-package-lock.json"),
      join(hostRoot, "package-lock.json"),
    );
    const installed = spawnSync(
      process.execPath,
      [
        npmCli,
        "ci",
        "--ignore-scripts",
        "--offline",
        "--cache",
        join(project, "eval/.cache/npm"),
      ],
      {
        cwd: hostRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (installed.status !== 0 || installed.error)
      throw Error(
        `Offline pinned-host install failed: ${installed.error?.message ?? installed.stderr?.slice(-1200)}`,
      );
  }
  const base = dirname(dirname(dirname(expectedCommand)));
  const files = [];
  for (const expected of legacy.files) {
    const suffix = expected.path.slice(
      expected.path.indexOf("node_modules\\@openai\\codex-win32-x64"),
    );
    const path = join(hostRoot, suffix);
    if (!(await exists(path)))
      throw Error(`Pinned Terra host file missing: ${path}`);
    const sha256 = await digest(path);
    if (sha256 !== expected.sha256)
      throw Error(`Pinned Terra host hash mismatch: ${path}`);
    files.push({ path, sha256 });
  }
  const version = spawnSync(expectedCommand, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (version.status !== 0 || version.stdout.trim() !== legacy.version)
    throw Error(`Pinned Terra host version mismatch: ${version.stderr}`);
  const pin = {
    schema_version: 1,
    purpose: "Terra evaluation host recovery after legacy temp cleanup",
    legacy_host_manifest_sha256: createHash("sha256")
      .update(await readFile(join(project, "eval/manifests/phase8-host.json")))
      .digest("hex"),
    version: legacy.version,
    command: expectedCommand,
    windows_sandbox: "mxc",
    runtime,
    files,
  };
  const manifest = join(project, "eval/manifests/phase8-terra-host.json");
  if (await exists(manifest)) {
    const previous = JSON.parse(await readFile(manifest, "utf8"));
    if (JSON.stringify(previous.files) !== JSON.stringify(pin.files))
      throw Error("Existing Terra host manifest differs from verified pin");
  } else
    await writeFile(manifest, JSON.stringify(pin, null, 2) + "\n", {
      flag: "wx",
    });
  process.env.CTXGATE_CODEX_PATH = expectedCommand;
  return { ...pin, manifest, base };
}
