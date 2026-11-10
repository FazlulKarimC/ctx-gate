import { readFileSync, writeFileSync } from "node:fs";
const raw = JSON.parse(readFileSync("eval/summaries/operational.json"));
const percentile = (values, q) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]
    : null;
const rows = raw.results.map((item) => ({
  name: item.name,
  files: item.cold_index.files,
  bytes: item.cold_index.bytes,
  cold_index_ms: item.cold_index.wall_ms,
  cache_bytes: item.cache_bytes,
  small_edit: item.small_edit_index,
  stopped: item.stopped ?? null,
  operations: Object.fromEntries(
    Object.entries(item.samples).map(([operation, samples]) => {
      const interrupted = samples.filter(
          (sample) => sample.timed_out && sample.wall_ms > 360000,
        ),
        completed = samples.filter(
          (sample) =>
            !sample.timed_out && !sample.error && sample.exit_code === 0,
        ),
        successful = completed.filter(
          (sample) =>
            sample.coverage_complete !== false &&
            (sample.check_exit === undefined || sample.check_exit === 0),
        );
      return [
        operation,
        {
          attempted: samples.length,
          completed: completed.length,
          complete_coverage: successful.length,
          incomplete_coverage: completed.length - successful.length,
          infrastructure_scheduling_anomaly: interrupted.length,
          p50_completed_ms: percentile(
            completed.map((s) => s.wall_ms),
            0.5,
          ),
          p95_completed_ms:
            samples.length > 1
              ? percentile(
                  completed.map((s) => s.wall_ms),
                  0.95,
                )
              : null,
          p95_complete_coverage_ms:
            samples.length > 1
              ? percentile(
                  successful.map((s) => s.wall_ms),
                  0.95,
                )
              : null,
          max_peak_rss_kib: Math.max(
            ...completed.map((s) => s.peak_rss_kib ?? 0),
          ),
        },
      ];
    }),
  ),
  over_file_count_limit: item.over_file_count_limit,
  over_total_byte_limit: item.over_total_byte_limit,
  over_file_byte_limit: item.over_file_byte_limit,
}));
const report = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  raw_run: raw.run_id,
  runtime: raw.runtime,
  platform: raw.platform,
  methodology: raw.methodology,
  assessment:
    "Original raw records retained. A 31,059,520 ms observation exceeded the 120,000 ms watchdog by hours; scheduling/suspension interruption is suspected, cause unproven. No product latency is inferred from that censored observation. Completed metrics include explicit coverage failures; successful-coverage metrics remain separate. n=1 byte probe has no p95. Desktop work and qualification/install activity were not isolated; percentiles are descriptive.",
  harness_issue:
    "Original runner noticed worker process errors but did not stop on incomplete engine coverage, and performed edits after a stopped size case. Those post-stop observations are diagnostics only; they cannot certify the registered stop rule. Future runner now stops dependent operations on errors/incomplete coverage.",
  results: rows,
};
writeFileSync(
  "eval/summaries/operational-audit.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    rows.map((row) => ({
      name: row.name,
      cold_index_ms: row.cold_index_ms,
      cache_bytes: row.cache_bytes,
      context: row.operations.context_estimate,
      check: row.operations.check_worktree,
    })),
    null,
    2,
  ),
);
