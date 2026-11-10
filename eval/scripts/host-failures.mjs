// Only provider/host errors are scanned, never repository/tool output content.
export const isAccountLimit = (text) =>
  /(?:you[’']?ve|you have) hit your usage limit|usage_limit_reached|insufficient_quota|quota[_ ]exceeded|rate[_ ]limit[_ ](?:reached|exceeded)|429\s+(?:too many requests|usage)/i.test(
    text ?? "",
  );
export function classifyHostFailure(run, changed = [], metrics = {}) {
  const errors = run.events.filter((event) =>
    ["error", "turn.failed"].includes(event.type),
  );
  const providerText = run.stderr + " " + JSON.stringify(errors);
  const progress = Boolean(
    metrics.command_count ||
    metrics.context_attempts ||
    metrics.expand_attempts ||
    changed.length ||
    run.events.some((event) => event.item?.type === "file_change"),
  );
  if (run.account_limit_detected || isAccountLimit(providerText))
    return {
      status: progress ? "task_failure" : "infrastructure_invalid",
      reason: progress
        ? "account_limit_after_task_progress"
        : "account_limit_before_task_progress",
      stop_batch: true,
      task_progress: progress,
    };
  const hasTurn = run.events.some((event) => event.type === "turn.started");
  if (
    !hasTurn &&
    /required.*mcp|mcp.*(?:failed|error)|ctxgate.*(?:failed|error)/i.test(
      run.stderr,
    )
  )
    return {
      status: "product_failure",
      reason: "mcp_startup_failure",
      stop_batch: false,
      task_progress: progress,
    };
  if (
    run.spawn_error ||
    !hasTurn ||
    (!progress &&
      /unauthorized|authentication|not authenticated|401|403/i.test(
        providerText,
      ))
  )
    return {
      status: "infrastructure_invalid",
      reason: "host_startup_or_authentication_failure",
      stop_batch: true,
      task_progress: progress,
    };
  return {
    status: "eligible",
    reason: null,
    stop_batch: false,
    task_progress: progress,
  };
}
