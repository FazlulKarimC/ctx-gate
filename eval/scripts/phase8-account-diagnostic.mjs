import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { project, openHostAudit } from "./phase5-host.mjs";
import { applyPhase8HostPin } from "./phase8-host-pin.mjs";
await applyPhase8HostPin();
const staticReport = JSON.parse(
  await readFile(
    join(
      project,
      "eval/runs/phase8-readiness/2026-10-27T05-20-31-237Z/report.json",
    ),
    "utf8",
  ),
);
const report = {
  schema_version: 1,
  operation: "phase8_readonly_account_limits",
  created_at: new Date().toISOString(),
  model_calls: 0,
  login_changes: false,
  resets_consumed: false,
  credential_files_read_by_script: false,
};
const fingerprint = (value) =>
  value ? createHash("sha256").update(value).digest("hex") : null;
const audit = await openHostAudit(staticReport.workspace);
try {
  report.host = audit.host;
  const [account, limits] = await Promise.allSettled([
    audit.request("account/read", { refreshToken: false }),
    audit.request("account/rateLimits/read", {}),
  ]);
  if (account.status === "fulfilled") {
    const value = account.value.account;
    report.account = {
      type: value?.type ?? null,
      plan: value?.planType ?? null,
      id_fingerprint: fingerprint(value?.id ?? value?.accountId ?? null),
      email_fingerprint: fingerprint(value?.email ?? null),
      requires_auth: account.value.requiresOpenaiAuth,
    };
  } else report.account_error = account.reason.message;
  if (limits.status === "fulfilled") {
    report.rate_limits = limits.value.rateLimits;
    report.rate_limits_by_id = limits.value.rateLimitsByLimitId;
  } else report.limits_error = limits.reason.message;
} finally {
  await audit.close();
}
await writeFile(
  join(project, "eval/summaries/phase8-account-diagnostic.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
