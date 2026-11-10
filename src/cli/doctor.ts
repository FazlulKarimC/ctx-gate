import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema } from "../contracts/index.js";

export async function doctor(root: string) {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  checks.push({
    name: "node_runtime",
    passed: Number(process.versions.node.split(".")[0]) === 24,
    detail: process.version + "; supported major: 24",
  });
  try {
    const canonical = await realpath(root);
    checks.push({
      name: "workspace",
      passed: (await stat(canonical)).isDirectory(),
      detail: canonical,
    });
  } catch (error) {
    checks.push({
      name: "workspace",
      passed: false,
      detail: (error as Error).message,
    });
  }
  try {
    const config = await readFile(join(root, ".ctx/config.json"), "utf8");
    ConfigSchema.parse(JSON.parse(config));
    checks.push({
      name: "configuration",
      passed: true,
      detail: "Existing configuration validates",
    });
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    checks.push({
      name: "configuration",
      passed: absent,
      detail: absent
        ? "Not initialized; init is available"
        : (error as Error).message,
    });
  }
  let probeRoot: string | undefined;
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    probeRoot = await mkdtemp(join(tmpdir(), "ctxgate-doctor-"));
    db = new DatabaseSync(join(probeRoot, "probe.sqlite"));
    db.exec("PRAGMA busy_timeout = 250");
    const version = db.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    const parts = version.version.split(".").map(Number);
    const patched =
      (parts[0] ?? 0) > 3 ||
      ((parts[0] ?? 0) === 3 &&
        ((parts[1] ?? 0) > 51 ||
          ((parts[1] ?? 0) === 51 && (parts[2] ?? 0) >= 3)));
    checks.push({
      name: "sqlite_version",
      passed: patched,
      detail: version.version + "; minimum: 3.51.3",
    });
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(content)");
    db.prepare("INSERT INTO probe(content) VALUES (?)").run("session expiry");
    const hit = db
      .prepare("SELECT count(*) AS hits FROM probe WHERE probe MATCH ?")
      .get("expiry") as { hits: number };
    checks.push({
      name: "fts5",
      passed: hit.hits === 1,
      detail: "Insert and MATCH query",
    });
    const mode = (
      db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }
    ).journal_mode;
    checks.push({ name: "wal", passed: mode === "wal", detail: String(mode) });
  } catch (error) {
    checks.push({
      name: "sqlite_capabilities",
      passed: false,
      detail: (error as Error).message,
    });
  } finally {
    db?.close();
    if (probeRoot) {
      const rel = relative(resolve(tmpdir()), resolve(probeRoot));
      if (
        rel.startsWith("ctxgate-doctor-") &&
        !rel.includes("..") &&
        !isAbsolute(rel)
      )
        await rm(probeRoot, { recursive: true, force: true });
    }
  }
  return {
    schema_version: 1 as const,
    operation: "doctor" as const,
    status: checks.every((check) => check.passed) ? "ready" : "unavailable",
    capabilities: {
      initialization: true,
      indexing: true,
      retrieval: true,
      checking: true,
    },
    checks,
  };
}
