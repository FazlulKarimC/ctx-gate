# Evaluation protocol v1

Registered: 2026-10-26. Status: corpus qualification and baseline instrumentation in progress. No ctx-gate performance result exists yet.

## Objective and comparisons

Evaluate whether a sufficient local context engine helps a coding agent complete real repository tasks correctly, and identify failures in retrieval, freshness, integration, and enforcement. Primary outcome is independently assessed task correctness; total usage, elapsed time, review effort, and evidence discovery are secondary outcomes.

Offline comparisons: R0 fixed text search, R1 indexed lexical search, R2 R1 plus one-hop imports, R3 the selected retrieval variant plus reviewed notes. Use equal rendered-evidence allowances, with a 2,000-token default and development-only 1,000/4,000 sweeps. Distinguish exact tokenizer counts from estimates.

Agent comparisons: A is the unmodified host with ordinary repository instructions; B adds context/expansion and a short usage instruction, with the checker disabled. A/B measures the practical integration package, not an isolated algorithm. Evaluate checking separately before optionally studying condition C (B plus feedback).

## Corpus registration and eligibility

Repositories: micromatch/picomatch (library), typicode/json-server (API service), fastify/fastify (modular HTTP framework). Selection reflects different structures, not a representative sample of all repositories. Pin observed repository heads and each task's pre-fix/fix commits in the manifest. Preserve upstream licenses.

Use historical non-merge runtime fixes whose parent is available, whose changed source fits supported JS/TS scope, and whose behavior can be independently assessed. Exclude dependency bumps, documentation-only changes, tests-only changes, release mechanics, and security-sensitive tasks requiring exploitation. Prefer a test change with a runtime source change. Record exclusions before knowing agent outcomes. Include all qualifying selected tasks even when difficult; replacements require a setup/eligibility reason, never a low success rate.

Target: 20 development tasks and 18 holdout tasks, with six holdout tasks per repository. Register task IDs and pre-fix revisions before tuning. Balance exact-symbol, vague-symptom, and cross-file requests where qualified examples exist. Category balance is a qualification requirement, not a license to label a single-file patch cross-file. Record reuse/no-helper as independent labels. Freeze the qualified manifest before retrieval tuning; candidate registration is not final qualification.

Fully label the first five development tasks before their baseline. Finish remaining development labels before offline comparisons; finish holdout rubrics before any holdout runs. Review holdout labels without using treatment outcomes. Public historical tasks may already be known to models; report contamination as a limitation rather than claiming a blind novel benchmark.

## Agent-visible state and assessment isolation

Export only the pre-fix tree into each fresh task workspace. Do not expose Git history containing the fix, task/label manifests, upstream solution tests, other run outputs, or this project's notes to the tested agent. Preserve instructions present in the pre-fix tree. The harness keeps fix commits and hidden assessments outside the task workspace; directory isolation is not a security sandbox, so record the actual host filesystem restrictions as well.

Assessment combines existing regression tests, a focused behavioral regression test, and review of unnecessary changes. Demonstrate that each hidden regression fails on the pre-fix tree and passes on the known fixed tree before treating it as ground truth. Do not assume a commit title or a changed filename proves a behavioral bug. Do not execute upstream lifecycle scripts merely to inspect source; review and record dependency setup separately.

Notes may be authored later only from pre-fix evidence with recorded provenance. No answer-revealing future rationale may enter treatment context. Assessment tests remain separate until the agent has completed its attempt.

## Run controls

Record exact host executable/version, model/version, reasoning settings, platform/runtime, repository revision, task prompt, tool permissions, memory settings, available integrations, seed, and dependency setup. Use the same controls for A and B. Disable or isolate cross-run memory using verified supported settings; if not possible, label the resulting run infrastructure-invalid for a causal comparison.

Use fresh independent workspaces/sessions. Alternate paired A/B order using fixed seed `ctxgate-v1-20261026`. Repetitions are nested within tasks, not independent tasks. Changing model or instrumentation midway creates a separately reported block.

