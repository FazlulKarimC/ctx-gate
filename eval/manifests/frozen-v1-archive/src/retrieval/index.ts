import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import {
  ReferenceSchema,
  ContextResultSchema,
  ExpandResultSchema,
  type Coverage,
  type EvidenceItem,
  type EvidenceReference,
  type ContextResult,
  type ExpandResult,
} from "../contracts/index.js";
import { refreshIndexSnapshot } from "../indexer.js";
import { IndexStore } from "../store/index.js";
import {
  captureWorktree,
  digest,
  type ScanLimits,
} from "../workspace/snapshot.js";
import {
  normalizeQuery,
  quoteFts,
  compareText,
  isNote,
  LEXICAL_DEFAULTS,
  LEXICAL_VARIANTS,
  DEFAULT_LEXICAL_VARIANT,
  type LexicalVariant,
  type Query,
} from "./query.js";
import { behaviorTerms, bodyFocusedCandidates } from "./focus.js";
import { neighbors } from "./neighbors.js";
import { buildAnalysisContext, parseSource } from "../analyzer/index.js";
import type { ReviewedNote } from "../notes/index.js";
import {
  responseBudget,
  measure,
  type BudgetOptions,
  type Counter,
} from "./budget.js";
export { renderResult } from "./budget.js";
export {
  normalizeQuery,
  LEXICAL_VERSION,
  LEXICAL_DEFAULTS,
  LEXICAL_VARIANTS,
  DEFAULT_LEXICAL_VARIANT,
} from "./query.js";
export type { LexicalVariant } from "./query.js";
export type { Encoding, BudgetOptions } from "./budget.js";

export interface ContextOptions extends BudgetOptions {
  scan_limits?: ScanLimits;
  lexical_version?: LexicalVariant;
  neighbors?: boolean;
  notes?: boolean;
}
export interface ExpandOptions extends ContextOptions {
  before?: number;
  after?: number;
}
export interface Candidate {
  path: string;
  content_hash: string;
  kind: string;
  start_line: number;
  end_line: number;
  file_end: number;
  text: string;
  tier: number;
  rank: number;
  reason: string;
  focus?: number;
  symbol_start?: number;
  symbol_end?: number;
  focus_role?: number;
  relationship?: EvidenceItem["relationship"];
  atomic?: EvidenceItem;
}
const fields =
  "c.path,f.content_hash,f.kind,c.start_line,c.end_line,c.text,(SELECT max(end_line) FROM chunks e WHERE e.path=c.path) file_end";
const allowed = "c.path NOT LIKE '.ctx/notes/%'";
const rootId = (root: string) => digest(root);
const compactCoverage = (coverage: Coverage): Coverage => ({
  ...coverage,
  reasons: coverage.complete
    ? []
    : [
        {
          code: "incomplete_index",
          message:
            coverage.reasons.length +
            " reasons; inspect ctxgate index for details",
        },
      ],
});
const makeReference = (
  root_id: string,
  view_id: string,
  path: string,
  hash: string,
  start: number,
  end: number,
): EvidenceReference => ({
  schema_version: 1,
  root_id,
  view_id,
  path,
  content_hash: hash,
  start_line: start,
  end_line: end,
});
const kindFor = (candidate: Candidate): EvidenceItem["kind"] =>
  candidate.kind === "documentation"
    ? "documentation"
    : candidate.kind === "configuration"
      ? "config"
      : /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(
            candidate.path,
          )
        ? "test"
        : "source";
const escapedLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function candidates(
  db: DatabaseSync,
  query: Query,
  variant: LexicalVariant = "v1",
): Candidate[] {
  const all: Candidate[] = [];
  const focusedMode =
    LEXICAL_VARIANTS[variant].body_focus && behaviorTerms(query).length > 0;
  const limit = LEXICAL_DEFAULTS.candidate_limit;
  for (const path of query.paths) {
    const rows = db
      .prepare(
        `SELECT ${fields} FROM chunks c JOIN files f ON f.path=c.path WHERE ${allowed} AND (c.path=? OR c.path LIKE ? ESCAPE '\\') ORDER BY c.path,c.ordinal LIMIT ?`,
      )
      .all(path, "%/" + escapedLike(path), limit) as unknown as Candidate[];
    all.push(
      ...rows.map((row) => ({
        ...row,
        tier: 0,
        rank: 0,
        reason: "path anchor",
      })),
    );
  }
  if (query.symbols.length) {
    const marks = query.symbols.map(() => "?").join(",");
    const fullSymbol = focusedMode;
    const overlap = fullSymbol
      ? "s.start_line<=c.end_line AND s.end_line>=c.start_line"
      : "s.start_line BETWEEN c.start_line AND c.end_line";
    const rows = db
      .prepare(
        `SELECT ${fields},s.start_line focus${fullSymbol ? ",s.start_line symbol_start,s.end_line symbol_end" : ""} FROM symbols s JOIN chunks c ON c.path=s.path AND ${overlap} JOIN files f ON f.path=c.path WHERE ${allowed} AND s.name COLLATE NOCASE IN (${marks}) ORDER BY c.path,c.start_line,s.ordinal LIMIT ?`,
      )
      .all(...query.symbols, limit) as unknown as Candidate[];
    all.push(
      ...rows.map((row) => ({
        ...row,
        tier: 0,
        rank: 0,
        reason: "exact symbol",
      })),
    );
  }
  const search = (expression: string, tier: number, reason: string) => {
    const rows = db
      .prepare(
        `SELECT ${fields},bm25(chunk_search,${LEXICAL_DEFAULTS.field_weights.join(",")}) rank FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid JOIN files f ON f.path=c.path WHERE chunk_search MATCH ? AND ${allowed} ORDER BY rank,c.path,c.start_line LIMIT ?`,
      )
      .all(expression, limit) as unknown as Candidate[];
    all.push(...rows.map((row) => ({ ...row, tier, reason })));
  };
  if (query.phrases.length)
    search(query.phrases.map(quoteFts).join(" OR "), 1, "quoted phrase");
  if (query.terms.length)
    search(query.terms.map(quoteFts).join(" OR "), 2, "lexical match");
  const sorted = (
    LEXICAL_VARIANTS[variant].body_focus
      ? bodyFocusedCandidates(all, query)
      : all
  ).sort(
    (a, b) =>
      a.tier - b.tier ||
      a.rank - b.rank ||
      compareText(a.path, b.path) ||
      (a.focus_role ?? 0) - (b.focus_role ?? 0) ||
      (a.focus ?? a.start_line) - (b.focus ?? b.start_line) ||
      compareText(a.reason, b.reason),
  );
  const seen = new Set<string>();
  return sorted
    .filter((row) => {
      const key =
        row.path +
        ":" +
        row.start_line +
        (focusedMode ? ":" + (row.focus ?? "chunk") : "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function focusFor(candidate: Candidate, query: Query): number {
  if (candidate.focus) return candidate.focus;
  let best = 0,
    score = -1;
  candidate.text.split("\n").forEach((line, index) => {
    const text = line.toLowerCase();
    const value =
      query.terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0) +
      query.phrases.reduce(
        (n, phrase) => n + (text.includes(phrase.toLowerCase()) ? 4 : 0),
        0,
      );
    if (value > score) {
      score = value;
      best = index;
    }
  });
  return candidate.start_line + best;
}
function itemFor(
  candidate: Candidate,
  root_id: string,
  view_id: string,
  focus: number,
  radius: number,
): EvidenceItem {
  if (candidate.atomic) return candidate.atomic;
  const start = Math.max(candidate.start_line, focus - radius),
    end = Math.min(candidate.end_line, focus + radius);
  return {
    reference: makeReference(
      root_id,
      view_id,
      candidate.path,
      candidate.content_hash,
      start,
      end,
    ),
    kind: kindFor(candidate),
    reason: candidate.reason,
    excerpt: candidate.text
      .split("\n")
      .slice(start - candidate.start_line, end - candidate.start_line + 1)
      .join("\n"),
    omitted_before: start > 1,
    omitted_after: end < candidate.file_end,
    ...(candidate.relationship ? { relationship: candidate.relationship } : {}),
  };
}
function fitBase<T extends ContextResult | ExpandResult>(
  result: T,
  counter: Counter,
) {
  if (!measure(result, counter))
    throw new Error(
      "Budget is too small for required response metadata; increase the allowance",
    );
}
function finish<T extends ContextResult | ExpandResult>(
  result: T,
  counter: Counter,
): T {
  fitBase(result, counter);
  if (result.operation === "context") ContextResultSchema.parse(result);
  else ExpandResultSchema.parse(result);
  return result;
}

function packResult(
  result: ContextResult,
  ranked: Candidate[],
  query: Query,
  counter: Counter,
  variant: LexicalVariant = "v1",
): ContextResult {
  fitBase(result, counter);
  const perFile = new Map<string, number>();
  let omitted = false;
  let attempted = 0;
  for (const candidate of ranked) {
    if (
      result.items.length >= LEXICAL_DEFAULTS.max_items ||
      (perFile.get(candidate.path) ?? 0) >= LEXICAL_DEFAULTS.per_file
    ) {
      omitted = true;
      continue;
    }
    if (attempted++ >= LEXICAL_VARIANTS[variant].packing_candidates) {
      omitted = true;
      break;
    }
    const focus = focusFor(candidate, query);
    let selected = false;
    const attemptedSpans = new Set<string>();
    for (const radius of candidate.atomic
      ? [0]
      : [LEXICAL_DEFAULTS.excerpt_radius, 4, 2, 0]) {
      const item = itemFor(
        candidate,
        result.root_id,
        result.view_id,
        focus,
        radius,
      );
      if (variant === "v2") {
        const span = item.reference.start_line + ":" + item.reference.end_line;
        if (attemptedSpans.has(span)) continue;
        attemptedSpans.add(span);
      }
      if (
        result.items.some(
          (previous) =>
            previous.reference.path === item.reference.path &&
            previous.reference.start_line <= item.reference.end_line &&
            item.reference.start_line <= previous.reference.end_line,
        )
      )
        break;
      const omissions = result.omitted_notes;
      if (item.note && omissions)
        result.omitted_notes = omissions.filter(
          (note) => note.id !== item.note!.id,
        );
      result.items.push(item);
      result.status = "ok";
      result.budget.truncated = false;
      if (measure(result, counter)) {
        selected = true;
        perFile.set(candidate.path, (perFile.get(candidate.path) ?? 0) + 1);
        break;
      }
      result.items.pop();
      if (omissions) result.omitted_notes = omissions;
    }
    if (!selected) omitted = true;
  }
  result.status = result.items.length
    ? "ok"
    : ranked.length
      ? "budget_too_small"
      : "no_match";
  result.budget.truncated =
    omitted ||
    result.items.some((item) => item.omitted_before || item.omitted_after);
  return finish(result, counter);
}

function noteCandidate(
  note: ReviewedNote,
  root: string,
  view: string,
): Candidate {
  const end = note.text.split("\n").length;
  const item: EvidenceItem = {
    reference: makeReference(root, view, note.path, note.content_hash, 1, end),
    kind: "note",
    reason: "accepted scoped rationale; review and freshness are independent",
    excerpt: note.text,
    omitted_before: false,
    omitted_after: false,
    note: note.metadata,
  };
  return {
    path: note.path,
    content_hash: note.content_hash,
    kind: "note",
    start_line: 1,
    end_line: end,
    file_end: end,
    text: note.text,
    tier: 1,
    rank: 0,
    reason: item.reason,
    atomic: item,
  };
}
function validateFeatures(options: ContextOptions) {
  for (const key of ["neighbors", "notes"] as const)
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      throw Error(key + " must be boolean");
}

/** Full refresh precedes a snapshot read; independent features are opt-in. */
export async function context(
  root: string,
  queryText: string,
  options: ContextOptions = {},
): Promise<ContextResult> {
  validateFeatures(options);
  const variant = options.lexical_version ?? DEFAULT_LEXICAL_VARIANT;
  if (variant !== "v1" && variant !== "v2")
    throw new Error("lexical_version must be v1 or v2");
  const query = normalizeQuery(queryText);
  let repairedCache = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result: indexed, view: observed } = refreshIndexSnapshot(
      root,
      options.scan_limits,
    );
    const { counter, budget } = await responseBudget(
      indexed.default_budget_tokens,
      options,
    );
    const result: ContextResult = {
      schema_version: 1,
      operation: "context",
      root_id: rootId(indexed.root),
      view_id: indexed.view_id,
      generation: indexed.generation,
      evidence_trust: "repository_data",
      status: "no_match",
      coverage: compactCoverage(indexed.coverage),
      coverage_reason_count: indexed.coverage.reasons.length,
      diagnostics: [
        ...(query.truncated ? ["Query terms or anchors capped"] : []),
        ...(repairedCache
          ? ["Rebuilt inconsistent derived evidence cache"]
          : []),
      ],
      items: [],
      budget,
    };
    fitBase(result, counter);
    const store = new IndexStore(indexed.root);
    try {
      store.db.exec("BEGIN");
      const metadata = store.metadata();
      if (
        metadata?.generation !== indexed.generation ||
        metadata.view_id !== indexed.view_id
      )
        continue;
      const lexical = candidates(store.db, query, variant);
      let ranked = lexical;
      if (options.neighbors) {
        const graph = neighbors(
          store.db,
          lexical,
          query,
          LEXICAL_VARIANTS[variant].body_focus,
          queryText,
        );
        result.features = { neighbors: graph.stats };
        ranked = [
          ...lexical.slice(0, 3),
          ...graph.candidates.slice(0, 2),
          ...lexical.slice(3),
          ...graph.candidates.slice(2),
        ].slice(0, LEXICAL_DEFAULTS.candidate_limit);
      }
      if (options.notes) {
        const { readNotes, selectNotes } = await import("../notes/index.js");
        const files = store.db
          .prepare(
            "SELECT path,content_hash,bytes FROM files WHERE lower(path) LIKE '.ctx/notes/%' ORDER BY path LIMIT 101",
          )
          .all() as { path: string; content_hash: string; bytes: number }[];
        const sources = files.map((file) => ({
          ...file,
          text:
            file.bytes <= 65536
              ? (
                  store.db
                    .prepare(
                      "SELECT text FROM chunks WHERE path=? ORDER BY ordinal",
                    )
                    .all(file.path) as { text: string }[]
                )
                  .map((row) => row.text)
                  .join("\n")
              : "",
        }));
        const parsed = readNotes(
          sources,
          (path) => {
            const file = store.db
              .prepare(
                "SELECT content_hash FROM files WHERE path=? AND kind!='metadata' AND lower(path) NOT LIKE '.ctx/notes/%'",
              )
              .get(path) as { content_hash: string } | undefined;
            return file
              ? {
                  ...file,
                  hasSymbol: (name: string) =>
                    Boolean(
                      store.db
                        .prepare(
                          "SELECT 1 FROM symbols WHERE path=? AND name=? LIMIT 1",
                        )
                        .get(path, name),
                    ),
                }
              : undefined;
          },
          process.platform !== "win32" && process.platform !== "darwin",
        );
        const eligiblePaths = (
          store.db
            .prepare(
              "SELECT path FROM files WHERE kind!='metadata' AND lower(path) NOT LIKE '.ctx/notes/%'",
            )
            .all() as { path: string }[]
        ).map((row) => row.path);
        const selected = selectNotes(
          parsed.notes,
          query,
          lexical.slice(0, 20).map((row) => row.path),
          eligiblePaths,
        );
        result.features = {
          ...result.features,
          notes: {
            eligible: selected.eligible,
            invalid: parsed.invalid,
            limited: parsed.limited,
          },
        };
        if (parsed.invalid || parsed.limited)
          result.diagnostics.push(
            "Notes coverage incomplete; invalid or capped files are excluded",
          );
        const additions = selected.notes.map((note) =>
          noteCandidate(note, result.root_id, result.view_id),
        );
        result.omitted_notes = additions.map((note) => ({
          id: note.atomic!.note!.id,
          reference: note.atomic!.reference,
          reason: "budget",
        }));
        ranked = [
          ...ranked.slice(0, 2),
          ...additions.slice(0, 1),
          ...ranked.slice(2, 5),
          ...additions.slice(1),
          ...ranked.slice(5),
        ].slice(0, LEXICAL_DEFAULTS.candidate_limit);
      }
      const packed = packResult(result, ranked, query, counter, variant);
      const valid = packed.items.every((item) => {
        const file = observed.files.get(item.reference.path);
        return (
          file?.hash === item.reference.content_hash &&
          item.excerpt ===
            file.text
              .split("\n")
              .slice(item.reference.start_line - 1, item.reference.end_line)
              .join("\n")
        );
      });
      if (!valid) {
        store.db.exec("ROLLBACK");
        store.invalidateGeneration(indexed.generation);
        repairedCache = true;
        continue;
      }
      return packed;
    } finally {
      if (store.db.isTransaction) store.db.exec("ROLLBACK");
      store.close();
    }
  }
  throw new Error(
    "Index generation or evidence was inconsistent twice during context lookup; retry the request",
  );
}

