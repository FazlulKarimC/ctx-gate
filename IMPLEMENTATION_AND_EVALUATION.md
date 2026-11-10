# Implementation Plan, Experiments & Evaluation Record

This document consolidates the implementation roadmap, empirical benchmark results across all phases, post-study maintenance fixes (`v0.1.1`), the **Gemini Flash 3.8 (`low` reasoning)** evaluation configuration, and portfolio/interview takeaways.

---

## 1. Phase-by-Phase Implementation Summary

| Phase | Scope | Status | Key Verification & Artifacts |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Protocol, corpus qualification (20 dev + 18 holdout tasks across Picomatch, JSON Server, Fastify) | **Done** | [`eval/protocol.md`](eval/protocol.md), [`eval/manifests/agent-pool.json`](eval/manifests/agent-pool.json), [`eval/summaries/corpus-qualification.json`](eval/summaries/corpus-qualification.json) |
| **Phase 1** | Foundation: TypeScript/ESM package, Zod v4 contracts, `init`, `doctor`, `node:sqlite` FTS5 + WAL | **Done** | [`src/contracts/index.ts`](src/contracts/index.ts), [`src/cli/doctor.ts`](src/cli/doctor.ts), [`eval/summaries/foundation-source.json`](eval/summaries/foundation-source.json) |
| **Phase 2** | Indexing & Freshness: worktree double-scan, immutable Git capture, AST symbols/imports, SQLite store | **Done** | [`src/indexer.ts`](src/indexer.ts), [`src/analyzer/index.ts`](src/analyzer/index.ts), [`eval/summaries/index-profile.json`](eval/summaries/index-profile.json) |
| **Phase 3** | Lexical Retrieval `v1` & Source-Bound Expansion (`context`, `expand`, full-envelope budgets) | **Done** | [`src/retrieval/index.ts`](src/retrieval/index.ts), [`eval/summaries/lexical-baseline.json`](eval/summaries/lexical-baseline.json), [`eval/summaries/packing-profile.json`](eval/summaries/packing-profile.json) |
| **Phase 4.0** | Bounded Lexical Refinement `v2` (intra-symbol window focus + 40-candidate packing cap) | **Done** | [`src/retrieval/focus.ts`](src/retrieval/focus.ts), [`eval/summaries/lexical-refinement.json`](eval/summaries/lexical-refinement.json) |
| **Phase 4** | Optional 1-Hop Import Neighbors (`--neighbors`) & Reviewed Notes (`--notes`) + Ablation Study | **Done** | [`src/retrieval/neighbors.ts`](src/retrieval/neighbors.ts), [`src/notes/index.ts`](src/notes/index.ts), [`eval/summaries/context-features.json`](eval/summaries/context-features.json) |
| **Phase 5** | Fixed-Root Stdio MCP Server (`ctx_context`, `ctx_expand`, `ctx_check`) & Host Integration | **Done** | [`src/mcp/index.ts`](src/mcp/index.ts), [`eval/summaries/phase5-pilot.json`](eval/summaries/phase5-pilot.json) |
| **Phase 6** | Direct-Import Boundary Checker (`ctxgate check`) & 16-Case Registered Patch Study | **Done** | [`src/checker/index.ts`](src/checker/index.ts), [`eval/summaries/checker.json`](eval/summaries/checker.json) |
| **Phase 7** | Operational Scaling Profile (106 / 506 / 1,006 files), Mutation Resilience & Evaluation Freeze | **Done** | [`eval/summaries/operational.json`](eval/summaries/operational.json), [`eval/manifests/evaluation-freeze.json`](eval/manifests/evaluation-freeze.json) |
| **Phase 8** | Held-Out A/B Evaluation Harness (transitioned to **Gemini Flash 3.8, `low` reasoning**) | **Ready (Preview Verified)** | [`eval/manifests/phase8-gemini-policy.json`](eval/manifests/phase8-gemini-policy.json), [`eval/scripts/phase8-gemini-run.mjs`](eval/scripts/phase8-gemini-run.mjs) |
| **Phase 9** | Offline Synthetic Demo, Clean-Copy Reproducibility & Consolidated Documentation | **Done** | [`examples/demo.mjs`](examples/demo.mjs), [`eval/scripts/portfolio-reproduce.mjs`](eval/scripts/portfolio-reproduce.mjs), [`eval/summaries/portfolio-reproduction.json`](eval/summaries/portfolio-reproduction.json) |

