import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { type SyntaxFacts } from "../analyzer/index.js";

export interface IndexMetadata {
  schema_version: 1;
  root: string;
  generation: number;
  view_id: string;
  analyzer: string;
  context_hash: string;
  config_hash: string;
  coverage: unknown;
}
export interface CachedFile {
  path: string;
  content_hash: string;
  facts: SyntaxFacts | null;
  kind: string;
}
export class IndexStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly recovered: boolean;
  constructor(root: string) {
    const directory = resolve(root, ".ctx/cache");
    for (const path of [
      resolve(root, ".ctx"),
      directory,
      resolve(directory, "index.sqlite"),
    ])
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("Managed cache cannot be a symlink");
    mkdirSync(directory, { recursive: true });
    this.path = resolve(directory, "index.sqlite");
    let recovered = false;
    const open = () => {
      const db = new DatabaseSync(this.path);
      try {
        db.exec(
          "PRAGMA busy_timeout = 500; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
        );
        const integrity = db.prepare("PRAGMA quick_check").get();
        if (!integrity || Object.values(integrity)[0] !== "ok")
          throw new Error("Corrupt derived index");
        const exists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
          )
          .get();
        if (exists) {
          const row = db
            .prepare("SELECT payload FROM metadata WHERE id=1")
            .get() as { payload: string } | undefined;
          if (row) {
            let metadata: IndexMetadata;
            try {
              metadata = JSON.parse(row.payload) as IndexMetadata;
            } catch {
              throw new Error("Corrupt derived index metadata");
            }
            if (metadata.schema_version !== 1 || metadata.root !== root)
              throw new Error("Incompatible derived index");
          }
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,content_hash TEXT NOT NULL,bytes INTEGER NOT NULL,kind TEXT NOT NULL,facts TEXT);
          CREATE TABLE IF NOT EXISTS symbols(path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,ordinal INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,signature TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,PRIMARY KEY(path,ordinal));
          CREATE TABLE IF NOT EXISTS imports(source TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,ordinal INTEGER NOT NULL,specifier TEXT,target TEXT,kind TEXT NOT NULL,form TEXT NOT NULL,resolution TEXT NOT NULL,line INTEGER NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(source,ordinal));
          CREATE INDEX IF NOT EXISTS import_targets ON imports(target);
          CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,ordinal INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,text TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS chunk_files ON chunks(path);
          CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(exact_identifiers,subtokens,path,signature,body);
        `);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    const openWithBusyRetry = () => {
      try {
        return open();
      } catch (error) {
        if (!/locked|busy/i.test((error as Error).message)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        return open();
      }
    };
    try {
      this.db = openWithBusyRetry();
    } catch (error) {
      if (
        !/not a database|malformed|Corrupt derived|Incompatible derived/i.test(
          (error as Error).message,
        )
      )
        throw error;
      const suffix = ".recovered-" + randomUUID();
      for (const extra of ["", "-wal", "-shm"]) {
        const source = this.path + extra,
          target = this.path + suffix + extra;
        for (const path of [source, target]) {
          const rel = relative(directory, path);
          if (rel.startsWith("..") || isAbsolute(rel))
            throw new Error("Invalid cache recovery path");
        }
        if (existsSync(source)) {
          if (lstatSync(source).isSymbolicLink())
            throw new Error("Refusing symlink cache recovery");
          renameSync(source, target);
        }
      }
      this.db = openWithBusyRetry();
      recovered = true;
    }
    this.recovered = recovered;
  }
  metadata(): IndexMetadata | null {
    const row = this.db
      .prepare("SELECT payload FROM metadata WHERE id=1")
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as IndexMetadata) : null;
  }
  cachedFiles(): Map<string, CachedFile> {
    return new Map(
      (
        this.db
          .prepare("SELECT path,content_hash,kind,facts FROM files")
          .all() as {
          path: string;
          content_hash: string;
          kind: string;
          facts: string | null;
        }[]
      ).map((row) => {
        let facts: SyntaxFacts | null = null;
        try {
          const value: unknown = row.facts ? JSON.parse(row.facts) : null;
          if (
            value &&
            typeof value === "object" &&
            "symbols" in value &&
            "imports" in value &&
            "errors" in value &&
            Array.isArray(value.symbols) &&
            Array.isArray(value.imports) &&
            Array.isArray(value.errors)
          )
            facts = value as SyntaxFacts;
        } catch {
          /* Invalid derived syntax is reparsed from source. */
        }
        return [row.path, { ...row, facts }];
      }),
    );
  }
  removeFile(path: string) {
    this.db
      .prepare(
        "DELETE FROM chunk_search WHERE rowid IN (SELECT id FROM chunks WHERE path=?)",
      )
      .run(path);
    this.db.prepare("DELETE FROM files WHERE path=?").run(path);
  }
  /** Mark this observed generation for ordinary full regeneration, without deleting source. */
  invalidateGeneration(generation: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.metadata();
      if (metadata?.generation === generation) {
        this.db.prepare("UPDATE metadata SET payload=? WHERE id=1").run(
          JSON.stringify({
            ...metadata,
            analyzer: "derived-evidence-rebuild-required",
          }),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
