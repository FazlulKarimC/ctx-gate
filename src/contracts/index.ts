import { isAbsolute, win32 } from "node:path";
import { z } from "zod";

const projectPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !win32.isAbsolute(value) &&
      !/^[a-z]:/i.test(value) &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    "Use a repository-relative forward-slash path without parent traversal",
  );
export const RuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.literal("deny_import"),
    from: projectPath.refine(
      (value) => value.length <= 256 && !/[{}()!]/.test(value),
      "Use bounded basic globs",
    ),
    to: projectPath.refine(
      (value) => value.length <= 256 && !/[{}()!]/.test(value),
      "Use bounded basic globs",
    ),
    edge_kinds: z
      .array(z.enum(["runtime", "type_only"]))
      .min(1)
      .default(["runtime"]),
    explanation: z.string().min(1).max(1024),
  })
  .strict();
export const ConfigSchema = z
  .object({
    schema_version: z.literal(1),
    roots: z.array(projectPath).min(1).default(["."]),
    exclude: z.array(projectPath).default([]),
    budget_tokens: z.number().int().min(128).max(4000).default(2000),
    rules: z.array(RuleSchema).max(100).default([]),
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.rules.map((rule) => rule.id)).size === config.rules.length,
    "Rule IDs must be unique",
  );
export type Config = z.infer<typeof ConfigSchema>;
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({ schema_version: 1 });

export const CoverageSchema = z
  .object({
    complete: z.boolean(),
    checked_files: z.number().int().nonnegative(),
    skipped_files: z.number().int().nonnegative(),
    reasons: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          path: projectPath.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (value) =>
      !value.complete ||
      (value.skipped_files === 0 && value.reasons.length === 0),
    "Complete coverage cannot hide omissions or unresolved reasons",
  );
export type Coverage = z.infer<typeof CoverageSchema>;
export const ReferenceSchema = z
  .object({
    schema_version: z.literal(1),
    root_id: z.string().regex(/^[a-f0-9]{64}$/),
    view_id: z.string().min(1),
    path: projectPath,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => value.end_line >= value.start_line,
    "Reference end precedes start",
  );
export type EvidenceReference = z.infer<typeof ReferenceSchema>;
export const NoteSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),
    title: z.string().min(1).max(160),
    review_status: z.enum(["proposed", "accepted", "deprecated"]),
    scopes: z
      .array(
        projectPath.refine(
          (value) => value.length <= 256 && !/[{}()!]/.test(value),
          "Use bounded basic globs only",
        ),
      )
      .min(1)
      .max(16),
    rationale: z.string().min(1).max(4096),
    reviewer: z.string().min(1).max(160).optional(),
    last_reviewed_revision: z.string().min(1).max(160).optional(),
    evidence: z
      .array(
        z
          .object({
            path: projectPath,
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
            symbol: z.string().min(1).max(160).optional(),
          })
          .strict(),
      )
      .max(32)
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.review_status !== "accepted" ||
      Boolean(value.reviewer && value.last_reviewed_revision),
    "Accepted notes require reviewer and reviewed revision",
  );

/** All TS config/resolver observations must be supplied by the same view. */
export interface SourceView {
  readonly id: string;
  readonly kind: "worktree" | "commit";
  readonly root: string;
  readonly case_sensitive: boolean;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
  readFile(path: string): string | undefined;
  readDirectory(
    path: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number,
  ): string[];
  realpath(path: string): string;
  getCurrentDirectory(): string;
}