---

## 2. Empirical Benchmark Results (No-Model Local Studies)

### 2.1 Indexing & Refresh Profile (Phase 2)
Measured on Windows 11 x64 (Ryzen 5 5600H, 16 GB RAM, Node 24 LTS, SQLite 3.53.4) across the pinned repository heads ([`eval/summaries/index-profile.json`](eval/summaries/index-profile.json)):

| Repository | Eligible / Source Files | Eligible Bytes | Cold Build | Warm Refresh (`p50` / `p95`) | 1-File Edit Refresh | SQLite Cache Size |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Picomatch** | 73 / 62 | 838 kB | 776 ms | 465 / 487 ms | 479 ms | 2.79 MB |
| **JSON Server** | 25 / 16 | 82 kB | 295 ms | 245 / 258 ms | 239 ms | 0.36 MB |
| **Fastify** | 358 / 299 | 2.97 MB | 2,681 ms | 1,812 / 1,965 ms | 1,792 ms | 12.99 MB |

*Every warm refresh reparsed `0` files; every 1-file edit reparsed `1` file.*

### 2.2 Lexical Retrieval `v1` vs. Fixed `ripgrep` Baseline `R0` vs. Lexical `v2` (Phases 3 & 4.0)
Evaluated across the 20 pre-fix development tasks at a strict `2,000`-token `o200k_base` budget ([`eval/summaries/lexical-baseline.json`](eval/summaries/lexical-baseline.json), [`eval/summaries/lexical-refinement.json`](eval/summaries/lexical-refinement.json)):

| Metric (20 Development Tasks) | `R0` (Fixed `ripgrep` OR) | `R1` (Lexical `v1`) | `v2` (Intra-Symbol Focus + 40-Cap) |
| :--- | ---: | ---: | ---: |
| **Labeled source-file hits** | 0 / 20 | **16 / 20** | 14 / 20 |
| **Any labeled-source-span overlap** | 0 / 20 | 9 / 20 | **11 / 20** |
| **Mean per-case labeled-span recall** | 0.00% | 36.25% | **45.00%** |
| **Mean labeled source-line coverage** | 0.00% | 18.51% | **23.79%** |
| **Mean useful-file precision** | 2.00% | **38.00%** | 36.58% |
| **Warm latency `p50` / `p95`** | 0.44 s / 5.76 s | 1.78 s / 3.96 s | **1.12 s / 1.86 s** |
| **Mean full-envelope tokenizer calls** | — | 406.85 | **108.80** |

### 2.3 Context Features Ablation: Why Neighbors & Notes Are Default-Off (Phase 4)
Evaluated across all 20 development tasks (`L` = Lexical v2 only, `G` = +Neighbors, `N` = +Notes, `GN` = +Both; [`eval/summaries/context-features.json`](eval/summaries/context-features.json)):

| Budget (`o200k_base`) | Arm | Source-File Hits | Labeled-Span Hits | Mean Span Recall | Delivered Neighbor Items | Delivered Note Items | Added / Displaced Labeled Lines vs. `L` |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **1,000** | `L` | **11 / 20** | **8 / 20** | **30.0%** | 0 | 0 | 0 / 0 |
| **1,000** | `G` | 9 / 20 | 6 / 20 | 22.5% | 2 | 0 | 0 / 14 |
| **1,000** | `N` | 9 / 20 | 6 / 20 | 22.5% | 0 | 1 | 0 / 18 |
| **1,000** | `GN` | 9 / 20 | 6 / 20 | 22.5% | 0 | 0 | 0 / 24 |
| **2,000** | `L` | **14 / 20** | **11 / 20** | **45.0%** | 0 | 0 | 0 / 0 |
| **2,000** | `G` | 12 / 20 | 9 / 20 | 35.0% | 24 | 0 | 0 / 28 |
| **2,000** | `N` | **14 / 20** | 10 / 20 | 40.0% | 0 | 17 | 0 / 12 |
| **2,000** | `GN` | 11 / 20 | 8 / 20 | 30.0% | 13 | 17 | 0 / 40 |
| **4,000** | `L` | **16 / 20** | **11 / 20** | **45.0%** | 0 | 0 | 0 / 0 |
| **4,000** | `G` | **16 / 20** | **11 / 20** | **45.0%** | 33 | 0 | 0 / 0 |
| **4,000** | `N` | 15 / 20 | **11 / 20** | 42.5% | 0 | 20 | 0 / 9 |
| **4,000** | `GN` | 13 / 20 | 9 / 20 | 32.5% | 33 | 20 | 0 / 37 |

