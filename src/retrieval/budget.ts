import { type ContextResult, type ExpandResult } from "../contracts/index.js";

export type Encoding = "estimate" | "cl100k_base" | "o200k_base";
export interface Counter {
  method: "exact" | "estimate";
  name: string;
  count(text: string): number;
}
const counters = new Map<string, Counter>();
export async function tokenCounter(
  encoding: Encoding = "estimate",
): Promise<Counter> {
  if (encoding === "estimate")
    return {
      method: "estimate",
      name: "utf8-bytes/3",
      count: (text) => Math.ceil(Buffer.byteLength(text) / 3),
    };
  if (encoding !== "cl100k_base" && encoding !== "o200k_base")
    throw new Error(
      "Unsupported encoding; use estimate, cl100k_base or o200k_base",
    );
  const existing = counters.get(encoding);
  if (existing) return existing;
  const { Tiktoken } = await import("js-tiktoken/lite");
  const ranks =
    encoding === "cl100k_base"
      ? (await import("js-tiktoken/ranks/cl100k_base")).default
      : (await import("js-tiktoken/ranks/o200k_base")).default;
  const tokenizer = new Tiktoken(ranks);
  const counter: Counter = {
    method: "exact",
    name: encoding,
    count: (text) => tokenizer.encode(text, [], []).length,
  };
  counters.set(encoding, counter);
  return counter;
}
export interface BudgetOptions {
  budget_tokens?: number;
  remaining_tokens?: number;
  max_bytes?: number;
  encoding?: Encoding;
}
export async function responseBudget(
  defaultLimit: number,
  options: BudgetOptions,
) {
  const limit = options.budget_tokens ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 128 || limit > 4000)
    throw new Error("budget_tokens must be an integer between 128 and 4000");
  const remaining = options.remaining_tokens ?? 4000;
  if (!Number.isInteger(remaining) || remaining < 1 || remaining > 4000)
    throw new Error("remaining_tokens must be an integer between 1 and 4000");
  const bytes = options.max_bytes ?? 16384;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 16384)
    throw new Error("max_bytes must be an integer between 1 and 16384");
  const counter = await tokenCounter(options.encoding);
  return {
    counter,
    budget: {
      limit: Math.min(limit, remaining),
      count: 0,
      method: counter.method,
      counter: counter.name,
      byte_limit: bytes,
      bytes: 0,
      truncated: false,
    },
  };
}
export const renderResult = (result: ContextResult | ExpandResult) =>
  JSON.stringify(result) + "\n";
/** Measure the same compact envelope emitted by the CLI, including self-counting fields. */
export function measure<T extends ContextResult | ExpandResult>(
  result: T,
  counter: Counter,
): boolean {
  for (let attempt = 0; attempt < 12; attempt++) {
    const text = renderResult(result),
      bytes = Buffer.byteLength(text),
      count = counter.count(text);
    if (result.budget.bytes === bytes && result.budget.count === count)
      return count <= result.budget.limit && bytes <= result.budget.byte_limit;
    result.budget.bytes = bytes;
    result.budget.count = count;
  }
  throw new Error("Response accounting did not converge");
}
