import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2),
  continuation = args[0] === "--continuation",
  recovery = args[0] === "--recovery";
if (recovery || continuation) args.shift();
const run =
  recovery || continuation ? args.shift() : "2026-10-27T04-47-25-818Z";
const compact = args.includes("--compact");
if (compact) args.splice(args.indexOf("--compact"), 1);
if (!/^\d{4}-\d{2}-\d{2}T[\d-Z-]+$/.test(run)) throw Error("Invalid run id");
for (const slot of args) {
  if (!/^(picomatch|json-server|fastify)-h\d{2}-r1-[AB]$/.test(slot))
    throw Error("Invalid slot");
  const root = join(
      project,
      continuation
        ? "eval/runs/phase8-continuation"
        : recovery
          ? "eval/runs/phase8-recovery"
          : "eval/runs/phase8",
      run,
      slot,
    ),
    row = JSON.parse(await readFile(join(root, "report.json"), "utf8")),
    events = (await readFile(join(root, "events.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
  console.log(
    JSON.stringify(
      {
        slot,
        status: row.status,
        assessment: row.assessment,
        run: row.run,
        metrics: compact
          ? {
              usage: row.metrics.usage,
              commands: row.metrics.command_count,
              context: row.metrics.context_attempts,
              expand: row.metrics.expand_attempts,
              pre_edit_delivery: row.metrics.pre_edit_delivery,
              retrieval_ms: row.metrics.retrieval_ms,
            }
          : row.metrics,
        patches: row.patches.map((patch) => ({
          path: patch.path,
          diff: patch.patch
            .split("\n")
            .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line))
            .join("\n"),
        })),
        context: events
          .filter(
            (event) =>
              event.type === "item.completed" &&
              event.item?.type === "mcp_tool_call",
          )
          .map((event) => {
            const call = event.item;
            let payload;
            try {
              payload = JSON.parse(
                call.result?.content?.find((part) => part.type === "text")
                  ?.text,
              );
            } catch {}
            return {
              tool: call.tool,
              arguments: call.arguments,
              status: call.status,
              error: call.error ?? null,
              response:
                compact && payload
                  ? {
                      status: payload.status,
                      budget: payload.budget,
                      references: payload.items?.map((item) => ({
                        path: item.reference.path,
                        start: item.reference.start_line,
                        end: item.reference.end_line,
                        reason: item.reason,
                      })),
                    }
                  : payload,
            };
          }),
        final_message: events
          .filter((event) => event.item?.type === "agent_message")
          .at(-1)?.item?.text,
      },
      null,
      2,
    ),
  );
}
