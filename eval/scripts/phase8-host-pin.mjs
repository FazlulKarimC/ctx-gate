import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";

export async function applyPhase8HostPin() {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    pin = JSON.parse(
      await readFile(join(project, "eval/manifests/phase8-host.json"), "utf8"),
    );
  if (pin.version !== "codex-cli 0.163.0" || pin.windows_sandbox !== "mxc")
    throw Error("Unexpected Phase 8 host contract");
  if (
    process.env.CTXGATE_CODEX_PATH &&
    resolve(process.env.CTXGATE_CODEX_PATH) !== resolve(pin.command)
  )
    throw Error("Explicit host differs from the Phase 8 pin");
  for (const file of pin.files) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file.path)) hash.update(bytes);
    if (hash.digest("hex") !== file.sha256)
      throw Error("Pinned host file changed: " + file.path);
  }
  process.env.CTXGATE_CODEX_PATH = pin.command;
  return pin;
}
