import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Coverage } from "./contracts/index.js";
import {
  captureWorktree,
  digest,
  isNotePath,
  type ScanLimits,
} from "./workspace/snapshot.js";
import {
  buildAnalysisContext,
  parseSource,
  resolveImports,
  chunksFor,
  ANALYZER_VERSION,
  type SyntaxFacts,
  type ImportFact,
} from "./analyzer/index.js";
import { IndexStore, type IndexMetadata } from "./store/index.js";

export function refreshIndex(root: string, options: ScanLimits = {}) {
  return refreshIndexSnapshot(root, options).result;
}

/** Internal retrieval path retains the exact observed bytes for evidence validation. */
export function refreshIndexSnapshot(root: string, options: ScanLimits = {}) {
  if (!existsSync(resolve(root, ".ctx/config.json")))
    throw new Error(
      "Workspace is not initialized. Run ctxgate init before persisting an index.",
    );
  const totalStart = performance.now();
  let conflict = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const scan = captureWorktree(root, options);
    const store = new IndexStore(scan.view.root);
    try {
      const previous = store.metadata();
      const beforeGeneration = previous?.generation ?? 0;
      const contextStart = performance.now();
      const context = buildAnalysisContext(scan.view);
      const configHash = digest(JSON.stringify(scan.config));
      const metadataSame =
        previous?.analyzer === ANALYZER_VERSION &&
        previous.context_hash === context.fingerprint &&
        previous.config_hash === configHash;
      const cached = store.cachedFiles();
      // Repair older caches locally: notes must not affect FTS/BM25 statistics.
      const legacyNotes = new Set(
        (
          store.db
            .prepare(
              "SELECT DISTINCT path FROM chunk_search WHERE lower(path) LIKE '.ctx/notes/%'",
            )
            .all() as { path: string }[]
        ).map((row) => row.path),
      );
      const prepared = new Map<
        string,
        { facts: SyntaxFacts | null; changed: boolean }
      >();
      let parsed = 0,
        reused = 0;
      const reasons: Coverage["reasons"] = [
        ...scan.coverage.reasons,
        ...context.reasons,
      ];
      const parseStart = performance.now();
      for (const file of scan.view.files.values()) {
        const old = cached.get(file.path);
        const unchanged =
          old?.content_hash === file.hash &&
          old.kind === file.kind &&
          metadataSame &&
          !legacyNotes.has(file.path);
        let facts: SyntaxFacts | null = null;
        if (file.kind === "source") {
          if (unchanged && old.facts) {
            facts = old.facts;
            reused++;
          } else {
            facts = parseSource(file, context);
            parsed++;
          }
          for (const error of facts.errors)
            reasons.push({
              code: "syntax_or_project_error",
              message: error,
              path: file.path,
            });
        }
        prepared.set(file.path, {
          facts,
          changed: !unchanged || (file.kind === "source" && !old?.facts),
        });
      }
      const parseMs = performance.now() - parseStart;
      const resolutionStart = performance.now();
      const imports: ImportFact[] = [];
      for (const file of scan.view.files.values()) {
        const facts = prepared.get(file.path)!.facts;
        if (facts) imports.push(...resolveImports(file, facts, context));
      }
      for (const item of imports)
        if (
          !["resolved_local", "external_declared", "builtin"].includes(
            item.resolution,
          )
        )
          reasons.push({
            code: item.resolution,
            message: item.detail,
            path: item.source,
          });
      const resolutionMs = performance.now() - resolutionStart;
      const coverage: Coverage = {
        complete: reasons.length === 0,
        checked_files: scan.view.files.size,
        skipped_files: scan.coverage.skipped_files,
        reasons,
      };
      // Re-enumerate and hash all input bytes, not just selected symbols or mtimes.
      const verification = captureWorktree(root, options);
      if (
        verification.view.id !== scan.view.id ||
        digest(JSON.stringify(verification.config)) !== configHash ||
        JSON.stringify(verification.coverage) !== JSON.stringify(scan.coverage)
      ) {
        conflict = "Working tree changed while indexing";
        continue;
      }
      const removed = [...cached.keys()].filter(
        (path) => !scan.view.files.has(path),
      );
      const identical =
        metadataSame &&
        previous?.view_id === scan.view.id &&
        JSON.stringify(previous.coverage) === JSON.stringify(coverage) &&
        ![...prepared.values()].some((item) => item.changed);
      let generation = beforeGeneration;
      const publishStart = performance.now();
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if ((store.metadata()?.generation ?? 0) !== beforeGeneration) {
          conflict = "Another index writer published a generation";
          store.db.exec("ROLLBACK");
          continue;
        }
        if (!identical) {
          for (const path of removed) store.removeFile(path);
          const putFile = store.db.prepare(
            "INSERT INTO files(path,content_hash,bytes,kind,facts) VALUES (?,?,?,?,?)",
          );
          const putSymbol = store.db.prepare(
            "INSERT INTO symbols VALUES (?,?,?,?,?,?,?)",
          );
          const putChunk = store.db.prepare(
            "INSERT INTO chunks(path,ordinal,start_line,end_line,text) VALUES (?,?,?,?,?)",
          );
          const putSearch = store.db.prepare(
            "INSERT INTO chunk_search(rowid,exact_identifiers,subtokens,path,signature,body) VALUES (?,?,?,?,?,?)",
          );
          for (const file of scan.view.files.values()) {
            const item = prepared.get(file.path)!;
            if (!item.changed) continue;
            store.removeFile(file.path);
            putFile.run(
              file.path,
              file.hash,
              file.bytes,
              file.kind,
              item.facts ? JSON.stringify(item.facts) : null,
            );
            item.facts?.symbols.forEach((symbol, index) =>
              putSymbol.run(
                file.path,
                index,
                symbol.name,
                symbol.kind,
                symbol.signature,
                symbol.start_line,
                symbol.end_line,
              ),
            );
            chunksFor(file, item.facts ?? undefined).forEach((chunk, index) => {
              const row = putChunk.run(
                file.path,
                index,
                chunk.start_line,
                chunk.end_line,
                chunk.text,
              );
              if (!isNotePath(file.path))
                putSearch.run(
                  row.lastInsertRowid,
                  chunk.identifiers,
                  chunk.subtokens,
                  file.path,
                  chunk.signature,
                  chunk.text,
                );
            });
          }
          store.db.exec("DELETE FROM imports");
          const putImport = store.db.prepare(
            "INSERT INTO imports VALUES (?,?,?,?,?,?,?,?,?)",
          );
          const ordinals = new Map<string, number>();
          for (const item of imports) {
            const ordinal = ordinals.get(item.source) ?? 0;
            putImport.run(
              item.source,
              ordinal,
              item.specifier,
              item.target,
              item.kind,
              item.form,
              item.resolution,
              item.line,
              item.detail,
            );
            ordinals.set(item.source, ordinal + 1);
          }
          generation++;
          const metadata: IndexMetadata = {
            schema_version: 1,
            root: scan.view.root,
            generation,
            view_id: scan.view.id,
            analyzer: ANALYZER_VERSION,
            context_hash: context.fingerprint,
            config_hash: configHash,
            coverage,
          };
          store.db
            .prepare(
              "INSERT INTO metadata(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            )
            .run(JSON.stringify(metadata));
        }
        store.db.exec("COMMIT");
      } catch (error) {
        if (store.db.isTransaction) store.db.exec("ROLLBACK");
        throw error;
      }
      const result = {
        schema_version: 1 as const,
        operation: "index" as const,
        status: coverage.complete ? "complete" : "incomplete",
        root: scan.view.root,
        view_id: scan.view.id,
        generation,
        analyzer: ANALYZER_VERSION,
        database: store.path,
        default_budget_tokens: scan.config.budget_tokens,
        files: scan.view.files.size,
        source_files: parsed + reused,
        parsed_files: parsed,
        reused_files: reused,
        removed_files: removed.length,
        symbol_count: Number(
          (
            store.db.prepare("SELECT count(*) total FROM symbols").get() as {
              total: number;
            }
          ).total,
        ),
        import_count: imports.length,
        bytes: scan.bytes,
        coverage,
        exclusions: scan.exclusions,
        recovered_cache: store.recovered,
        git: scan.git,
        timings_ms: {
          scan: scan.scan_ms,
          configuration: parseStart - contextStart,
          parse: parseMs,
          resolution: resolutionMs,
          verification: verification.scan_ms,
          publish: performance.now() - publishStart,
          total: performance.now() - totalStart,
        },
      };
      return { result, view: scan.view };
    } finally {
      store.close();
    }
  }
  throw new Error("Index refresh incomplete after one retry: " + conflict);
}
