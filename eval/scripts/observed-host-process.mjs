import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { killTree } from "./phase5-host.mjs";
import { isAccountLimit } from "./host-failures.mjs";

// Proposed FOLLOW-UP adapter only. The original Phase 8 adapter/records remain
// frozen. A recovery study must explicitly register this completion boundary.
export async function observedHostProcess(
  command,
  args,
  { cwd, output, timeout_ms = 300000, cleanup_grace_ms = 5000, signal },
) {
  mkdirSync(output, { recursive: true });
  for (const file of [
    "events.jsonl",
    "stderr.txt",
    "timeline.jsonl",
    "lifecycle.jsonl",
  ])
    writeFileSync(join(output, file), "", { flag: "wx" });
  const started = performance.now(),
    started_at = new Date().toISOString(),
    elapsed = () => performance.now() - started,
    persist = (file, value) => appendFileSync(join(output, file), value),
    lifecycle = (event) =>
      persist(
        "lifecycle.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          elapsed_ms: elapsed(),
          ...event,
        }) + "\n",
      );
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    timed_out = false,
    spawn_error = null,
    account_limit_detected = false,
    turn_completed_ms = null,
    cleanup_forced = false,
    cancelled = false,
    output_limit = false,
    exit_code = null,
    exit_observed = false,
    cleanup_incomplete = false,
    cleanupTimer,
    fallbackTimer;
  const events = [],
    timeline = [];
  let invalid_json_lines = 0;
  const stop = (reason) => {
    lifecycle({ type: "stop_owned_process", reason, exit_observed });
    if (!exit_observed) killTree(child);
    // Record an explicit failure if process/stream cleanup cannot be established.
    fallbackTimer ??= setTimeout(() => {
      cleanup_incomplete = true;
      child.stdout.destroy();
      child.stderr.destroy();
      if (!exit_observed) child.kill("SIGKILL");
      finish(null);
    }, 3000);
  };
  let finish;
  const closed = new Promise((done) => {
    finish = done;
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line),
        entry = {
          received_at: new Date().toISOString(),
          elapsed_ms: elapsed(),
          event,
        };
      events.push(event);
      timeline.push(entry);
      persist("timeline.jsonl", JSON.stringify(entry) + "\n");
      if (
        ["error", "turn.failed"].includes(event.type) &&
        isAccountLimit(JSON.stringify(event))
      ) {
        account_limit_detected = true;
        stop("account_limit");
      }
      if (event.type === "turn.completed" && turn_completed_ms === null) {
        turn_completed_ms = elapsed();
        lifecycle({ type: "model_turn_completed", turn_completed_ms });
        if (!timed_out && !account_limit_detected && !cancelled) {
          clearTimeout(taskTimer);
          cleanupTimer = setTimeout(() => {
            cleanup_forced = true;
            stop("terminal_cleanup_grace_expired");
          }, cleanup_grace_ms);
        }
      }
    } catch {
      invalid_json_lines++;
    }
  });
  child.stdout.on("data", (data) => {
    persist("events.jsonl", data);
    stdout += data;
    if (!output_limit && Buffer.byteLength(stdout) > 16 * 1024 * 1024) {
      output_limit = true;
      stop("stdout_limit");
    }
  });
  child.stderr.on("data", (data) => {
    persist("stderr.txt", data);
    stderr += data;
    if (!account_limit_detected && isAccountLimit(stderr)) {
      account_limit_detected = true;
      stop("account_limit");
    }
    if (!output_limit && Buffer.byteLength(stderr) > 4 * 1024 * 1024) {
      output_limit = true;
      stop("stderr_limit");
    }
  });
  child.on("error", (error) => {
    spawn_error = error.message;
    lifecycle({ type: "spawn_error", error: spawn_error });
  });
  child.on("exit", (code, exitSignal) => {
    exit_observed = true;
    exit_code = code;
    lifecycle({ type: "process_exit", code, signal: exitSignal });
  });
  child.on("close", (code) => {
    exit_code = code;
    lifecycle({ type: "streams_closed", code });
    finish(code);
  });
  const taskTimer = setTimeout(() => {
    timed_out = true;
    stop("task_deadline_before_terminal_event");
  }, timeout_ms);
  const abort = () => {
    cancelled = true;
    stop("supervisor_abort");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  lifecycle({ type: "spawned", pid: child.pid ?? null, command, started_at });
  await closed;
  clearTimeout(taskTimer);
  clearTimeout(cleanupTimer);
  clearTimeout(fallbackTimer);
  signal?.removeEventListener("abort", abort);
  reader.close();
  const elapsed_ms = elapsed(),
    unexpected_exit =
      turn_completed_ms !== null && exit_code !== 0 && !cleanup_forced,
    missing_terminal =
      turn_completed_ms === null && !timed_out && !account_limit_detected,
    completed =
      turn_completed_ms !== null &&
      !timed_out &&
      !cancelled &&
      !spawn_error &&
      !account_limit_detected &&
      !output_limit &&
      !cleanup_incomplete &&
      !unexpected_exit;
  const result = {
    started_at,
    events,
    timeline,
    stdout,
    stderr,
    elapsed_ms,
    exit_code,
    timed_out,
    spawn_error,
    account_limit_detected,
    invalid_json_lines,
    turn_completed_ms,
    cleanup_elapsed_ms:
      turn_completed_ms === null ? null : elapsed_ms - turn_completed_ms,
    cleanup_forced,
    cleanup_incomplete,
    cancelled,
    output_limit,
    unexpected_exit,
    missing_terminal,
    model_turn_completed: completed,
    stop_batch:
      account_limit_detected ||
      Boolean(spawn_error) ||
      cleanup_incomplete ||
      unexpected_exit ||
      missing_terminal ||
      output_limit ||
      cancelled,
    completion_contract:
      "Successful terminal JSONL event before task deadline, plus verified process/stream cleanup. Forced cleanup is separately reported and included in full elapsed time. Candidate patch correctness is independently assessed.",
  };
  lifecycle({
    type: "finished",
    model_turn_completed: completed,
    cleanup_forced,
    cleanup_incomplete,
    elapsed_ms,
  });
  writeFileSync(
    join(output, "process-result.json"),
    JSON.stringify(
      {
        ...result,
        events: undefined,
        timeline: undefined,
        stdout: undefined,
        stderr: undefined,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return result;
}
