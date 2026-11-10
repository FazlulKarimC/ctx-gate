import { splitIdentifiers } from "../analyzer/index.js";
import { type Query } from "./query.js";
import { type Candidate } from "./index.js";

const tokens = (text: string) =>
  new Set(
    (text + " " + splitIdentifiers(text))
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [],
  );
export function behaviorTerms(query: Query): string[] {
  const anchors = tokens(
    [...query.symbols, ...query.paths, "symbol path"].join(" "),
  );
  return query.terms.filter((term) => !anchors.has(term));
}

/** Small local lexical window, not inferred execution behavior or semantic analysis. */
function profile(rows: Candidate[], terms: string[]) {
  const lines = new Map<number, Set<string>>();
  for (const row of rows)
    row.text.split("\n").forEach((text, index) => {
      const line = row.start_line + index;
      if (
        line < (row.symbol_start ?? row.start_line) ||
        line > (row.symbol_end ?? row.end_line) ||
        lines.has(line)
      )
        return;
      const present = tokens(text);
      lines.set(line, new Set(terms.filter((term) => present.has(term))));
    });
  const frequencies = new Map(terms.map((term) => [term, 0]));
  for (const present of lines.values())
    for (const term of present)
      frequencies.set(term, frequencies.get(term)! + 1);
  const weight = (term: string) => 1 / Math.sqrt(1 + frequencies.get(term)!);
  const score = (present: Set<string>) =>
    [...present].reduce((sum, term) => sum + weight(term), 0);
  return rows.map((row) => {
    const low = Math.max(row.start_line, row.symbol_start ?? row.start_line),
      high = Math.min(row.end_line, row.symbol_end ?? row.end_line);
    let best = Math.max(low, Math.min(high, row.focus ?? low)),
      bestScore = 0,
      bestOwn = -1;
    for (let center = low; center <= high; center++) {
      const present = new Set<string>();
      for (
        let line = Math.max(low, center - 4);
        line <= Math.min(high, center + 4);
        line++
      )
        for (const term of lines.get(line) ?? []) present.add(term);
      const value = score(present),
        own = score(lines.get(center) ?? new Set());
      if (value > bestScore || (value === bestScore && own > bestOwn)) {
        best = center;
        bestScore = value;
        bestOwn = own;
      }
    }
    return { row, focus: best, score: bestScore };
  });
}

export function bodyFocusedCandidates(
  rows: Candidate[],
  query: Query,
): Candidate[] {
  const terms = behaviorTerms(query);
  if (!terms.length) return rows;
  const groups = new Map<string, Candidate[]>(),
    output: Candidate[] = [];
  for (const row of rows) {
    if (row.symbol_start !== undefined && row.symbol_end !== undefined) {
      const key = row.path + ":" + row.symbol_start + ":" + row.symbol_end;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    } else {
      const match = profile([row], terms)[0]!;
      output.push(
        match.score > 0
          ? {
              ...row,
              focus: match.focus,
              ...(row.reason === "path anchor" ? { rank: -match.score } : {}),
            }
          : row,
      );
    }
  }
  for (const group of groups.values()) {
    const matches = profile(group, terms).sort(
      (a, b) => b.score - a.score || a.focus - b.focus,
    );
    const best = matches[0]!;
    const entry = group.find(
      (row) =>
        row.symbol_start! >= row.start_line &&
        row.symbol_start! <= row.end_line,
    );
    if (best.score === 0) {
      if (entry) output.push(entry);
      continue;
    }
    output.push({
      ...best.row,
      focus: best.focus,
      rank: -best.score,
      focus_role: 0,
    });
    // Keep orientation as well as behavior when they do not fit the same chunk/window.
    if (
      entry &&
      (entry.start_line !== best.row.start_line ||
        Math.abs(best.focus - entry.symbol_start!) > 16)
    )
      output.push({
        ...entry,
        focus: entry.symbol_start!,
        rank: -best.score,
        focus_role: 1,
      });
  }
  return output;
}
