export * from "./contracts/index.js";
export { check, renderCheck, CheckOptionsSchema } from "./checker/index.js";
export type { CheckOptions } from "./checker/index.js";
export { initialize } from "./workspace/initialize.js";
export { doctor } from "./cli/doctor.js";
export { refreshIndex } from "./indexer.js";
export { captureWorktree, MemoryView } from "./workspace/snapshot.js";
export { captureCommit } from "./workspace/git.js";
export {
  context,
  expand,
  renderResult,
  normalizeQuery,
  LEXICAL_VERSION,
  LEXICAL_DEFAULTS,
  LEXICAL_VARIANTS,
  DEFAULT_LEXICAL_VARIANT,
} from "./retrieval/index.js";
export type {
  ContextOptions,
  ExpandOptions,
  Encoding,
  BudgetOptions,
  LexicalVariant,
} from "./retrieval/index.js";
export {
  buildAnalysisContext,
  parseSource,
  resolveImports,
} from "./analyzer/index.js";
