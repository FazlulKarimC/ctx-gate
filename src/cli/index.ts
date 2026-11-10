#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { initialize } from "../workspace/initialize.js";
import { doctor } from "./doctor.js";
import { refreshIndex } from "../indexer.js";
import { check, renderCheck } from "../checker/index.js";
import {
  context,
  expand,
  renderResult,
  type BudgetOptions,
  type Encoding,
  type LexicalVariant,
} from "../retrieval/index.js";

try {
  const { values, positionals } = parseArgs({
    options: {
      root: { type: "string" },
      base: { type: "string" },
      target: { type: "string" },
      "policy-ref": { type: "string" },
      "policy-file": { type: "string" },
      mode: { type: "string" },
      "page-size": { type: "string" },
      cursor: { type: "string" },
      json: { type: "boolean" },
      query: { type: "string" },
      "lexical-version": { type: "string" },
      neighbors: { type: "boolean" },
      notes: { type: "boolean" },
      ref: { type: "string" },
      budget: { type: "string" },
      remaining: { type: "string" },
      encoding: { type: "string" },
      "max-bytes": { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "ctxgate <init|doctor|index|context|expand|check|mcp> [--root <directory>] [--json]\ncontext --query <text> [--neighbors] [--notes] [--lexical-version v1|v2] [--budget 2000] [--encoding estimate|cl100k_base|o200k_base]\nexpand --ref <reference-JSON> [--notes] [--budget 1000] [--before 20] [--after 20]\ncheck [--base <full-SHA|empty>] [--target <full-SHA|worktree>] [--policy-ref <trusted-full-SHA>] [--policy-file <trusted-JSON>] [--mode advisory|required] [--page-size 20] [--cursor <JSON>] [--max-bytes 16384]\nmcp --root <initialized-repository>: stdio ctx_context/ctx_expand/ctx_check, fixed root.\nCheck emits compact JSON. Exit: 0 acceptable, 1 new violations in required mode, 2 incomplete/invalid.",
    );
  } else {
    if (positionals.length !== 1)
      throw new Error("Unexpected positional arguments");
    const root = resolve(values.root ?? process.cwd());
    if (command === "mcp") {
      const { serveMcp } = await import("../mcp/index.js");
      await serveMcp(root);
    } else if (command === "check") {
      const options = Object.fromEntries(
        Object.entries({
          base: values.base,
          target: values.target,
          policy_ref: values["policy-ref"],
          policy_file: values["policy-file"],
          mode: values.mode,
          page_size:
            values["page-size"] === undefined
              ? undefined
              : Number(values["page-size"]),
          max_bytes:
            values["max-bytes"] === undefined
              ? undefined
              : Number(values["max-bytes"]),
          cursor:
            values.cursor === undefined ? undefined : JSON.parse(values.cursor),
        }).filter(([, value]) => value !== undefined),
      );
      const result = check(root, options);
      process.stdout.write(renderCheck(result));
      process.exitCode = result.exit_code;
    } else {
      const budget: BudgetOptions = {};
      if (values.budget !== undefined)
        budget.budget_tokens = Number(values.budget);
      if (values.remaining !== undefined)
        budget.remaining_tokens = Number(values.remaining);
      if (values.encoding !== undefined)
        budget.encoding = values.encoding as Encoding;
      if (values["max-bytes"] !== undefined)
        budget.max_bytes = Number(values["max-bytes"]);
      const result =
        command === "init"
          ? await initialize(root)
          : command === "doctor"
            ? await doctor(root)
            : command === "index"
              ? refreshIndex(root)
              : command === "context"
                ? await context(root, values.query ?? "", {
                    ...budget,
                    neighbors: values.neighbors ?? false,
                    notes: values.notes ?? false,
                    ...(values["lexical-version"] === undefined
                      ? {}
                      : {
                          lexical_version: values[
                            "lexical-version"
                          ] as LexicalVariant,
                        }),
                  })
                : command === "expand"
                  ? await expand(root, JSON.parse(values.ref ?? "null"), {
                      ...budget,
                      notes: values.notes ?? false,
                      ...(values.before === undefined
                        ? {}
                        : { before: Number(values.before) }),
                      ...(values.after === undefined
                        ? {}
                        : { after: Number(values.after) }),
                    })
                  : null;
      if (!result)
        throw new Error(
          `Unsupported command: ${command}. Available: init, doctor, index, context, expand, check, mcp`,
        );
      if (result.operation === "context" || result.operation === "expand")
        process.stdout.write(renderResult(result));
      else
        console.log(
          values.json
            ? JSON.stringify(result)
            : JSON.stringify(result, null, 2),
        );
      if (result.status === "unavailable" || result.status === "incomplete")
        process.exitCode = 2;
      if (
        (result.operation === "context" &&
          result.status === "budget_too_small") ||
        (result.operation === "expand" && result.status !== "expanded")
      )
        process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      schema_version: 1,
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
