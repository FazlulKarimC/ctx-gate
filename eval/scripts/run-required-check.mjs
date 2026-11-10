import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Called from trusted tool checkout; candidate scripts/dependencies are never run.
export function runRequiredCheck({ root, base, target, policy }) {
  for (const [name, value] of Object.entries({ base, target, policy }))
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value ?? ""))
      throw Error(`${name} must be a full immutable commit ID`);
  const cli = fileURLToPath(
    new URL("../../dist/cli/index.js", import.meta.url),
  );
  return spawnSync(
    process.execPath,
    [
      cli,
      "check",
      "--root",
      resolve(root),
      "--base",
      base,
      "--target",
      target,
      "--policy-ref",
      policy,
      "--mode",
      "required",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = runRequiredCheck({
      root: process.env.CTX_CANDIDATE_ROOT ?? "candidate",
      base: process.env.CTX_BASE_SHA,
      target: process.env.CTX_TARGET_SHA,
      policy: process.env.CTX_POLICY_SHA,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = [0, 1, 2].includes(result.status) ? result.status : 2;
  } catch (error) {
    console.error(
      JSON.stringify({ status: "unavailable", error: error.message }),
    );
    process.exitCode = 2;
  }
}
