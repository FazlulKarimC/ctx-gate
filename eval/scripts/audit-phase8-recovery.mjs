import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { evaluationOutcome } from "./evaluation-outcome.mjs";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  path = join(project, "eval/summaries/phase8-recovery-preliminary.json"),
  bytes = await readFile(path),
  raw = JSON.parse(bytes),
  ledger = (
    await readFile(join(project, "eval/runs/phase8/attempts.jsonl"), "utf8")
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse),
  used = ledger.filter((row) => row.run_id === raw.run_id),
  rows = raw.rows.map((row) => {
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
        status !== row.status
          ? "Passing partial-patch tests cannot override the registered quota-after-progress task-failure status or missing terminal completion. The raw wrapper omitted its task_failure precedence branch."
          : null,
      report_path: `eval/runs/phase8-recovery/${raw.run_id}/${row.slot}/report.json`,
    };
  });
if (used.length !== raw.reserved_attempts || ledger.length > 36)
  throw Error("Reservation accounting mismatch");
const stop = rows.find((row) => row.host_failure.stop_batch);
const audit = {
  ...raw,
  operation: "phase8_recovery_audit",
  created_at: new Date().toISOString(),
  raw_preliminary_sha256: createHash("sha256").update(bytes).digest("hex"),
  total_reserved_across_variants: ledger.length,
  stop_reason: stop?.host_failure.reason ?? raw.stop_reason,
  adjudication:
    "Preserve original report labels. Apply the existing registered task_failure precedence to quota-after-progress, even when its unfinished patch passes tests. No task was rerun or promoted into success. Missing usage is unavailable; interrupted elapsed time is consumed time, not completion latency.",
  rows,
};
await writeFile(
  join(project, "eval/summaries/phase8-recovery-audit.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      run_id: raw.run_id,
      reservations: used.length,
      reports: rows.length,
      total_reserved: ledger.length,
      unattempted: 36 - ledger.length,
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
