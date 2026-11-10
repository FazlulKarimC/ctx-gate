import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyPhase8HostPin } from "./phase8-host-pin.mjs";
// Select the installed Node 24 runtime without changing system settings.
if (process.versions.node.startsWith("24.")) {
  await applyPhase8HostPin();
  await import("./phase8-readiness-core.mjs");
} else {
  const bundled = join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe",
  );
  if (!existsSync(bundled)) {
    console.error("Node 24 is required; select an installed Node 24 runtime.");
    process.exitCode = 2;
  } else {
    const result = spawnSync(
      bundled,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 2;
  }
}
