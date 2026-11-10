import { type DatabaseSync } from "node:sqlite";
import { type Candidate } from "./index.js";
import { behaviorTerms, bodyFocusedCandidates } from "./focus.js";
import { quoteFts, compareText, type Query } from "./query.js";
import { isNotePath } from "../workspace/snapshot.js";

export const GRAPH_LIMITS = {
  seeds: 3,
  candidates: 20,
  inspect: 40,
  hub: 25,
  scan: 200,
} as const;
interface Edge {
  source: string;
  target: string;
  kind: "runtime" | "type_only";
}
/** Direct import relationships only. Importers are not proven runtime callers. */
export function neighbors(
  db: DatabaseSync,
  lexical: Candidate[],
  query: Query,
  bodyFocus: boolean,
  queryText: string,
) {
  const seeds = [
    ...new Set(
      lexical
        .filter((row) => row.kind === "source" && !isNotePath(row.path))
        .map((row) => row.path),
    ),
  ].slice(0, GRAPH_LIMITS.seeds);
  const usage =
    /\b(usages?|callers?|importers?|references|called by|who uses)\b/i.test(
      queryText,
    );
  const terms = behaviorTerms(query),
    expression = terms.map(quoteFts).join(" OR ");
  const stats = {
    seed_files: seeds.length,
    candidates: 0,
    high_degree_seeds: 0,
    suppressed_unmatched: 0,
    unknown_edges: 0,
    capped: false,
  };
  const found: {
    path: string;
    anchor: string;
    direction: "incoming" | "outgoing";
    kind: Edge["kind"];
    score: number;
  }[] = [];
  for (const seed of seeds) {
    const degree = Number(
      (
        db
          .prepare(
            "SELECT count(DISTINCT source) n FROM imports WHERE target=? AND resolution='resolved_local' AND lower(source) NOT LIKE '.ctx/notes/%'",
          )
          .get(seed) as { n: number }
      ).n,
    );
    const hub = degree > GRAPH_LIMITS.hub;
    if (hub) stats.high_degree_seeds++;
    stats.unknown_edges += Number(
      (
        db
          .prepare(
            "SELECT count(*) n FROM imports WHERE source=? AND resolution NOT IN ('resolved_local','external_declared','builtin')",
          )
          .get(seed) as { n: number }
      ).n,
    );
    // Rank relevant importers across the whole adjacency before the bounded filename scan.
    const relevant = new Map<string, number>();
    if (expression) {
      const rows = db
        .prepare(
          "SELECT c.path,bm25(chunk_search,8,4,2,2,1) rank FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ? AND EXISTS(SELECT 1 FROM imports i WHERE i.source=c.path AND i.target=? AND i.resolution='resolved_local' AND lower(i.source) NOT LIKE '.ctx/notes/%') ORDER BY rank,c.path,c.start_line LIMIT ?",
        )
        .all(expression, seed, GRAPH_LIMITS.scan) as {
        path: string;
        rank: number;
      }[];
      for (const row of rows)
        if (!relevant.has(row.path)) relevant.set(row.path, row.rank);
      if (rows.length === GRAPH_LIMITS.scan) stats.capped = true;
    }
    const incoming: Edge[] = [];
    for (const path of relevant.keys())
      incoming.push(
        ...(db
          .prepare(
            "SELECT source,target,kind FROM imports WHERE source=? AND target=? AND resolution='resolved_local' ORDER BY kind DESC LIMIT 1",
          )
          .all(path, seed) as unknown as Edge[]),
      );
    const scanned = db
      .prepare(
        "SELECT source,target,kind FROM imports WHERE target=? AND resolution='resolved_local' AND lower(source) NOT LIKE '.ctx/notes/%' GROUP BY source,kind ORDER BY source,kind DESC LIMIT ?",
      )
      .all(seed, GRAPH_LIMITS.scan) as unknown as Edge[];
    incoming.push(...scanned);
    if (degree > GRAPH_LIMITS.scan) stats.capped = true;
    if (hub && !usage)
      stats.suppressed_unmatched += Math.max(0, degree - relevant.size);
    const outgoing = db
      .prepare(
        "SELECT source,target,kind FROM imports WHERE source=? AND resolution='resolved_local' AND target IS NOT NULL AND lower(target) NOT LIKE '.ctx/notes/%' ORDER BY kind DESC,target LIMIT ?",
      )
      .all(seed, GRAPH_LIMITS.scan + 1) as unknown as Edge[];
    if (outgoing.length > GRAPH_LIMITS.scan) stats.capped = true;
    for (const direction of usage
      ? (["incoming", "outgoing"] as const)
      : (["outgoing", "incoming"] as const)) {
      const edges =
        direction === "outgoing"
          ? outgoing.slice(0, GRAPH_LIMITS.scan)
          : incoming;
      for (const edge of edges) {
        const path = direction === "outgoing" ? edge.target : edge.source;
        if (path === seed || seeds.includes(path) || isNotePath(path)) continue;
        if (direction === "incoming" && hub && !usage && !relevant.has(path))
          continue;
        const rank = lexical.findIndex((row) => row.path === path);
        const relevance = relevant.get(path) ?? 0;
        found.push({
          path,
          anchor: seed,
          direction,
          kind: edge.kind,
          score:
            (direction === (usage ? "incoming" : "outgoing") ? 0 : 10000) +
            (rank >= 0 ? rank - 1000 : 0) +
            relevance +
            (edge.kind === "type_only" ? 100 : 0),
        });
      }
    }
  }
  found.sort(
    (a, b) =>
      a.score - b.score ||
      compareText(a.path, b.path) ||
      compareText(a.anchor, b.anchor),
  );
  const seen = new Set<string>(),
    output: Candidate[] = [];
  let inspected = 0;
  for (const edge of found) {
    if (seen.has(edge.path)) continue;
    seen.add(edge.path);
    if (inspected++ >= GRAPH_LIMITS.inspect) {
      stats.capped = true;
      break;
    }
    const rows = db
      .prepare(
        "SELECT c.path,f.content_hash,f.kind,c.start_line,c.end_line,c.text,(SELECT max(end_line) FROM chunks e WHERE e.path=c.path) file_end FROM chunks c JOIN files f ON f.path=c.path WHERE c.path=? ORDER BY c.ordinal LIMIT 200",
      )
      .all(edge.path) as unknown as Candidate[];
    const best =
      lexical.find((row) => row.path === edge.path) ??
      (expression
        ? (db
            .prepare(
              "SELECT c.start_line FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ? AND c.path=? ORDER BY bm25(chunk_search),c.start_line LIMIT 1",
            )
            .get(expression, edge.path) as { start_line: number } | undefined)
        : undefined);
    let candidate =
      rows.find((row) => row.start_line === best?.start_line) ?? rows[0];
    if (!candidate) continue;
    candidate = {
      ...candidate,
      tier: 1,
      rank: edge.score,
      reason: "one-hop " + edge.direction + " import",
      relationship: {
        direction: edge.direction,
        anchor: edge.anchor,
        edge_kind: edge.kind,
      },
    };
    if (bodyFocus) candidate = bodyFocusedCandidates([candidate], query)[0]!;
    output.push(candidate);
    if (output.length >= GRAPH_LIMITS.candidates) {
      stats.capped = found.length > output.length;
      break;
    }
  }
  stats.candidates = output.length;
  return { candidates: output, stats };
}
