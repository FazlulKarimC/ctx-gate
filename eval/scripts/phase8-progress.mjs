import { readFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  ledger = (
    await readFile(join(project, "eval/runs/phase8/attempts.jsonl"), "utf8")
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse),
  recovery = ledger.filter(
    (row) => row.method_variant === "terminal_event_with_bounded_cleanup_v1",
  ),
  run = recovery.at(-1)?.run_id,
  root = run ? join(project, "eval/runs/phase8-recovery", run) : null;
const reports = [];
for (const reservation of recovery) {
  try {
    reports.push(
      JSON.parse(
        await readFile(join(root, reservation.slot, "report.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (!["ENOENT"].includes(error.code) && !(error instanceof SyntaxError))
      throw error;
  }
}
let lastLifecycle = [];
let audited = null;
try {
  const value = JSON.parse(
    await readFile(
      join(project, "eval/summaries/phase8-recovery.json"),
      "utf8",
    ),
  );
  if (value.run_id === run)
    audited = {
      by_condition: Object.fromEntries(
        Object.entries(value.by_condition).map(([key, row]) => [
          key,
          {
            n: row.n,
            success: row.success,
            task_failure: row.task_failure,
            infrastructure_invalid: row.infrastructure_invalid,
            unassessed: row.unassessed,
          },
        ]),
      ),
      matched_eligible_outcome_pairs: value.complete_pairs.n,
      fully_completed_turn_pairs:
        value.complete_pairs.fully_completed_turn_pairs,
      stop_reason: value.stop_reason,
    };
} catch {}
if (root && recovery.length > reports.length) {
  try {
    lastLifecycle = (
      await readFile(
        join(root, recovery.at(-1).slot, "lifecycle.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
  } catch {}
}
console.log(
  JSON.stringify(
    {
      operation: "phase8_progress",
      model_calls: 0,
      global_reserved: ledger.length,
      global_ceiling: 36,
      recovery_run: run ?? null,
      recovery_reserved: recovery.length,
      recovery_planned: 33,
      recovery_reports: reports.length,
      recovery_unattempted: 33 - recovery.length,
      active_or_pending_slot:
        recovery.length > reports.length ? recovery.at(-1)?.slot : null,
      last_lifecycle: lastLifecycle.at(-1) ?? null,
      raw_status_counts: Object.fromEntries(
        [...new Set(reports.map((row) => row.status))].map((status) => [
          status,
          reports.filter((row) => row.status === status).length,
        ]),
      ),
      forced_cleanup_count: reports.filter((row) => row.run.cleanup_forced)
        .length,
      audited_reviewed_outcomes: audited,
      interpretation:
        "Raw unassessed is not success; protected tests and patch review determine outcomes. Original three-slot block remains separate.",
    },
    null,
    2,
  ),
);
