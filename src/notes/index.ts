import { parseDocument, visit, isAlias } from "yaml";
import { Minimatch } from "minimatch";
import { NoteSchema, type EvidenceItem } from "../contracts/index.js";
import { digest } from "../workspace/snapshot.js";
import { type Query } from "../retrieval/query.js";

export interface NoteSource {
  path: string;
  text: string;
  content_hash: string;
}
export interface Binding {
  content_hash: string;
  hasSymbol: (name: string) => boolean;
}
export interface ReviewedNote extends NoteSource {
  data: ReturnType<typeof NoteSchema.parse>;
  body: string;
  metadata?: NonNullable<EvidenceItem["note"]>;
  scopes: Minimatch[];
}
export const NOTE_LIMITS = {
  files: 100,
  bytes: 65536,
  header_bytes: 16384,
  selected: 2,
} as const;

/** A review declaration is repository data, never an authenticated endorsement. */
export function readNotes(
  sources: NoteSource[],
  binding: (path: string) => Binding | undefined,
  caseSensitive = true,
) {
  // A truncated inventory cannot establish ID uniqueness. Fail closed for notes.
  if (sources.length > NOTE_LIMITS.files)
    return { notes: [] as ReviewedNote[], invalid: 0, limited: true };
  const parsed: ReviewedNote[] = [];
  let invalid = 0;
  for (const source of sources.slice(0, NOTE_LIMITS.files)) {
    try {
      if (
        !source.path.toLowerCase().endsWith(".md") ||
        Buffer.byteLength(source.text) > NOTE_LIMITS.bytes ||
        digest(source.text) !== source.content_hash
      )
        throw Error("Note bytes");
      const lines = source.text.split("\n");
      if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---")
        throw Error("Frontmatter missing");
      const end = lines.findIndex(
        (line, index) => index > 0 && line.trim() === "---",
      );
      if (end < 1) throw Error("Frontmatter missing");
      const header = lines.slice(1, end).join("\n");
      if (Buffer.byteLength(header) > NOTE_LIMITS.header_bytes)
        throw Error("Frontmatter cap");
      const doc = parseDocument(header, {
        version: "1.2",
        schema: "core",
        strict: true,
        uniqueKeys: true,
        stringKeys: true,
        logLevel: "silent",
      });
      if (doc.errors.length || doc.warnings.length)
        throw Error("YAML diagnostics");
      visit(doc, (_key, node) => {
        if (
          isAlias(node) ||
          (typeof node === "object" &&
            node !== null &&
            "tag" in node &&
            node.tag)
        )
          throw Error("Aliases/tags unsupported");
      });
      const data = NoteSchema.parse(doc.toJS({ maxAliasCount: 0 }));
      const states = data.evidence.map((e) => {
        const file = binding(e.path);
        return !file
          ? "target_missing"
          : file.content_hash !== e.content_hash ||
              (e.symbol && !file.hasSymbol(e.symbol))
            ? "needs_review"
            : "current";
      });
      const freshness = !states.length
        ? "unbound"
        : states.includes("target_missing")
          ? "target_missing"
          : states.includes("needs_review")
            ? "needs_review"
            : "current";
      parsed.push({
        ...source,
        data,
        body: lines.slice(end + 1).join("\n"),
        ...(data.review_status === "accepted"
          ? {
              metadata: {
                id: data.id,
                review_status: "accepted",
                freshness,
                reviewer: data.reviewer ?? "",
                reviewed_revision: data.last_reviewed_revision ?? "",
                evidence_count: data.evidence.length,
              },
            }
          : {}),
        scopes: data.scopes.map(
          (pattern) =>
            new Minimatch(pattern === "." ? "**" : pattern, {
              dot: true,
              nobrace: true,
              noext: true,
              nonegate: true,
              nocase: !caseSensitive,
            }),
        ),
      });
    } catch {
      invalid++;
    }
  }
  const counts = new Map<string, number>();
  for (const note of parsed)
    counts.set(note.data.id, (counts.get(note.data.id) ?? 0) + 1);
  const notes = parsed.filter((note) => counts.get(note.data.id) === 1);
  invalid += parsed.length - notes.length;
  return { notes, invalid, limited: sources.length > NOTE_LIMITS.files };
}

export function selectNotes(
  notes: ReviewedNote[],
  query: Query,
  rankedPaths: string[],
  eligiblePaths: string[],
) {
  const selected = notes
    .filter((note) => note.data.review_status === "accepted")
    .map((note) => {
      const text = (
        note.data.title +
        " " +
        note.data.rationale +
        " " +
        note.body
      ).toLowerCase();
      const score = query.terms.reduce(
        (sum, term) => sum + Number(text.includes(term)),
        0,
      );
      const scoped = (paths: string[]) =>
        paths.some((path) => note.scopes.some((scope) => scope.match(path)));
      const generic = note.data.scopes.some((scope) =>
        ["**", "**/*", "*", "."].includes(scope),
      );
      const matches =
        (scoped(rankedPaths) && !generic) ||
        (score > 0 && scoped(eligiblePaths));
      return { note, score, matches };
    })
    .filter((row) => row.matches)
    .sort(
      (a, b) =>
        b.score - a.score || a.note.data.id.localeCompare(b.note.data.id, "en"),
    );
  return {
    notes: selected.slice(0, NOTE_LIMITS.selected).map((row) => row.note),
    eligible: selected.length,
  };
}
