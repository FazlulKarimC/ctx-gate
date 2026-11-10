import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Locate the existing CLI without changing PATH or installing another copy. */
export function resolveCodex() {
  const explicit = process.env.CTXGATE_CODEX_PATH;
  const candidates = explicit
    ? [explicit]
    : [process.env.CODEX_APP_RUNTIME_CLI_PATH, "codex"].filter(Boolean);
  if (!explicit && process.platform === "win32") {
    const directories = [
      ...new Set(
        [process.env.LOCALAPPDATA, join(homedir(), "AppData/Local")].filter(
          Boolean,
        ),
      ),
    ].map((base) => join(base, "OpenAI/Codex/bin"));
    for (const directory of directories)
      if (existsSync(directory)) {
        const installed = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(directory, entry.name, "codex.exe"))
          .filter((path) => existsSync(path))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        candidates.push(...installed);
      }
  }
  for (const command of [...new Set(candidates)]) {
    try {
      const version = execFileSync(command, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (/codex-cli\s/.test(version)) return { command, version };
    } catch {
      /* Try an installed executable instead of crashing on ENOENT. */
    }
  }
  throw new Error(
    "Codex CLI was not found on PATH or in the desktop installation. Set CTXGATE_CODEX_PATH to an existing codex executable and rerun the diagnostic.",
  );
}
