import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function restorePhase8Access(evidence) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const shell = resolve(
    dirname(process.execPath),
    "../../native/powershell/pwsh.exe",
  );
  const child = spawnSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(root, "eval/scripts/restore-phase8-access.ps1"),
      "-EvidencePath",
      evidence,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0)
    throw Error(
      "Scoped permission restoration failed: " +
        (child.error?.message ?? child.stderr),
    );
  const report = JSON.parse(await readFile(evidence, "utf8"));
  if (report.records.some((row) => row.remaining !== 0))
    throw Error("Transient experiment deny entries remain");
  return {
    method: "scoped_native_restoration",
    verified: true,
    evidence,
    removed: report.records.reduce((sum, row) => sum + row.removed, 0),
  };
}