Before broad evaluation, target valid retrieval evidence before the first substantive edit on at least 80% of eligible development treatment runs. Report attempts and tool errors separately. Tune integration on development tasks only, for one bounded iteration; low adoption is a result, not a reason to discard runs.

The primary result includes ignored-tool runs. Tool-invoked subgroup comparisons are descriptive and potentially selection-biased even when paired with the same baseline tasks. They are not a replacement causal estimate.

## Initial execution budget

Phase-0 host-only baseline: at most five task attempts, sequentially, with a 300-second wall-clock limit per task and one 30-second infrastructure preflight. Stop after the first persistent infrastructure/authentication failure; do not spend five runs repeating it. Never switch models to work around an availability error without recording a protocol change.

No new paid API account, API key, or credit purchase is configured by the harness. Use existing authorized host access only. Billing price/cost remains `unavailable` unless the host exposes trustworthy pricing and usage. An input-token count is not a monetary cost estimate. The initial hard cost controls are run count and wall clock; record any known account or provider limit before expanding.

### 2026-10-26 infrastructure recovery and retry block

The original five attempts were infrastructure-invalid and consumed the original allowance. A successful real filesystem probe at `2026-10-26T09:54:28.197Z` establishes capability recovery (CLI `0.164.0-alpha.11.1`, Node `v24.22.1`). Register **one additional block of at most five host-only attempts**, the same initial tasks, sequentially, 300 seconds each. Stop on the first infrastructure failure. Preserve all old attempts; do not count the recovery probe as task performance. No further automatic retry block is authorized by this record.

The harness now uses `--no-daemon` and retains the existing user configuration while explicitly requesting `workspace-write`. The earlier `--ignore-user-config` discarded the saved Windows sandbox configuration; removing it restored capability without changing security settings. Requested user model/reasoning at recovery: `gpt-6.1-sol` / `high`; exact resolved model remains unavailable unless emitted by the host. Memory/integration isolation is still unverified. This retry block is an **instrumentation baseline**, suitable for inspecting task execution and assessment, not a controlled causal A/B comparison. Controlled comparisons remain gated on verified isolation and matching profiles.

Recovery block consumed: all five attempts completed in run `2026-10-26T10-01-40-821Z`. Five focused regressions passed; supplemental tests/source review and limitations are recorded in `docs/experiments/recovered-baseline.md`. No additional task attempts remain in either initial allowance.

Phase 5 pilot: up to 20 runs. Final frozen pilot: up to 72 runs (18 tasks × 2 conditions × 2 repetitions). These are later budgets, not permission for the runner to launch them automatically. Expansion requires a recorded readiness decision and remaining budget. If a time/run ceiling is hit, analyze what exists and report the smaller sample.

## Recording and exclusions

Store an immutable run manifest plus JSONL events, stderr, exit status, timing, output patch, and post-run assessment outside agent inputs. Missing usage fields are `null`/unavailable, never zero. Distinguish final cumulative usage from per-turn/event fields to avoid double counting. Keep cache usage a subset when the host reports it that way.

Run outcomes: `not_started`, `infrastructure_invalid`, `product_failure`, `task_failure`, `task_success`, or `unassessed`. A host startup/auth/config failure before task execution is infrastructure-invalid. A bad patch, product crash, task timeout, or ignored tool after valid execution remains an eligible outcome. Preserve every attempt and predeclare retry reasons; do not delete losing results.

Report all-run correctness and cost/time, successful-run cost/time separately, task-category breakdowns, effect sizes, variation, and sample size. Show raw counts. Small-pilot success parity is not equivalence. Report coverage separately from checker accuracy so unknown imports cannot inflate apparent correctness.

## Sources and instrumentation scope

