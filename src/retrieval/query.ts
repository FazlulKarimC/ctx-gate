import { splitIdentifiers } from "../analyzer/index.js";

// Fixed initial heuristic, not fitted to task outcomes.
export type LexicalVariant = "v1" | "v2";
export const DEFAULT_LEXICAL_VARIANT: LexicalVariant = "v2";
export const LEXICAL_VERSION = "lexical-v2";
export const LEXICAL_VARIANTS = Object.freeze({
  v1: Object.freeze({ body_focus: false, packing_candidates: 200 }),
  v2: Object.freeze({ body_focus: true, packing_candidates: 40 }),
});
export const LEXICAL_DEFAULTS = Object.freeze({
  candidate_limit: 200,
  max_items: 6,
  per_file: 2,
  excerpt_radius: 8,
  field_weights: [8, 4, 2, 2, 1] as const,
});
const stop = new Set(
  "a an and are as at be been but by can code could do does doing feature find fix for from has have help how i in into is it its me of on or our please should than that the their them there these they this to use want was we what when where which while will with would you your".split(
    " ",
  ),
);
const words = (text: string) => text.match(/[\p{L}\p{N}_]+/gu) ?? [];
export interface Query {
  terms: string[];
  symbols: string[];
  paths: string[];
  phrases: string[];
  truncated: boolean;
}
export function normalizeQuery(query: string): Query {
  if (typeof query !== "string" || !query.trim())
    throw new Error("Query must not be empty");
  if (Buffer.byteLength(query) > 8192)
    throw new Error("Query exceeds 8192 UTF-8 bytes");
  const raw = words(query);
  const allTerms = [
    ...new Set(
      [...raw, ...words(splitIdentifiers(query))]
        .map((term) => term.toLowerCase())
        .filter((term) => term.length > 1 && !stop.has(term)),
    ),
  ];
  const explicitSymbols = [
    ...query.matchAll(/\bsymbol:([\p{L}\p{N}_$.]+)/gu),
  ].map((match) => match[1]!);
  const qualified = (
    query.match(
      /\b[\p{L}_$][\p{L}\p{N}_$]+(?:\.[\p{L}_$][\p{L}\p{N}_$]+)+/gu,
    ) ?? []
  ).filter((name) => !/\.(?:[cm]?[jt]sx?|jsonc?|md)$/i.test(name));
  const symbols = [
    ...new Set([
      ...explicitSymbols,
      ...qualified.flatMap((name) => [name, name.split(".").at(-1)!]),
      ...raw.filter(
        (word) =>
          !stop.has(word.toLowerCase()) &&
          word.length > 1 &&
          (raw.length === 1 || /[a-z][A-Z]|[A-Z]{2}|_/.test(word)),
      ),
    ]),
  ];
  const paths = [
    ...new Set(
      (
        query.match(
          /(?:[\p{L}\p{N}_@.\-]+\/)*[\p{L}\p{N}_@.\-]+\.(?:[cm]?[jt]sx?|jsonc?|md)\b/gu,
        ) ?? []
      ).filter((path) => !path.split("/").includes("..")),
    ),
  ];
  const phrases = [...query.matchAll(/["'`]([^"'`\r\n]{2,120})["'`]/g)]
    .map((match) => words(match[1]!).slice(0, 8).join(" "))
    .filter(Boolean)
    .slice(0, 4);
  return {
    terms: allTerms.slice(0, 32),
    symbols: symbols.slice(0, 24),
    paths: paths.slice(0, 8),
    phrases,
    truncated: allTerms.length > 32 || symbols.length > 24 || paths.length > 8,
  };
}
export const quoteFts = (text: string) =>
  '"' + text.replaceAll('"', '""') + '"';
export const compareText = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
export const isNote = (path: string) =>
  path.toLowerCase() === ".ctx/notes" ||
  path.toLowerCase().startsWith(".ctx/notes/");
