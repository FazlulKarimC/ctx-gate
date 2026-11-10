export function usageMetrics(events) {
  const usage =
    events.filter((event) => event.type === "turn.completed").at(-1)?.usage ??
    null;
  const numeric = (key) =>
    Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
  const input = numeric("input_tokens"),
    cached = numeric("cached_input_tokens");
  return {
    raw: usage,
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens:
      input !== null && cached !== null && cached <= input
        ? input - cached
        : null,
    cache_write_input_tokens: numeric("cache_write_input_tokens"),
    output_tokens: numeric("output_tokens"),
    reasoning_output_tokens: numeric("reasoning_output_tokens"),
    billing_cost: null,
  };
}
export const editingCommand = (command) =>
  /\b(?:Set-Content|Add-Content|Out-File|WriteAllText|WriteAllBytes|writeFile(?:Sync)?|write_text|write_bytes|apply_patch)\b|\bsed\b[^\n]*\s-i\b|\bopen\([^\n]*['"][wa]['"]|\btee\s/i.test(
    command ?? "",
  );
const overlap = (ref, span) =>
  ref.path === span.path &&
  ref.start_line <= span.end_line &&
  span.start_line <= ref.end_line;
export function pilotMetrics(run, telemetry, label) {
  const indexed = run.events.map((event, index) => ({ event, index }));
  const calls = indexed.filter(
    (row) =>
      row.event.type === "item.completed" &&
      row.event.item?.type === "mcp_tool_call" &&
      row.event.item?.server === "ctxgate",
  );
  const context = calls.filter((row) => row.event.item.tool === "ctx_context"),
    expands = calls.filter((row) => row.event.item.tool === "ctx_expand");
  const firstEdit = indexed.find(
    (row) =>
      row.event.item?.type === "file_change" ||
      (row.event.type === "item.started" &&
        row.event.item?.type === "command_execution" &&
        editingCommand(row.event.item.command)),
  );
  const successful = context.filter((row) => {
    try {
      const payload = JSON.parse(
        row.event.item.result?.content?.find((item) => item.type === "text")
          ?.text,
      );
      return (
        row.event.item.status === "completed" &&
        !row.event.item.error &&
        !row.event.item.result?.isError &&
        !row.event.item.result?.is_error &&
        ["ok", "no_match"].includes(payload.status)
      );
    } catch {
      return false;
    }
  });
  const nonempty = successful.filter((row) => {
    try {
      const text = row.event.item.result?.content?.find(
        (item) => item.type === "text",
      )?.text;
      return JSON.parse(text).items?.length > 0;
    } catch {
      return false;
    }
  });
  const deliveredBefore = nonempty.filter(
    (row) => !firstEdit || row.index < firstEdit.index,
  );
  const commands = indexed.filter(
    (row) =>
      row.event.type === "item.completed" &&
      row.event.item?.type === "command_execution",
  );
  const unique = new Set(commands.map((row) => row.event.item.command));
  const useful = deliveredBefore.filter((row) => {
    try {
      const value = JSON.parse(
        row.event.item.result.content.find((item) => item.type === "text").text,
      );
      return value.items.some((item) =>
        label.source_spans.some((span) => overlap(item.reference, span)),
      );
    } catch {
      return false;
    }
  });
  const firstDelivery = nonempty[0],
    deliveryTime = firstDelivery
      ? Date.parse(run.timeline[firstDelivery.index].received_at) -
        Date.parse(run.started_at)
      : null;
  const returnMetrics = {
    context_attempts: context.length,
    valid_context_responses: successful.length,
    nonempty_context_deliveries: nonempty.length,
    expand_attempts: expands.length,
    valid_expansions: expands.filter(
      (row) =>
        row.event.item.status === "completed" &&
        !row.event.item.error &&
        !row.event.item.result?.isError &&
        !row.event.item.result?.is_error,
    ).length,
    first_substantive_edit_event: firstEdit?.index ?? null,
    pre_edit_delivery: deliveredBefore.length > 0,
    pre_edit_useful_span_delivery: useful.length > 0,
    time_to_context_delivery_ms: deliveryTime,
    edit_timing_method:
      "Earliest file-change event or recognized shell-write command; ambiguous shell writes require trace review. Without an observed edit, delivery means before any observed edit only.",
    command_count: commands.length,
    repeated_exact_commands: commands.length - unique.size,
    compaction_observed_events:
      run.events.filter((event) => /compact/i.test(event.type)).length || null,
    retrieval_ms: telemetry
      .filter((event) => event.operation === "context")
      .map((event) => event.elapsed_ms),
    returned_engine_tokens: telemetry.reduce(
      (sum, event) => sum + (event.budget?.count ?? 0),
      0,
    ),
    engine_payload_bytes: telemetry.reduce(
      (sum, event) => sum + event.response_bytes,
      0,
    ),
    observed_mcp_result_json_bytes: calls.reduce(
      (sum, row) =>
        sum + Buffer.byteLength(JSON.stringify(row.event.item.result ?? null)),
      0,
    ),
    tool_configuration: context.map((row) => ({
      encoding: row.event.item.arguments?.encoding ?? "estimate",
      budget_tokens: row.event.item.arguments?.budget_tokens ?? 2000,
      neighbors: row.event.item.arguments?.neighbors ?? false,
      notes: row.event.item.arguments?.notes ?? false,
    })),
    host_errors: run.events.filter((event) =>
      ["error", "turn.failed"].includes(event.type),
    ),
    usage: usageMetrics(run.events),
  };
  return returnMetrics;
}
