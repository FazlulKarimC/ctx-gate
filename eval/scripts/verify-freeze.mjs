import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export function verifyFreeze(root, manifest) {
  if (
    manifest?.schema_version !== 1 ||
    !Array.isArray(manifest.source) ||
    !manifest.source.length ||
    manifest.source.length > 5000
  )
    throw Error("Invalid frozen source manifest");
  const canonical = realpathSync(root),
    mismatches = [];
  for (const entry of manifest.source) {
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      isAbsolute(entry.path) ||
      win32.isAbsolute(entry.path) ||
      /^[a-z]:/i.test(entry.path) ||
      entry.path.split("/").some((part) => ["..", ".", ""].includes(part)) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
    )
      throw Error("Invalid frozen relative path/hash");
    try {
      const path = realpathSync(resolve(canonical, entry.path)),
        rel = relative(canonical, path);
      if (
        rel.startsWith("..") ||
        isAbsolute(rel) ||
        !statSync(path).isFile() ||
        statSync(path).size > 32 * 1024 * 1024
      )
        throw Error("Unsupported source input");
      if (
        createHash("sha256").update(readFileSync(path)).digest("hex") !==
        entry.sha256
      )
        mismatches.push({ path: entry.path, reason: "hash_changed" });
    } catch {
      mismatches.push({
        path: entry.path,
        reason: "unavailable_or_outside_root",
      });
    }
  }
  return {
    schema_version: 1,
    operation: "verify_evaluation_freeze",
    valid: mismatches.length === 0,
    files: manifest.source.length,
    mismatches,
    agent_runs_allowed: false,
    assessment:
      "Source integrity only. A separate run-readiness decision, budget and host isolation checks are required.",
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const manifest = JSON.parse(
        readFileSync("eval/manifests/evaluation-freeze.json", "utf8"),
      ),
      result = verifyFreeze(process.cwd(), manifest);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 2;
  } catch (error) {
    console.error(
      JSON.stringify({ status: "unavailable", error: error.message }),
    );
    process.exitCode = 2;
  }
}
