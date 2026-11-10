import { readFileSync } from "node:fs";
import {
  refreshIndex,
  context,
  expand,
  check,
  captureWorktree,
} from "../../dist/index.js";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const start = performance.now();
try {
  let result;
  if (input.operation === "index") result = refreshIndex(input.root);
  else if (input.operation === "context")
    result = await context(input.root, "symbol:feature00000", {
      encoding: input.encoding ?? "estimate",
      budget_tokens: 2000,
    });
  else if (input.operation === "expand")
    result = await expand(input.root, input.reference, { budget_tokens: 2000 });
  else if (input.operation === "check")
    result = check(input.root, {
      base: input.base,
      target: input.target ?? "worktree",
      mode: "required",
    });
  else if (input.operation === "capture") {
    const scan = captureWorktree(input.root);
    result = {
      operation: "capture",
      status: scan.coverage.complete ? "complete" : "incomplete",
      files: scan.view.files.size,
      bytes: scan.bytes,
      coverage: scan.coverage,
    };
  } else throw Error("Unknown operational worker request");
  const rendered = JSON.stringify(result);
  console.log(
    JSON.stringify({
      schema_version: 1,
      elapsed_ms: performance.now() - start,
      peak_rss_kib: process.resourceUsage().maxRSS,
      response_bytes: Buffer.byteLength(rendered) + 1,
      result,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      schema_version: 1,
      elapsed_ms: performance.now() - start,
      peak_rss_kib: process.resourceUsage().maxRSS,
      error: error.message,
    }),
  );
  process.exitCode = 2;
}
