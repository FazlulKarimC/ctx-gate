export function relevanceMetrics(result, label, view) {
  const sourceFiles = new Set(label.source_spans.map((span) => span.path));
  const usefulFiles = new Set([
    ...sourceFiles,
    ...label.existing_tests.filter((path) => view.fileExists(path)),
  ]);
  const refs = result.items.map((item) => item.reference);
  const hitSpans = label.source_spans.filter((span) =>
    refs.some(
      (ref) =>
        ref.path === span.path &&
        ref.start_line <= span.end_line &&
        span.start_line <= ref.end_line,
    ),
  );
  const lines = new Set(),
    found = new Set();
  for (const span of label.source_spans)
    for (let line = span.start_line; line <= span.end_line; line++) {
      const key = span.path + ":" + line;
      lines.add(key);
      if (
        refs.some(
          (ref) =>
            ref.path === span.path &&
            ref.start_line <= line &&
            ref.end_line >= line,
        )
      )
        found.add(key);
    }
  return {
    source_file_hit: refs.some((ref) => sourceFiles.has(ref.path)),
    source_span_hit: hitSpans.length > 0,
    source_span_recall: hitSpans.length / label.source_spans.length,
    labeled_source_line_recall: found.size / lines.size,
    labeled_useful_file_precision: refs.length
      ? refs.filter((ref) => usefulFiles.has(ref.path)).length / refs.length
      : null,
    item_count: refs.length,
    no_match: result.status === "no_match",
    budget_count: result.budget.count,
    bytes: result.budget.bytes,
    coverage_complete: result.coverage.complete,
    selected_spans: refs.map(({ path, start_line, end_line }) => ({
      path,
      start_line,
      end_line,
    })),
  };
}
export const mean = (values) =>
  values.reduce((a, b) => a + b, 0) / values.length;
export const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
export function aggregateRelevance(rows, variant) {
  const results = rows.map((row) => row[variant].metrics);
  return {
    n: rows.length,
    source_file_hits: results.filter((row) => row.source_file_hit).length,
    source_span_hits: results.filter((row) => row.source_span_hit).length,
    mean_source_span_recall: mean(results.map((row) => row.source_span_recall)),
    mean_labeled_line_recall: mean(
      results.map((row) => row.labeled_source_line_recall),
    ),
    mean_labeled_file_precision: mean(
      results
        .filter((row) => row.labeled_useful_file_precision !== null)
        .map((row) => row.labeled_useful_file_precision),
    ),
    mean_counted_tokens: mean(results.map((row) => row.budget_count)),
    warm_p50_ms: percentile(
      rows.flatMap((row) => row[variant].timings_ms),
      0.5,
    ),
    warm_p95_ms: percentile(
      rows.flatMap((row) => row[variant].timings_ms),
      0.95,
    ),
    mean_counter_calls: mean(
      rows.map((row) => mean(row[variant].counter_calls)),
    ),
  };
}
