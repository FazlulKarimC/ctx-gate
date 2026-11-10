import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, posix } from "node:path";
import { Minimatch } from "minimatch";
import ignore from "ignore";
import { z } from "zod";
import {
  ConfigSchema,
  CheckResultSchema,
  CheckCursorSchema,
  type Config,
  type Coverage,
  type CheckFinding,
  type CheckResult,
} from "../contracts/index.js";
import {
  captureWorktree,
  MemoryView,
  digest,
  type ScanResult,
  type ScanLimits,
  type CaptureOptions,
} from "../workspace/snapshot.js";
import { captureCommit } from "../workspace/git.js";
import {
  buildAnalysisContext,
  parseSource,
  resolveImports,
  ANALYZER_VERSION,
} from "../analyzer/index.js";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
export const CheckOptionsSchema = z
  .object({
    base: z.union([sha, z.literal("empty")]).optional(),
    target: z.union([sha, z.literal("worktree")]).optional(),
    policy_ref: sha.optional(),
    policy: ConfigSchema.optional(),
    policy_file: z.string().min(1).max(4096).optional(),
    mode: z.enum(["advisory", "required"]).default("advisory"),
    page_size: z.number().int().min(1).max(100).default(20),
    max_bytes: z.number().int().min(2048).max(16384).default(16384),
    cursor: CheckCursorSchema.optional(),
    scan_limits: z
      .object({
        max_files: z.number().int().positive().optional(),
        max_bytes: z.number().int().positive().optional(),
        max_file_bytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (options) => !(options.policy && options.policy_file),
    "Choose one explicit policy input",
  );
export type CheckOptions = z.input<typeof CheckOptionsSchema>;
const textCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const matcher = (pattern: string) =>
  new Minimatch(pattern === "." ? "**" : pattern, {
    dot: true,
    nobrace: true,
    noext: true,
    nonegate: true,
  });
function git(root: string, args: string[]) {
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).trim();
}
const safeReason = (
  code: string,
  message: string,
  path?: string,
): Coverage["reasons"][number] => ({
  code,
  message: message.slice(0, 220),
  ...(path &&
  !path.startsWith("../") &&
  !/^[a-z]:/i.test(path) &&
  path.length <= 256
    ? { path }
    : {}),
});
type PolicyScan = NonNullable<CaptureOptions["enforcement"]>;
function excluded(
  path: string,
  policy: Config,
  ignoreFiles: PolicyScan["ignore_files"],
) {
  const explicit = ignore().add(policy.exclude),
    rules = ignoreFiles
      .map((file) => ({
        base: posix.dirname(file.path) === "." ? "" : posix.dirname(file.path),
        test: ignore().add(file.text),
      }))
      .sort((a, b) => a.base.length - b.base.length);
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const candidate =
      parts.slice(0, index + 1).join("/") +
      (index < parts.length - 1 ? "/" : "");
    let ignored = false;
    for (const rule of rules)
      if (!rule.base || candidate.startsWith(rule.base + "/")) {
        const local = rule.base
          ? candidate.slice(rule.base.length + 1)
          : candidate;
        if (!local) continue;
        const result = rule.test.test(local);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
    if (ignored || explicit.ignores(candidate)) return true;
  }
  return false;
}
function analyze(
  scan: ScanResult,
  policy: Config,
  ignoreFiles: PolicyScan["ignore_files"],
  side: "baseline" | "target",
) {
  const roots = policy.roots.map(
    (root) => posix.normalize(root).replace(/\/$/, "") || ".",
  );
  const rules = policy.rules.map((rule) => ({
    rule,
    from: matcher(rule.from),
    to: matcher(rule.to),
  }));
  const inScope = (path: string) =>
    roots.some(
      (root) => root === "." || path === root || path.startsWith(root + "/"),
    );
  const relevant = (path: string) =>
    inScope(path) && rules.some(({ from }) => from.match(path));
  const potential = (path: string) =>
    roots.some(
      (root) =>
        root === "." ||
        path === root ||
        path.startsWith(root + "/") ||
        root.startsWith(path + "/"),
    ) && rules.some(({ from }) => from.match(path, true));
  const reasons: Coverage["reasons"] = [];
  const add = (code: string, message: string, path?: string) =>
    reasons.push(safeReason(side + ":" + code, message, path));
  // Omitted resolver metadata or local package inventory can change ownership,
  // even outside rule-source roots. Never turn a capture limit into a clean pass.
  for (const reason of scan.coverage.reasons)
    add(reason.code, reason.message, reason.path);
  for (const exclusion of scan.exclusions) {
    if (
      exclusion.path === ".git" ||
      exclusion.path === ".ctx/cache" ||
      excluded(exclusion.path, policy, ignoreFiles)
    )
      continue;
    if (
      potential(exclusion.path) &&
      (exclusion.reason !== "built_in_exclusion" ||
        !posix.extname(exclusion.path) ||
        /\.[cm]?[jt]sx?$/i.test(exclusion.path))
    )
      add(
        "uninspected_scope",
        "Policy-covered path was not inspected: " + exclusion.reason,
        exclusion.path,
      );
  }
  const context = buildAnalysisContext(scan.view),
    sources = [...scan.view.files.values()].filter(
      (file) => file.kind === "source" && relevant(file.path),
    );
  for (const reason of context.reasons) {
    const dir = reason.path ? posix.dirname(reason.path) : ".";
    if (
      sources.some((file) => dir === "." || file.path.startsWith(dir + "/")) ||
      !reason.path
    )
      add(reason.code, reason.message, reason.path);
  }
  const findings = new Map<string, CheckFinding>();
  let edges = 0;
  for (const file of sources) {
    const syntax = parseSource(file, context);
    for (const error of syntax.errors)
      add("syntax_or_project_error", error, file.path);
    for (const edge of resolveImports(file, syntax, context)) {
      if (++edges > 25000) {
        add("edge_limit", "Check stopped after 25000 rule-source imports");
        break;
      }
      const applicable = rules.filter(
        ({ rule, from }) =>
          from.match(file.path) && rule.edge_kinds.includes(edge.kind),
      );
      if (!applicable.length) continue;
      if (
        !["resolved_local", "external_declared", "builtin"].includes(
          edge.resolution,
        )
      ) {
        add(edge.resolution, edge.detail + " at line " + edge.line, file.path);
        continue;
      }
      if (edge.resolution !== "resolved_local" || !edge.target) continue;
      for (const { rule, to } of applicable)
        if (to.match(edge.target)) {
          const id = digest(
            JSON.stringify([
              rule.id,
              file.path,
              edge.target,
              edge.kind,
              edge.specifier,
            ]),
          );
          if (findings.has(id)) continue;
          const line = file.text.split("\n")[edge.line - 1] ?? "";
          findings.set(id, {
            id,
            rule_id: rule.id,
            source: file.path,
            target: edge.target,
            edge_kind: edge.kind,
            specifier: edge.specifier!,
            explanation: rule.explanation,
            line: edge.line,
            classification: "unclassified",
            observed_in: side,
            reference: {
              schema_version: 1,
              root_id: digest(scan.view.root),
              view_id: scan.view.id,
              path: file.path,
              content_hash: file.hash,
              start_line: edge.line,
              end_line: edge.line,
            },
            excerpt: line.slice(0, 512),
            excerpt_truncated: line.length > 512,
          });
        }
    }
    if (edges > 25000) break;
  }
  const unique = [
    ...new Map(
      reasons.map((reason) => [JSON.stringify(reason), reason]),
    ).values(),
  ];
  return {
    findings,
    reasons: unique,
    checked_files: sources.length,
    edges,
    complete: unique.length === 0,
  };
}
export const renderCheck = (result: CheckResult) =>
  JSON.stringify(result) + "\n";
function size(result: CheckResult) {
  for (let n = 0; n < 8; n++) {
    const bytes = Buffer.byteLength(renderCheck(result));
    if (bytes === result.response_bytes) return bytes;
    result.response_bytes = bytes;
  }
  throw Error("Check response accounting did not converge");
}

/** Read-only complete-view comparison. Never publishes historical facts into SQLite. */
export function check(root: string, input: CheckOptions = {}): CheckResult {
  const options = CheckOptionsSchema.parse(input),
    canonical = realpathSync(root),
    limit = options.max_bytes;
  const result: CheckResult = {
    schema_version: 1,
    operation: "check",
    root_id: digest(canonical),
    baseline_id: options.base ?? "HEAD",
    target_id: options.target ?? "worktree",
    policy_hash: digest("unavailable"),
    policy_source: "unavailable",
    policy_revision: null,
    candidate_policy_changed: false,
    mode: options.mode,
    exit_code: 2,
    rule_count: 0,
    counts: { new: 0, existing: 0, removed: 0, unclassified: 0 },
    coverage: {
      complete: false,
      checked_files: 0,
      skipped_files: 0,
      reasons: [],
    },
    coverage_reason_count: 0,
    diagnostics: [],
    status: "incomplete",
    findings: [],
    manifest_hash: digest("unavailable"),
    page: { offset: 0, returned: 0, total: 0, truncated: false },
    response_bytes: 0,
  };
  const reasons: Coverage["reasons"] = [];
  let all: CheckFinding[] = [];
  try {
    const base =
      options.base ??
      git(canonical, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ]);
    const needsGit =
      base !== "empty" ||
      (options.target && options.target !== "worktree") ||
      options.policy_ref;
    if (
      needsGit &&
      realpathSync(git(canonical, ["rev-parse", "--show-toplevel"])) !==
        canonical
    )
      throw Error("Check root must be the Git top-level directory");
    result.baseline_id = base;
    const policyRef =
      options.policy_ref ?? (base !== "empty" ? base : undefined);
    let metadata: ScanResult | undefined;
    if (policyRef)
      metadata = captureCommit(
        canonical,
        policyRef,
        options.scan_limits as ScanLimits,
        { metadata_only: true },
      );
    if (
      metadata &&
      (!metadata.coverage.complete ||
        metadata.exclusions.some(
          (item) =>
            item.path === ".ctx/config.json" ||
            posix.basename(item.path) === ".gitignore",
        ))
    )
      throw Error("Trusted policy/ignore metadata is unreadable or excluded");
    let policy: Config;
    if (options.policy_file) {
      const path = resolve(canonical, options.policy_file);
      if (statSync(path).size > 1024 * 1024)
        throw Error("Trusted policy file exceeds 1 MiB");
      policy = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      result.policy_source = "explicit_config";
    } else if (options.policy) {
      policy = ConfigSchema.parse(options.policy);
      result.policy_source = "explicit_config";
    } else if (metadata) {
      policy = metadata.config;
      result.policy_source = "commit";
    } else
      throw Error("An empty baseline requires explicit trusted policy input");
    result.policy_revision = policyRef ?? null;
    result.policy_hash = digest(JSON.stringify(policy));
    result.rule_count = policy.rules.length;
    if (policy.roots.some((path) => /[*?{}[\]]/.test(path)))
      throw Error("Trusted roots must be literal directories");
    const ignoreFiles = [...(metadata?.view.files.values() ?? [])]
      .filter((file) => posix.basename(file.path) === ".gitignore")
      .map((file) => ({ path: file.path, text: file.text }));
    const discovery: CaptureOptions = {
      enforcement: {
        config: { ...policy, roots: ["."] },
        ignore_files: ignoreFiles,
      },
    };
    const empty: ScanResult = {
      view: new MemoryView(canonical, [], "commit", true),
      config: policy,
      coverage: {
        complete: true,
        checked_files: 0,
        skipped_files: 0,
        reasons: [],
      },
      exclusions: [],
      git: null,
      scan_ms: 0,
      bytes: 0,
    };
    const baseline =
      base === "empty"
        ? empty
        : captureCommit(
            canonical,
            base,
            options.scan_limits as ScanLimits,
            discovery,
          );
    const target =
      options.target && options.target !== "worktree"
        ? captureCommit(
            canonical,
            options.target,
            options.scan_limits as ScanLimits,
            discovery,
          )
        : captureWorktree(
            canonical,
            options.scan_limits as ScanLimits,
            discovery,
          );
    result.target_id =
      options.target && options.target !== "worktree"
        ? options.target
        : "worktree:" + target.view.id;
    result.candidate_policy_changed =
      target.view.readFile(".ctx/config.json") !==
      metadata?.view.readFile(".ctx/config.json");
    if (result.candidate_policy_changed)
      result.diagnostics.push(
        "Candidate policy changes are not applied; review them separately",
      );
    result.diagnostics.push(
      "Discovery uses trusted roots/exclusions and trusted Git ignores; candidate/global/info ignores do not narrow enforcement",
    );
    for (const scope of policy.roots) {
      const normalized = posix.normalize(scope);
      const origin = base === "empty" ? target : baseline;
      if (normalized !== "." && !origin.view.directoryExists(normalized))
        reasons.push(
          safeReason(
            "missing_trusted_scope",
            "Trusted root is absent or unsupported in its original view",
            scope,
          ),
        );
    }
    const before = analyze(baseline, policy, ignoreFiles, "baseline"),
      after = analyze(target, policy, ignoreFiles, "target");
    reasons.push(...before.reasons, ...after.reasons);
    result.coverage.checked_files = before.checked_files + after.checked_files;
    for (const [id, finding] of after.findings) {
      const old = before.findings.get(id);
      all.push({
        ...finding,
        classification: old
          ? "existing"
          : before.complete
            ? "new"
            : "unclassified",
        ...(old ? { baseline_line: old.line } : {}),
      });
    }
    for (const [id, finding] of before.findings)
      if (!after.findings.has(id))
        all.push({
          ...finding,
          classification: after.complete ? "removed" : "unclassified",
          baseline_line: finding.line,
        });
    if (!options.target || options.target === "worktree") {
      const verified = captureWorktree(
        canonical,
        options.scan_limits as ScanLimits,
        discovery,
      );
      if (
        verified.view.id !== target.view.id ||
        JSON.stringify(verified.coverage) !== JSON.stringify(target.coverage)
      )
        reasons.push(
          safeReason(
            "target_changed",
            "Worktree changed while checking; re-run the complete check",
          ),
        );
    }
    result.manifest_hash = digest(
      JSON.stringify({
        root: canonical,
        baseline: base,
        before: baseline.view.id,
        target: result.target_id,
        after: target.view.id,
        policy: result.policy_hash,
        ignores: ignoreFiles,
        analyzer: ANALYZER_VERSION,
        limits: options.scan_limits ?? {},
        mode: options.mode,
        page_size: options.page_size,
        max_bytes: limit,
      }),
    );
  } catch (error) {
    reasons.push(
      safeReason(
        "check_unavailable",
        error instanceof Error
          ? error.message
          : "Unable to establish check coverage",
      ),
    );
  }
  all.sort(
    (a, b) =>
      textCompare(a.classification, b.classification) ||
      textCompare(a.rule_id, b.rule_id) ||
      textCompare(a.source, b.source) ||
      textCompare(a.target, b.target) ||
      textCompare(a.id, b.id),
  );
  for (const finding of all) result.counts[finding.classification]++;
  result.coverage_reason_count = reasons.length;
  result.coverage.complete = reasons.length === 0;
  result.coverage.skipped_files = new Set(
    reasons.filter((reason) => reason.path).map((reason) => reason.path),
  ).size;
  result.coverage.reasons = reasons.slice(0, 5);
  if (reasons.length > 5)
    result.diagnostics.push(
      "Coverage diagnostics capped at five; recheck after resolving reported issues",
    );
  result.status = reasons.length
    ? "incomplete"
    : result.rule_count
      ? "complete"
      : "no_rules";
  result.exit_code =
    result.status === "incomplete"
      ? 2
      : result.status === "no_rules"
        ? options.mode === "required"
          ? 2
          : 0
        : options.mode === "required" && result.counts.new > 0
          ? 1
          : 0;
  result.page.total = all.length;
  const offset = options.cursor?.offset ?? 0;
  if (
    options.cursor &&
    (options.cursor.fingerprint !== result.manifest_hash || offset > all.length)
  ) {
    result.status = "stale_cursor";
    result.exit_code = 2;
    result.diagnostics.push(
      "Report cursor does not match this view/policy/options; restart without the cursor",
    );
  } else {
    result.page.offset = offset;
    for (const finding of all.slice(offset, offset + options.page_size)) {
      result.findings.push(finding);
      result.page.returned = result.findings.length;
      result.page.truncated = offset + result.findings.length < all.length;
      if (result.page.truncated)
        result.next_cursor = {
          schema_version: 1,
          fingerprint: result.manifest_hash,
          offset: offset + result.findings.length,
        };
      else delete result.next_cursor;
      if (size(result) > limit) {
        result.findings.pop();
        break;
      }
    }
    result.page.returned = result.findings.length;
    result.page.truncated = offset + result.findings.length < all.length;
    if (result.page.truncated && result.findings.length)
      result.next_cursor = {
        schema_version: 1,
        fingerprint: result.manifest_hash,
        offset: offset + result.findings.length,
      };
    else delete result.next_cursor;
    if (all.length > offset && !result.findings.length) {
      result.status = "report_too_small";
      result.exit_code = 2;
      result.diagnostics.push(
        "A finding cannot fit this byte allowance; increase max_bytes or shorten oversized policy/source data",
      );
    }
  }
  if (size(result) > limit)
    throw Error("Check byte allowance is too small for required metadata");
  return CheckResultSchema.parse(result);
}