### 2.4 Direct-Import Boundary Checker Study (Phase 6)
Registered 16-case patch study ([`eval/manifests/checker-cases.json`](eval/manifests/checker-cases.json), [`eval/summaries/checker.json`](eval/summaries/checker.json)):
- **Matched expected exit codes & counts:** `16 / 16` (`100%` on synthetic benchmark).
- **Complete comparisons (`12 / 16`):** `6` true positives (`0` false negatives) covering direct runtime imports, TS path aliases, `require()`, dynamic `import()`, out-of-band shell writes, and candidate `.ctx/config.json` / `.gitignore` bypass attempts; `6` true negatives (`0` false positives) covering `import type`, service-layer indirection (`UI -> service -> DB`), declared external packages, and line-shifted existing debt.
- **Incomplete comparisons (`4 / 16`):** Missing local targets, dynamic variable imports, syntax errors, and missing baseline commits all exited `2` (`incomplete`) without false-clean verdicts.

### 2.5 Operational Scaling Profile (Phase 7)
Measured fresh CLI child processes across synthetic repositories of `106`, `506`, and `1,006` files ([`eval/summaries/operational.json`](eval/summaries/operational.json)):

| Operation | Target Budget | 106 Files | 506 Files | 1,006 Files | Target Met? |
| :--- | ---: | ---: | ---: | ---: | :--- |
| **Cold `index` wall time** | `<= 30,000 ms` | 1,568 ms | 1,733 ms | 2,424 ms | **Yes** (all scales) |
| **Warm `context` (estimate) `p95`** | `<= 2,000 ms` | 1,387 ms | 1,599 ms | 1,982 ms | **Yes** (all scales) |
| **Warm `context` (`o200k_base`) `p95`** | `<= 2,000 ms` | 1,964 ms | 2,078 ms | 2,488 ms | **106 only** (506/1,006 miss due to ~450 ms per-process `js-tiktoken` load + double worktree hash) |
| **Warm `expand` `p95`** | `<= 2,000 ms` | 916 ms | 964 ms | 1,089 ms | **Yes** (all scales) |
| **Ordinary `check` `p95`** | `<= 5,000 ms` | 2,216 ms | 2,499 ms | 2,996 ms | **Yes** (all scales) |

---

## 3. Post-Study Maintenance Fixes (`v0.1.1`)

During the post-study technical audit, four concrete defects in the `v0.1.0` frozen codebase were identified, fixed, and covered by regression tests in `v0.1.1`:

1. **Async Test-Fixture Initialization Race ([`tests/features.test.mjs`](tests/features.test.mjs))**
   - `fixture()` previously invoked `initialize(root)` without `await`, causing intermittent race conditions against `.ctx/config.json` and `.gitignore` creation during parallel test runs. Fixed with `await initialize(root);`.
2. **Snapshot Case-Sensitivity Consistency in Note Selection ([`src/retrieval/index.ts`](src/retrieval/index.ts))**
   - `context()` previously inferred `caseSensitive` from `process.platform` when calling `readNotes()`, whereas `expand()` used `observed.case_sensitive`. Unified on `observed.case_sensitive`.
3. **Post-Ignore `missing_scope` Detection in Immutable Commits ([`src/workspace/git.ts`](src/workspace/git.ts))**
   - `captureCommit()` previously checked whether configured `roots` existed in `regular` (before `.gitignore` and `exclude` filtering) rather than `selected` (after ignore rules). Moved the check to inspect `selected` so worktree and commit capture behave identically.
4. **Defensive `package.json` Dependency Map Guard ([`src/analyzer/index.ts`](src/analyzer/index.ts))**
   - `resolveImports()` previously spread `pkg?.data.dependencies` directly into `Object.assign` and looked up `allDependencies[rootName]`. Added plain-object validation (`depMap`) and `Object.hasOwn` so malformed/array `dependencies` fields cannot match `Array.prototype` or `Object.prototype` properties.