export const EvidenceItemSchema = z
  .object({
    reference: ReferenceSchema,
    kind: z.enum(["source", "test", "config", "documentation", "note"]),
    reason: z.string().min(1),
    excerpt: z.string(),
    omitted_before: z.boolean(),
    omitted_after: z.boolean(),
    relationship: z
      .object({
        direction: z.enum(["outgoing", "incoming"]),
        anchor: projectPath,
        edge_kind: z.enum(["runtime", "type_only"]),
      })
      .strict()
      .optional(),
    note: z
      .object({
        id: z.string(),
        review_status: z.literal("accepted"),
        freshness: z.enum([
          "current",
          "needs_review",
          "target_missing",
          "unbound",
        ]),
        reviewer: z.string(),
        reviewed_revision: z.string(),
        evidence_count: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
const RetrievalEnvelope = {
  schema_version: z.literal(1),
  root_id: z.string().regex(/^[a-f0-9]{64}$/),
  view_id: z.string().min(1),
  generation: z.number().int().nonnegative().nullable(),
  evidence_trust: z.literal("repository_data"),
  coverage: CoverageSchema,
  coverage_reason_count: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()),
  items: z.array(EvidenceItemSchema),
  budget: z
    .object({
      limit: z.number().int().positive(),
      count: z.number().int().nonnegative(),
      method: z.enum(["exact", "estimate"]),
      counter: z.string(),
      byte_limit: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
};
export const ContextResultSchema = z
  .object({
    ...RetrievalEnvelope,
    operation: z.literal("context"),
    status: z.enum(["ok", "no_match", "budget_too_small"]),
    features: z
      .object({
        neighbors: z
          .object({
            seed_files: z.number().int().nonnegative(),
            candidates: z.number().int().nonnegative(),
            high_degree_seeds: z.number().int().nonnegative(),
            suppressed_unmatched: z.number().int().nonnegative(),
            unknown_edges: z.number().int().nonnegative(),
            capped: z.boolean(),
          })
          .strict()
          .optional(),
        notes: z
          .object({
            eligible: z.number().int().nonnegative(),
            invalid: z.number().int().nonnegative(),
            limited: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    omitted_notes: z
      .array(
        z
          .object({
            id: z.string(),
            reference: ReferenceSchema,
            reason: z.literal("budget"),
          })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.budget.count <= value.budget.limit &&
      value.budget.bytes <= value.budget.byte_limit,
    "Response exceeds counted or byte budget",
  );
export type ContextResult = z.infer<typeof ContextResultSchema>;
export const ExpandResultSchema = z
  .object({
    ...RetrievalEnvelope,
    operation: z.literal("expand"),
    status: z.enum([
      "expanded",
      "stale_reference",
      "unavailable_reference",
      "invalid_reference",
      "budget_too_small",
    ]),
    replacement: ReferenceSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.budget.count <= value.budget.limit &&
      value.budget.bytes <= value.budget.byte_limit,
    "Response exceeds counted or byte budget",
  );
export type ExpandResult = z.infer<typeof ExpandResultSchema>;
export const CheckCursorSchema = z
  .object({
    schema_version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type CheckCursor = z.infer<typeof CheckCursorSchema>;
export const CheckFindingSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    rule_id: z.string(),
    source: projectPath,
    target: projectPath,
    classification: z.enum(["new", "existing", "removed", "unclassified"]),
    observed_in: z.enum(["baseline", "target"]),
    line: z.number().int().positive(),
    baseline_line: z.number().int().positive().optional(),
    edge_kind: z.enum(["runtime", "type_only"]),
    specifier: z.string(),
    explanation: z.string(),
    reference: ReferenceSchema,
    excerpt: z.string(),
    excerpt_truncated: z.boolean(),
  })
  .strict();
export type CheckFinding = z.infer<typeof CheckFindingSchema>;
export const CheckResultSchema = z
  .object({
    schema_version: z.literal(1),
    operation: z.literal("check"),
    root_id: z.string().regex(/^[a-f0-9]{64}$/),
    baseline_id: z.string().min(1),
    target_id: z.string().min(1),
    policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
    policy_source: z.enum(["commit", "explicit_config", "unavailable"]),
    policy_revision: z.string().nullable(),
    candidate_policy_changed: z.boolean(),
    mode: z.enum(["advisory", "required"]),
    exit_code: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    rule_count: z.number().int().nonnegative(),
    counts: z
      .object({
        new: z.number().int().nonnegative(),
        existing: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
        unclassified: z.number().int().nonnegative(),
      })
      .strict(),
    coverage: CoverageSchema,
    coverage_reason_count: z.number().int().nonnegative(),
    diagnostics: z.array(z.string()),
    status: z.enum([
      "complete",
      "incomplete",
      "no_rules",
      "stale_cursor",
      "report_too_small",
    ]),
    findings: z.array(CheckFindingSchema),
    manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
    page: z
      .object({
        offset: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
    next_cursor: CheckCursorSchema.optional(),
    response_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => {
    const expected =
      value.status === "complete"
        ? value.mode === "required" && value.counts.new > 0
          ? 1
          : 0
        : value.status === "no_rules"
          ? value.mode === "required"
            ? 2
            : 0
          : 2;
    return (
      (value.coverage.complete || value.status !== "complete") &&
      (value.status !== "complete" || value.counts.unclassified === 0) &&
      (value.status !== "no_rules" ||
        (value.coverage.complete &&
          value.rule_count === 0 &&
          value.page.total === 0)) &&
      value.coverage_reason_count >= value.coverage.reasons.length &&
      value.exit_code === expected &&
      value.page.returned === value.findings.length &&
      value.page.total ===
        value.counts.new +
          value.counts.existing +
          value.counts.removed +
          value.counts.unclassified
    );
  }, "Incomplete coverage cannot pass; exit status and full-report counts must agree");
export type CheckResult = z.infer<typeof CheckResultSchema>;