The local installed CLI and its own help determine accepted flags; current official documentation is cross-checked rather than assumed to match this alpha build. Non-interactive JSONL can expose final usage and tool events, but actual available fields must be observed. [Official non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

No claim about ctx-gate benefit is made until qualifying task attempts and independent assessments have run.

## Phase 5 development pilot readiness decision — 2026-10-26

The user's request to complete Phase 5 authorizes its bounded implementation/pilot. Policy is registered in `eval/manifests/phase5-policy.json`; exact twenty-assignment order and source hashes are in `phase5-pilot.json` before the first task. Only the five independently behaviorally verified Picomatch development tasks qualify; this does not open the broad agent-pool or holdout gates. Existing account access, requested `gpt-6.1-sol` / `high`, two repetitions, sequential execution, at most twenty five-minute task attempts. No additional initial-baseline retry allowance is created.

The local MCP adapter passes real stdio negotiation/input/budget/reference tests. Capability reservation one failed during configuration loading before a model turn; reservation two returned real context evidence and completed a filesystem roundtrip. Both reservations are preserved and consumed; the successful probe is infrastructure only, not a task outcome. Its usage is excluded from pilot task metrics and recorded separately. No further automatic model-capability attempt is authorized.

Effective configuration and sandbox tests verify disabled memory generation/injection and unrelated integrations, workspace writes, protected project-folder denial and external TCP denial with a reachable unsandboxed control. Windows requires root read access and still permits loopback. Trial roots are outside SuperContext; explicit denials cover this project (assessments/history/solutions), personal Codex state, peers and private trial state/logs. A fresh static refresh can link the preserved successful model-capability evidence for unchanged host/model/MCP. Per-assignment checks revalidate model/memory/integrations and project/personal-state/peer denial before reserving a task slot. These are protections for known evaluation data, not a claim about every user file or malicious servers.

Both arms receive identical pre-fix exports and managed `.ctx` initialization; B adds only the fixed tools/instruction package. The original selected-test files are restored in protected assessment copies before patched production files are tested, so agent test edits cannot quietly remove assessment cases. Source changes, raw event timing, returned evidence, complete available usage and patch-review decisions stay recorded. Cost, unexposed compaction and backend model revision remain unavailable. Retain non-use, errors, timeouts and task losses; stop on infrastructure failure. Final task-success labels require patch review, and tool-invoked comparisons remain descriptive. Do not retune source/instructions against pilot outcomes within this block.

## Phase 3 diagnostic retrieval study (registered before measurement)

Use all 20 existing development candidate IDs to measure pre-fix source discovery, with manually reviewed pre-fix source spans and issue-level prompts fixed before queries run. This is a **diagnostic relevance set**, not a newly qualified agent-task benchmark: remaining behavioral/category/fix-family qualification for agent trials is unchanged. In particular, a candidate that turns out to be a feature or contains formatting noise can still expose a retrieval failure; its presence does not establish eligibility for the frozen agent pilot. Do not replace candidates based on retrieval results. Holdout tasks are not queried.

Freeze the untuned starter in `eval/manifests/lexical-v1.json` before measurements. Compare R0 fixed case-insensitive literal OR search in path/line order with R1 tiered anchors/FTS5. Both use the same normalized terms, eligible file policy, line excerpts, per-file limits, full-envelope packing, 2,000-token allowance, and explicitly selected `o200k_base` encoding. This isolates a fixed candidate-selection comparison; it is not a model of an interactive agent refining ripgrep queries. Run one cold indexed response and three warm responses per task, plus one live-search response. Record cold/warm timing separately. No model calls, upstream execution or dependency installation are required.

Report any labeled-file hit, any labeled-source-span overlap, mean per-task labeled-span recall, union coverage of labeled source lines, and labeled useful-file precision. Labels are incomplete and spans may include surrounding context; these are diagnostics, not exhaustive relevance truth or patch-success metrics. Report source tests separately when available. Add nonce no-match controls separately; do not call them realistic no-local-helper tasks. Preserve every candidate result and inspect both wins and misses without changing this version's weights after seeing the results.

## Phase 4.0: qualified metadata pool and one lexical refinement

The source/category/fix-family gate is frozen in `eval/manifests/agent-pool.json` after the policy in `qualification-policy.json` and source/test review in `eval/labels/candidate-review.json`. Eight originals are excluded from the future agent pool for feature/security scope or development-family exposure, with eight recorded replacements. The original 20-candidate diagnostic set and v1 results remain unchanged. Metadata qualification is not behavioral qualification: only five active tasks have verified regressions; setup, detailed holdout rubrics and enforced host isolation remain later gates. Within-split family clusters and legacy repository versions must be reported.

Register one combined lexical proposal before queries: body-window selection within matched symbol spans, retaining a separate entry excerpt when needed, and at most 40 packing candidates with duplicate shrinking attempts skipped. Keep normalization, BM25 weights, the 200-candidate pool, six-item/two-per-file bounds, budget and encoding fixed. This compares the combined refinement, not the isolated causal effect of either change. `eval/manifests/lexical-v2-refinement.json` pins code and acceptance rules.

Use all original 20 diagnostic development cases, including the feature candidate; do not replace or omit a case based on v1 results. Use the retained identical workspaces. Require the v1 control to reproduce each original saved response byte-for-byte and its metrics exactly before measuring. Compare v1/v2 with three warm repetitions each, alternating order across tasks/repetitions. Instrument token-counter calls/time without changing returned counts. No model calls, upstream scripts or holdout queries. Verify every recorded response budget and excerpt provenance.

Prefer v2 only if aggregate any-span hits and mean labeled-span recall do not decline, sample warm p95 decreases, and no budget/provenance failure occurs. Report all case-level span/file losses even if aggregate criteria pass. File hits remain secondary because the useful-span gap motivated this experiment. Keep v1 explicitly selectable. Do not run a parameter grid or retune after these results; further changes require a separate registered comparison. These development observations do not establish agent success, universal speedup or statistical equivalence.

## Phase 7 freeze and Phase 8 readiness — 2026-10-27

The 18-case held-out source/behavior assessment amendment is in `manifests/holdout-readiness.json`; historical pool v2 remains unchanged. Two security-related cases were replaced under the existing exclusion policy before held-out retrieval/model outcomes. All 18 protected focused regressions fail before/pass after; neutral pre-existing behavior controls pass on both versions, with an additional version-qualified original Picomatch subset. This is not uniform full upstream lint/types/coverage testing or independent blinded human assessment. Recorded compatible runtime locks support reproducible setup on this Node/Windows environment, not an exact recreation of every historical dependency graph.

User authorization to continue and complete the next phase opens preparation of Phase 8. `manifests/phase8-policy.json` predeclares **one repetition, at most 36 task attempts**, before any held-out outcome; the optional second repetition is deferred for affordability after the development quota failure. One distinct 90-second capability model probe is allowed only after product/task freeze and static isolation pass. Neither the original five recovery attempts, twenty Phase 5 slots nor two old capability slots are replenished. Stop immediately on `host_failure.stop_batch`, including account limits after task progress; preserve the partial task outcome. No purchase, usage reset, model substitution or automatic retry block.

The phase-specific runner uses only ctx_context/ctx_expand through a host allowlist; checker feedback remains outside A/B. Product source/defaults/lockfile/contracts and assessment inputs are frozen by `manifests/evaluation-freeze.json`. Harness/request hashes are separately registered before execution. Fresh pre-fix exports, identical prepared dependencies, protected original assessments and source-only overlays prevent edited tests from replacing acceptance checks. Passing checks still requires patch review.

Current named-profile static sandbox commands time out before a model turn, while built-in workspace cleanup succeeds. Model execution remains gated; no capability probe/task slot is spent until that condition is resolved. Raw diagnostics are kept under `runs/phase8-readiness` and `runs/phase8-diagnostic`. Official non-interactive execution and permission syntax were checked against https://learn.chatgpt.com/docs/non-interactive-mode and https://learn.chatgpt.com/docs/permissions; installed CLI behavior remains authoritative for this alpha build.
