# Problem Description & Research: Local Context Management for AI Coding Agents

`ctx-gate` is a deliberately simple, local-first context-management SDK, CLI, and MCP server for AI coding agents working on TypeScript and JavaScript repositories. It was built both as a **working developer tool** and as an **empirical engineering study** to answer a concrete question:

> *How far can deterministic, zero-service local indexing, lexical retrieval, source-bound freshness checks, and direct-import boundary checking go before an AI coding system genuinely needs embeddings, background daemons, multi-hop graphs, or persistent agent memory?*

---

## 1. The Core Problem

When an AI coding agent modifies a non-trivial repository, three distinct failure modes appear:

1. **Unbounded Exploration & Token Bloat**
   - Agents issuing unconstrained `grep`/`find` commands or reading entire files often pull irrelevant documentation, lockfiles, generated artifacts, or wrong branches of long functions into their prompt window.
   - Without strict full-response token and byte caps, a single tool response can silently consume tens of thousands of tokens and displace working context.

2. **Stale Context Across Multi-Step Edits**
   - During an editing session, an agent or developer modifies files while earlier excerpts remain in the conversation history.
   - Expanding or relying on line numbers from a mutated file without verifying content hashes causes off-by-N edits and hallucinated patches.

3. **Architectural Boundary Drift**
   - Even when an agent writes code that compiles and passes unit tests, it frequently violates repository layering rules (for example, importing a database module directly from a UI component instead of routing through a service layer, or weakening configuration/ignore rules to make a check pass).

---

## 2. Why Existing Approaches Often Over-Complicate the Stack

| Approach | Typical Mechanism | What Works Well | Where It Breaks Down for Local Coding Agents |
| :--- | :--- | :--- | :--- |
| **Raw Grep / File Reads** (`ripgrep`, shell search) | Unranked regex/literal matches | Zero setup, always fresh | Alphabetical/file-order bias spends token budgets on docs, tests, or noisy matches before runtime implementation code. |
| **Vector RAG / Embeddings** | Chunking + remote/local embedding model + vector DB | Bridges pure natural-language synonyms | Requires external API keys or heavy local model weights, suffers from index staleness on fast branch switches, and often loses exact symbol/path precision. |
| **Deep Code-Graph / Semantic Indexers** | Full `ts.Program` typechecking, call-graph databases, background watchers | Rich type and call hierarchy | High memory/CPU overhead, fragile across partial/broken worktrees or missing `node_modules`, and multi-hop expansion rapidly crowds tight token budgets. |
| **Automated Agent Memory / Unreviewed Notes** | Agent-written summaries persisted across sessions | Captures conversational history | Unverified notes silently rot as code changes, turning yesterday's guess into today's authoritative hallucination. |

---

## 3. What `ctx-gate` Solves (and What It Explicitly Rejects)

`ctx-gate` targets the **minimum sufficient architecture** that solves the mechanical problems above with **zero external services, zero background daemons, and zero model calls inside the engine**:

### Core Capabilities
1. **Deterministic Repository Snapshot & Indexing (`ctxgate index`)**
   - Captures either the live worktree (with double-scan verification to detect mid-index mutations) or an immutable Git commit (`git ls-tree` + byte-framed `git cat-file --batch`).
   - Uses TypeScript's syntax parser and module-resolution rules over the captured view (`node:sqlite` WAL + FTS5) without constructing a heavy semantic `ts.Program` or falling back to live `node_modules`.
2. **Budgeted Lexical Evidence Packing (`ctxgate context`)**
   - Combines path anchors, explicit `symbol:` anchors, code-shaped identifiers, quoted phrases, camelCase/snake_case subtokens, and BM25-weighted FTS5 search (`[8, 4, 2, 2, 1]`).
   - Focuses within matched functions (Lexical `v2`) so long functions return both the signature entry and the highest-scoring internal branch window.
   - Enforces a strict token budget (default `2,000` tokens, max `4,000`, using `bytes_div_3` or exact local `o200k_base`/`cl100k_base` via `js-tiktoken`) and a hard `16 KiB` UTF-8 ceiling over the **entire serialized JSON response plus trailing newline**.