/** References are structured data, not capabilities: current scope is always re-evaluated. */
export async function expand(
  root: string,
  reference: unknown,
  options: ExpandOptions = {},
): Promise<ExpandResult> {
  validateFeatures(options);
  const ref = ReferenceSchema.parse(reference);
  const canonicalRoot = realpathSync(root);
  if (!existsSync(resolve(canonicalRoot, ".ctx/config.json")))
    throw new Error("Workspace is not initialized; run ctxgate init");
  for (const value of [options.before ?? 20, options.after ?? 20])
    if (!Number.isInteger(value) || value < 0 || value > 80)
      throw new Error(
        "Expansion before/after must be integers between 0 and 80",
      );
  const scan = captureWorktree(canonicalRoot, options.scan_limits);
  const { counter, budget } = await responseBudget(1000, options);
  const result: ExpandResult = {
    schema_version: 1,
    operation: "expand",
    root_id: rootId(scan.view.root),
    view_id: scan.view.id,
    generation: null,
    evidence_trust: "repository_data",
    status: "unavailable_reference",
    coverage: compactCoverage(scan.coverage),
    coverage_reason_count: scan.coverage.reasons.length,
    diagnostics: [],
    items: [],
    budget,
  };
  fitBase(result, counter);
  const file = scan.view.files.get(ref.path);
  if (ref.root_id !== result.root_id) {
    result.status = "invalid_reference";
    return finish(result, counter);
  }
  if (!file || (isNote(ref.path) && !options.notes) || file.kind === "metadata")
    return finish(result, counter);
  let reviewed: ReviewedNote | undefined;
  if (isNote(ref.path)) {
    const { readNotes } = await import("../notes/index.js");
    let analysis: ReturnType<typeof buildAnalysisContext> | undefined;
    const sources = [...scan.view.files.values()]
      .filter((file) => isNote(file.path))
      .sort((a, b) => compareText(a.path, b.path))
      .map((file) => ({
        path: file.path,
        text: file.text,
        content_hash: file.hash,
      }));
    const parsed = readNotes(
      sources,
      (path) => {
        const target = scan.view.files.get(path);
        if (!target || isNote(path) || target.kind === "metadata")
          return undefined;
        return {
          content_hash: target.hash,
          hasSymbol: (name: string) => {
            if (target.kind !== "source") return false;
            analysis ??= buildAnalysisContext(scan.view);
            return parseSource(target, analysis).symbols.some(
              (symbol) => symbol.name === name,
            );
          },
        };
      },
      scan.view.case_sensitive,
    );
    reviewed = parsed.notes.find(
      (note) =>
        note.path === ref.path && note.data.review_status === "accepted",
    );
    if (!reviewed) return finish(result, counter);
  }
  const lines = file.text.split("\n");
  if (file.hash !== ref.content_hash) {
    result.status = "stale_reference";
    const start = Math.min(ref.start_line, lines.length),
      end = Math.min(ref.end_line, lines.length);
    result.replacement = makeReference(
      result.root_id,
      result.view_id,
      file.path,
      file.hash,
      start,
      end,
    );
    if (!measure(result, counter)) {
      delete result.replacement;
      result.budget.truncated = true;
    }
    return finish(result, counter);
  }
  if (ref.end_line > lines.length) {
    result.status = "invalid_reference";
    return finish(result, counter);
  }
  if (reviewed) {
    result.items = [
      noteCandidate(reviewed, result.root_id, result.view_id).atomic!,
    ];
    result.status = "expanded";
    if (measure(result, counter)) return finish(result, counter);
    result.items = [];
    result.status = "budget_too_small";
    result.budget.truncated = true;
    return finish(result, counter);
  }
  const start = Math.max(1, ref.start_line - (options.before ?? 20)),
    end = Math.min(lines.length, ref.end_line + (options.after ?? 20));
  const candidate: Candidate = {
    path: file.path,
    content_hash: file.hash,
    kind: file.kind,
    start_line: start,
    end_line: end,
    file_end: lines.length,
    text: lines.slice(start - 1, end).join("\n"),
    tier: 0,
    rank: 0,
    reason: "validated source expansion",
  };
  const focus = Math.floor((ref.start_line + ref.end_line) / 2);
  for (const radius of [Math.max(focus - start, end - focus), 20, 10, 4, 0]) {
    const item = itemFor(
      candidate,
      result.root_id,
      result.view_id,
      focus,
      radius,
    );
    result.items = [item];
    result.status = "expanded";
    result.budget.truncated = item.omitted_before || item.omitted_after;
    if (measure(result, counter)) return finish(result, counter);
  }
  result.items = [];
  result.status = "budget_too_small";
  result.budget.truncated = true;
  return finish(result, counter);
}

// Assessment runner reuses packing without pretending a direct scan has a persisted generation.
export const retrievalInternals = {
  candidates,
  focusFor,
  itemFor,
  compactCoverage,
  rootId,
  packResult,
};