The original `v0.1.0` freeze manifest is preserved as [`eval/manifests/evaluation-freeze-v1.json`](eval/manifests/evaluation-freeze-v1.json), and [`eval/manifests/evaluation-freeze.json`](eval/manifests/evaluation-freeze.json) pins the updated 92-file hashes for `v0.1.1`.

---

## 4. Agent Evaluation Setup: Gemini Flash 3.8 (`low` reasoning)

### Why the Active Harness Targets `gemini-flash-3.8` (`low` reasoning)
Earlier exploratory runs using Codex-hosted models (`gpt-6.1-sol` and `gpt-5.6-terra`) were stopped by external provider model retirement and account usage limits before a statistically valid held-out A/B sample could be completed. Those historical summaries remain untouched in `eval/summaries/` as an honest audit trail, and **no claim of agent task-success improvement, speedup, or net host token reduction is made.**

All active evaluation configurations, scripts, and plan tests now target **`gemini-flash-3.8`** with **`low` reasoning effort** via direct Gemini API calls:
- **Policy Manifest:** [`eval/manifests/phase8-gemini-policy.json`](eval/manifests/phase8-gemini-policy.json) (`stratum: "gemini_flash_38_low_pilot"`, `model: "gemini-flash-3.8"`, `reasoning_effort: "low"`, 12 paired A/B assignments across 6 held-out tasks).
- **Plan & Direct API Runner:** [`eval/scripts/phase8-gemini-plan.mjs`](eval/scripts/phase8-gemini-plan.mjs) and [`eval/scripts/phase8-gemini-run.mjs`](eval/scripts/phase8-gemini-run.mjs).
  - Condition `A` exposes isolated workspace file tools (`read_workspace_file`, `write_workspace_file`).
  - Condition `B` adds `ctx_context` and `ctx_expand` backed directly by the local `ctx-gate` engine.
  - Defaults to safe, zero-cost **preview mode** (`model_calls: 0`) unless `--execute` and `GEMINI_API_KEY` are explicitly supplied.

---

## 5. Reproducible Verification Commands

With **Node 24 LTS** (`v24.x`) and **Git** installed:

```powershell
# 1. Full code style, TypeScript typecheck, build, and 86 unit/integration/eval tests
npm run check

# 2. Verify the 92-file SHA-256 source/evaluation freeze
node eval/scripts/verify-freeze.mjs

# 3. Run the deterministic offline synthetic demo (0 model calls)
node examples/demo.mjs

# 4. Run the clean-copy offline reproduction pipeline (0 model calls)
node eval/scripts/portfolio-reproduce.mjs

# 5. Preview the Gemini Flash 3.8 (low reasoning) evaluation plan (0 model calls)
node eval/scripts/phase8-gemini-run.mjs
```

---

## 6. Resume & Interview Showcase Highlights

- **Problem-First Framing:** Built a local-first TypeScript/Node 24 context-management SDK and MCP server (`ctx-gate`) using built-in `node:sqlite` (WAL + FTS5), TypeScript AST analysis, and `js-tiktoken` to give AI coding agents token-bounded, hash-verified repository context and syntactic import-boundary checks.
- **Evidence-Driven Refinement:** Diagnosed why initial lexical retrieval missed branches inside long functions and suffered `4.03 s` warm `p95` tail latency; designed intra-symbol window focusing and a 40-candidate packing cap (`v2`) that improved development labeled-span recall from `36.25%` to `45.00%`, reduced warm `p95` latency from `3.96 s` to `1.86 s`, and cut full-envelope tokenizer calls by `73%` (`406.85` to `108.80`).
- **Disciplined Negative Findings:** Conducted a 240-brief ablation study across 1,000/2,000/4,000-token budgets showing that 1-hop import neighbors and reviewed notes displaced `9–40` labeled source lines without adding new relevant lines—justifying keeping both features off by default instead of shipping unmeasured complexity.
- **Security-Conscious Boundary Checking:** Implemented `ctxgate check` to compare baseline and target Git trees against trusted baseline `deny_import` rules (`16/16` synthetic patch study cases), preventing candidate edits to `.ctx/config.json` or `.gitignore` from bypassing architectural boundaries.
