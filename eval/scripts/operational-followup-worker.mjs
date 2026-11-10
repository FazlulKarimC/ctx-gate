import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const engine = await import(pathToFileURL(input.module).href),
  start = performance.now();
let result;
if (input.operation === "baseline_capture") {
  const scan = engine.captureCommit(input.root, input.base);
  result = {
    status: scan.coverage.complete ? "complete" : "incomplete",
    files: scan.view.files.size,
    bytes: scan.bytes,
    coverage: scan.coverage,
    scan_ms: scan.scan_ms,
  };
} else if (input.operation === "context")
  result = await engine.context(input.root, "symbol:feature00000", {
    encoding: "estimate",
    budget_tokens: 2000,
  });
else if (input.operation === "expand")
  result = await engine.expand(input.root, input.reference, {
    budget_tokens: 2000,
  });
else if (input.operation === "check")
  result = engine.check(input.root, { base: input.base, mode: "required" });
else throw Error("Unknown follow-up operation");
console.log(
  JSON.stringify({
    elapsed_ms: performance.now() - start,
    peak_rss_kib: process.resourceUsage().maxRSS,
    result,
  }),
);
