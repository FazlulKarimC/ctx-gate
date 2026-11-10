# ctx-gate (`ctxgate`)

A deliberately simple, local-first repository context and boundary-checking SDK, CLI, and stdio MCP server for AI coding agents on TypeScript and JavaScript codebases.

Built on **Node 24 LTS** (`node:sqlite` WAL + FTS5, TypeScript syntax/module-resolution APIs, `js-tiktoken`, and Zod v4) with **zero external services, zero background daemons, and zero model calls inside the engine**.

---

## Core Documentation (Start Here)

1. **[`PROBLEM_AND_RESEARCH.md`](PROBLEM_AND_RESEARCH.md)** — Problem statement, why AI coding agents fail on repository context, comparison with RAG/graph/daemon alternatives, and research hypotheses.
2. **[`ARCHITECTURE_AND_TRADEOFFS.md`](ARCHITECTURE_AND_TRADEOFFS.md)** — The 6-module architecture, provenance & freshness contracts, full-envelope token budgeting, why graph neighbors & reviewed notes are default-off, and the trusted baseline boundary checker.
3. **[`IMPLEMENTATION_AND_EVALUATION.md`](IMPLEMENTATION_AND_EVALUATION.md)** — Phase-by-phase implementation record, empirical benchmark tables, `v0.1.1` bug fixes, the completed **12-arm Gemini 3.5 Flash Lite (`gemini-3.5-flash-lite`, `low` reasoning) held-out A/B evaluation**, and resume/interview highlights.

---

## Quickstart

Requires **Node 24 LTS** (`>=24 <25`) and **Git**.

```powershell
# Install locked dependencies, typecheck, build, and run all 90 tests
npm ci
npm run check

# Run the offline synthetic end-to-end demo (0 model calls)
node examples/demo.mjs
```

### CLI Commands

```powershell
# 1. Check runtime & SQLite FTS5/WAL readiness
node dist/cli/index.js doctor --root C:/path/to/repo --json

# 2. Initialize .ctx/config.json and .ctx/notes/
node dist/cli/index.js init --root C:/path/to/repo --json

# 3. Build or refresh the local SQLite/FTS5 index
node dist/cli/index.js index --root C:/path/to/repo --json

# 4. Retrieve a 2,000-token budgeted evidence brief (exact o200k_base tokens, <= 16 KiB)
node dist/cli/index.js context --root C:/path/to/repo --query "symbol:readSession" --encoding o200k_base --budget-tokens 2000 --json

# 5. Expand a provenance-bound reference (fails safely with stale_reference if the file changed)
node dist/cli/index.js expand --root C:/path/to/repo --ref '{"schema_version":1,"root_id":"...","view_id":"...","path":"src/db/session.ts","content_hash":"...","start_line":1,"end_line":3}' --json

# 6. Enforce direct-import boundary rules against a trusted baseline commit
node dist/cli/index.js check --root C:/path/to/repo --base <40-hex-commit-sha> --target worktree --mode required --json

# 7. Launch the fixed-root stdio MCP server (exposes ctx_context, ctx_expand, and advisory ctx_check)
node dist/cli/index.js mcp --root C:/path/to/repo
```

### Programmatic SDK Usage

```js
import { initialize, context, expand, check } from "./dist/index.js";

await initialize(repoRoot);
const brief = await context(repoRoot, "symbol:sum", {
  encoding: "o200k_base",
  budget_tokens: 2000,
});
const expanded = await expand(repoRoot, brief.items[0].reference, {
  encoding: "o200k_base",
  budget_tokens: 1000,
});
const verdict = check(repoRoot, { base: baselineCommitSha, mode: "required" });
```

---

## Key Empirical Takeaways

- **Lexical Retrieval vs. Raw Search:** On the 20-task development benchmark at a strict 2,000-token `o200k_base` budget, lexical retrieval (`v2`) hit `14/20` relevant source files and `11/20` labeled implementation spans (`45.00%` mean span recall) vs. `0/20` for an alphabetical `ripgrep` baseline.
- **Intra-Symbol Focus & Bounded Packing (`v2` vs. `v1`):** Focusing windows inside matched symbols and capping packing attempts at 40 reduced warm `p95` latency from `3.96 s` to `1.86 s` and reduced full-envelope tokenizer calls by `73%` (`406.85` to `108.80`).
- **Evidence-Gated Features:** One-hop import neighbors (`--neighbors`) and reviewed Markdown notes (`--notes`) are supported but **disabled by default** because controlled ablations showed they displaced `9–40` labeled code lines under fixed token budgets without adding new relevant spans.
- **Held-Out Agent A/B Evaluation (`gemini-3.5-flash-lite`, `low` reasoning, 12 arms across 6 tasks):**
  - **100% Pre-Edit Tool Uptake:** Condition `B` (`ctx-gate`) called `ctx_context` before the first file edit on `6 / 6` tasks (`251 ms – 2,187 ms` warm retrieval).
  - **Test-Verified Resolution (`resolved_clean`):** Condition `B` solved **`4 / 6` tasks** (`picomatch-h07`, `json-server-h09`, `fastify-h01`, `fastify-h03`) vs. **`3 / 6` tasks** for Condition `A` (which failed `picomatch-h07`).
  - **Faster Convergence on Shared Solves:** Across the 3 tasks solved by both arms (`json-server-h09`, `fastify-h01`, `fastify-h03`), Condition `B` reduced mean wall-clock solve time by **`38.5%`** (`106.32 s` -> `65.37 s`), cut workspace commands from `10.0` to `7.33`, and reached the first substantive edit earlier (event `5.67` vs. `8.00`), at the cost of higher cumulative prompt tokens due to multi-turn context payload replay ([`eval/summaries/phase8-gemini.json`](eval/summaries/phase8-gemini.json)).
