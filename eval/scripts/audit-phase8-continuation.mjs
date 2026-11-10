// Post-run audit only. This never invokes a model or changes registered raw reports.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationOutcome } from "./evaluation-outcome.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rawPath = join(
  project,
  "eval/summaries/phase8-continuation-preliminary.json",
);
const rawBytes = await readFile(rawPath);
const raw = JSON.parse(rawBytes);
const ledger = (
  await readFile(join(project, "eval/runs/phase8/attempts.jsonl"), "utf8")
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const reservations = ledger.filter((row) => row.run_id === raw.run_id);
const rows = raw.rows.map((row) => {
  const status = evaluationOutcome({
    host_failure: row.host_failure,
    timed_out: row.run.timed_out,
    model_turn_completed: row.run.model_turn_completed,
    assessment: row.assessment,
  });
  return {
    ...row,
    original_wrapper_status: row.status,
    status,
    audit_reason:
      status === row.status
        ? null
        : "Outcome precedence was recomputed from the registered helper without changing the raw report.",
    report_path: `eval/runs/phase8-continuation/${raw.run_id}/${row.slot}/report.json`,
  };
});

if (reservations.length !== raw.reserved_attempts) {
  throw Error("Continuation reservation accounting mismatch");
}
if (ledger.length > 36) throw Error("Global attempt ceiling exceeded");
if (rows.length !== raw.completed_reports) {
  throw Error("Continuation report accounting mismatch");
}

const stop = rows.find((row) => row.host_failure?.stop_batch);
const audit = {
  ...raw,
  operation: "phase8_continuation_audit",
  created_at: new Date().toISOString(),
  raw_preliminary_sha256: createHash("sha256").update(rawBytes).digest("hex"),
  total_reserved_across_variants: ledger.length,
  globally_unattempted: 36 - ledger.length,
  stop_reason: stop?.host_failure?.reason ?? raw.stop_reason,
  adjudication:
    "Preserve every raw report and recompute only outcome precedence with the registered helper. A task deadline remains a task failure; an explicit unsupported-model host error remains infrastructure-invalid. No model call, retry, task reassignment, model substitution, or review promotion occurs here.",
  rows,
};
await writeFile(
  join(project, "eval/summaries/phase8-continuation-audit.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: audit.run_id,
      reservations: reservations.length,
      reports: rows.length,
      total_reserved: ledger.length,
      globally_unattempted: audit.globally_unattempted,
      stop_reason: audit.stop_reason,
      corrections: rows
        .filter((row) => row.status !== row.original_wrapper_status)
        .map((row) => ({
          slot: row.slot,
          original: row.original_wrapper_status,
          audited: row.status,
        })),
    },
    null,
    2,
  ),
);