3. **Source-Bound Reference Expansion (`ctxgate expand`)**
   - Every returned excerpt carries a structured provenance reference (`root_id`, `view_id`, `path`, `content_hash`, `start_line`, `end_line`).
   - Expanding a reference re-verifies the current file's SHA-256 hash; if the file changed, `expand` returns `status: "stale_reference"` with a replacement reference and **withholds stale source lines**.
4. **Evidence-Gated Optional Features (`--neighbors`, `--notes`)**
   - One-hop import neighbors and human-reviewed `.ctx/notes/*.md` with SHA-256 evidence bindings are supported, but **disabled by default** because controlled experiments showed they displaced higher-value lexical code under fixed 1,000–4,000 token budgets.
5. **Trusted Direct-Import Boundary Enforcement (`ctxgate check`)**
   - Compares a baseline commit against a target commit or worktree using explicit `deny_import` rules from the trusted baseline/policy revision.
   - Prevents candidate code from bypassing enforcement by editing `.ctx/config.json` or `.gitignore`, distinguishes new violations (`exit 1`) from pre-existing debt (`exit 0`), and fails closed (`exit 2`) when coverage is incomplete.

---

## 4. Research Hypotheses & Summary of Findings

| Hypothesis | Tested Mechanism | Empirical Finding | Architectural Decision |
| :--- | :--- | :--- | :--- |
| **H1: Structured lexical ranking beats unranked text search under a fixed token budget** | Phase 3 (`R1` lexical v1 vs. `R0` alphabetical `ripgrep` at 2,000 `o200k_base` tokens on 20 dev tasks) | `R0` hit `0/20` labeled source files (budget spent on dotfiles/docs); `R1` hit `16/20` source files and `9/20` labeled spans (`36.25%` mean span recall). | Keep weighted FTS5 + anchor tiers as the core retrieval engine. |
| **H2: Within-symbol window focusing and bounded packing reduce tail latency and improve span recall** | Phase 4.0 (`v2` vs. `v1` across 20 dev tasks) | `v2` improved labeled-span hits (`9/20` -> `11/20`), mean span recall (`36.25%` -> `45.00%`), reduced warm `p95` (`3.96 s` -> `1.86 s`), and cut mean tokenizer calls (`406.85` -> `108.80`), while trading 2 file-only hits (`16/20` -> `14/20`). | Promote `v2` to default; retain `v1` as an explicit selectable control. |
| **H3: Adding 1-hop import neighbors or reviewed notes improves fixed-budget context briefs** | Phase 4 (`L`, `G`, `N`, `GN` across 20 dev tasks at 1,000 / 2,000 / 4,000 tokens) | **Refuted for default use:** Neither `G` nor `N` added a single new labeled source line on the 20 tasks, while displacing `9–40` labeled lines due to metadata and slot competition. | Keep `neighbors: false` and `notes: false` by default; expose as explicit opt-ins. |
| **H4: Syntactic baseline-vs-target import checking can enforce boundaries without a semantic compiler or candidate-policy trust** | Phase 6 (16 registered synthetic patch cases + CLI commit helper) | `16/16` expected verdicts matched (`6` TP, `0` FP, `6` TN, `0` FN, `4` conservative `incomplete` cases exiting `2`), including candidate `.ctx/config.json` bypass attempts. | Keep syntactic direct-import checker with trusted baseline policy and conservative coverage reporting. |

---

## 5. Companion Documents

- **[`README.md`](README.md)** — Quickstart, CLI/SDK/MCP usage, and reproducible demo commands.
- **[`ARCHITECTURE_AND_TRADEOFFS.md`](ARCHITECTURE_AND_TRADEOFFS.md)** — Deep dive into the 6-module design, data contracts, security boundaries, and rejected alternatives.
- **[`IMPLEMENTATION_AND_EVALUATION.md`](IMPLEMENTATION_AND_EVALUATION.md)** — Complete implementation record, benchmark tables, post-study bug fixes, Gemini Flash 3.8 (`low` reasoning) evaluation harness, and interview/portfolio notes.
