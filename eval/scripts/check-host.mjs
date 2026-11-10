import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Run from an ordinary terminal. This diagnoses capability, never alters policy.
if (process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  console.error(
    "This terminal inherits Codex app transport. Open PowerShell from the Windows Start menu, change to the project folder, and run: node eval/scripts/check-host.mjs",
  );
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = join(
  homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe",
);
const runtime = process.versions.node.startsWith("24.")
  ? process.execPath
  : existsSync(bundled)
    ? bundled
    : null;
if (!runtime) {
  console.error(
    "Node 24 is required; select an installed Node 24 runtime and rerun this command.",
  );
  process.exit(2);
}
const result = spawnSync(
  runtime,
  [resolve(root, "eval/scripts/preflight.mjs")],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 2;
