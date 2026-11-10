// Post-run audit only. It never invokes a model or alters raw reports.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationOutcome } from "./evaluation-outcome.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rawPath = join(project, "eval/summaries/phase8-terra-preliminary.json");
const rawBytes = await readFile(rawPath);
const raw = JSON.parse(rawBytes);
const ledger = (
  await readFile(join(project, "eval/runs/phase8-terra/attempts.jsonl"), "utf8")
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const reservations = ledger.filter((row) => row.run_id === raw.run_id);
if (reservations.length !== raw.reserved_attempts)
  throw Error("Terra reservation accounting mismatch");
if (new Set(ledger.map((row) => row.slot)).size !== ledger.length)
  throw Error("Duplicate Terra reservation detected");
if (raw.rows.length !== raw.completed_reports)
  throw Error("Terra report accounting mismatch");

const rows = raw.rows.map((row) => {
  const status = evaluationOutcome({
    host_failure: row.host_failure,
    timed_out: row.run.timed_out,
    model_turn_completed: row.run.model_turn_completed,
    assessment: row.assessment,
  });
  const noPatchAfterLimit =
    row.host_failure?.reason === "account_limit_after_task_progress" &&
    row.changed.length === 0;
  return {
    ...row,
    original_wrapper_status: row.status,
    status,
    report_path: `eval/runs/phase8-terra/${raw.run_id}/${row.slot}/report.json`,
    patch_review: noPatchAfterLimit
      ? {
          required: false,
          disposition:
            "not_applicable_no_production_change_after_account_limit",
        }
      : { required: true, disposition: "pending" },
    audit_reason:
      status === row.status
        ? null
        : "Outcome precedence was recomputed without changing raw evidence.",
  };
});
const stop = rows.find((row) => row.host_failure?.stop_batch);
const audit = {
  ...raw,
  operation: "phase8_terra_audit",
  created_at: new Date().toISOString(),
  raw_preliminary_sha256: createHash("sha256").update(rawBytes).digest("hex"),
  independent_ledger: "eval/runs/phase8-terra/attempts.jsonl",
  historical_sol_ledger: "eval/runs/phase8/attempts.jsonl",
  audit_scope:
    "Independent Terra stratum. Sol reservations are neither counted nor pooled.",
  unattempted_registered_slots: raw.planned_attempts - ledger.length,
  stop_reason: stop?.host_failure?.reason ?? raw.stop_reason,
  adjudication:
    "A provider usage limit after task progress is retained as task_failure and stops the block. With no production-file change, patch review is not applicable. No retry, reassignment, model substitution, or model call occurs in this audit.",
  rows,
};
await writeFile(
  join(project, "eval/summaries/phase8-terra-audit.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: audit.run_id,
      reservations: reservations.length,
      reports: rows.length,
      unattempted_registered_slots: audit.unattempted_registered_slots,
      stop_reason: audit.stop_reason,
      model_calls: 0,
    },
    null,
    2,
  ),
);
