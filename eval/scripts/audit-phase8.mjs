import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  copyFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { restorePhase8Access } from "./phase8-cleanup.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  runId = "2026-10-27T04-47-25-818Z",
  output = join(project, "eval/runs/phase8", runId),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  json = async (path) => JSON.parse(await readFile(path, "utf8")),
  save = async (path, value) =>
    writeFile(path, JSON.stringify(value, null, 2) + "\n"),
  raw = await json(join(output, "summary.json")),
  stopped = await json(join(output, "manual-infrastructure-stop.json")),
  reservations = (
    await readFile(join(project, "eval/runs/phase8/attempts.jsonl"), "utf8")
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse),
  tasks = (await json(join(project, "eval/manifests/holdout-readiness.json")))
    .tasks;
if (
  reservations.some((entry) => entry.run_id !== runId) ||
  reservations.length !== 3
)
  throw Error("Unexpected reservation inventory; audit before proceeding");
const rows = [],
  diagnostics = [];
for (const reservation of reservations) {
  const target = join(output, reservation.slot),
    row = raw.rows.find((row) => row.slot === reservation.slot);
  if (row) {
    const timeline = await json(join(target, "timeline.json")),
      completed = timeline.findLast(
        (entry) => entry.event.type === "turn.completed",
      ),
      started = timeline.find((entry) => entry.event.type === "turn.started"),
      lifecycleFailure = row.run.timed_out && completed;
    diagnostics.push({
      slot: row.slot,
      raw_status: row.status,
      process_elapsed_ms: row.run.elapsed_ms,
      turn_started_at: started?.received_at ?? null,
      turn_completed_at: completed?.received_at ?? null,
      observed_turn_ms:
        completed && started
          ? Date.parse(completed.received_at) - Date.parse(started.received_at)
          : null,
      reservation_to_turn_complete_ms: completed
        ? Date.parse(completed.received_at) - Date.parse(row.reserved_at)
        : null,
      post_completion_process_timeout: Boolean(lifecycleFailure),
      scope:
        "Received event timestamps; reservation-to-completion includes reservation serialization/startup. Not provider-only inference time.",
    });
    rows.push({
      ...row,
      original_wrapper_status: row.status,
      status: lifecycleFailure ? "infrastructure_invalid" : row.status,
      audit_reason: lifecycleFailure
        ? "Model turn completed before deadline, but process did not exit; infrastructure lifecycle failure, not an agent task timeout. Exclude from strict primary pairs; preserve patch and completed-turn diagnostics."
        : null,
      report_path: `eval/runs/phase8/${runId}/${row.slot}/report.json`,
    });
    continue;
  }
  // The parent was stopped under the infrastructure rule. Preserve source and
  // already-persisted MCP trace; stdout buffered in the parent cannot be recovered.
  const request = await json(join(target, "request.json"));
  const actual = join(
      tmpdir(),
      "ctxgate-phase5-trials/holdout-" + runId,
      reservation.slot,
      "workspace",
    ),
    snapshot = join(target, "interrupted-workspace"),
    inventory = {},
    patches = [],
    task = tasks.find((task) => task.id === reservation.id);
  const capture = async (prefix = "") => {
    for (const entry of await readdir(join(actual, prefix), {
      withFileTypes: true,
    })) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (
        ["node_modules", ".git"].includes(entry.name) ||
        path === ".ctx/cache"
      )
        continue;
      const info = await lstat(join(actual, path));
      if (info.isSymbolicLink()) {
        inventory[path] = { unsupported: "symlink" };
        continue;
      }
      if (info.isDirectory()) {
        await capture(path);
        continue;
      }
      if (!info.isFile()) continue;
      const bytes = await readFile(join(actual, path));
      inventory[path] = { sha256: hash(bytes), bytes: bytes.length };
      const destination = join(snapshot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(actual, path), destination);
      if (path.startsWith(".ctx/") || path.startsWith(".ctxgate-")) continue;
      const before = spawnSync(
        "git",
        [
          "-C",
          join(project, "eval/.cache/upstream", task.repository),
          "show",
          task.base_commit + ":" + path,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      if (before.status === 0 && hash(before.stdout) === hash(bytes)) continue;
      const originalPath = join(target, "interrupted-original", path);
      await mkdir(dirname(originalPath), { recursive: true });
      await writeFile(originalPath, before.status === 0 ? before.stdout : "");
      const diff = spawnSync(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "diff",
          "--no-index",
          "--",
          originalPath,
          destination,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      patches.push({ path, patch: diff.stdout });
    }
  };
  await capture();
  const interruption = {
    ...reservation,
    status: "infrastructure_invalid",
    reason:
      "Manually stopped after preceding infrastructure lifecycle failure; never retry this reservation.",
    request_sha256: hash(await readFile(join(target, "request.json"))),
    model_stdout:
      "unavailable: parent buffered stdout before external tree stop",
    usage: null,
    completed_turn_observed: null,
    persisted_mcp_trace: `eval/runs/phase8/${runId}/${reservation.slot}/mcp.jsonl`,
    snapshot: `eval/runs/phase8/${runId}/${reservation.slot}/interrupted-workspace`,
    inventory,
    patches,
    host: request.host,
  };
  await save(join(target, "interruption.json"), interruption);
  rows.push({
    ...reservation,
    status: "infrastructure_invalid",
    run: { elapsed_ms: null, timed_out: null },
    metrics: {
      usage: {
        input_tokens: null,
        cached_input_tokens: null,
        uncached_input_tokens: null,
        output_tokens: null,
      },
      command_count: null,
      context_attempts: null,
      expand_attempts: null,
      pre_edit_delivery: null,
      retrieval_ms: [],
      engine_payload_bytes: null,
      observed_mcp_result_json_bytes: null,
    },
    host_failure: { reason: interruption.reason },
    report_path: `eval/runs/phase8/${runId}/${reservation.slot}/interruption.json`,
  });
}
const audit = {
  schema_version: 1,
  run_id: runId,
  created_at: new Date().toISOString(),
  planned_attempts: 36,
  reserved_attempts: reservations.length,
  completed_reports: raw.rows.length,
  unassessed_reservations: reservations.length - raw.rows.length,
  stop_reason:
    "CLI shutdown hang after completed turn; manual infrastructure stop. One further reservation was already in progress because the wrapper failed to classify the lifecycle error.",
  adjudication:
    "Post-run infrastructure adjudication applies the existing stop rule. Original wrapper status/results remain immutable. Report a sensitivity view of completed patches/turns, never silently promote them into valid strict pairs.",
  raw_summary: `eval/runs/phase8/${runId}/summary.json`,
  manual_stop: stopped,
  diagnostics,
  rows,
};
audit.cleanup = await restorePhase8Access(
  join(output, "post-stop-permission-restoration.json"),
);
await save(join(project, "eval/summaries/phase8-audit.json"), audit);
console.log(
  JSON.stringify(
    {
      run_id: runId,
      reservations: reservations.length,
      completed_reports: raw.rows.length,
      infrastructure_invalid: rows.filter(
        (row) => row.status === "infrastructure_invalid",
      ).length,
      diagnostics,
      cleanup: audit.cleanup,
    },
    null,
    2,
  ),
);
