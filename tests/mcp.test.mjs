import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp/index.js";
import {
  ContextResultSchema,
  ExpandResultSchema,
  renderResult,
} from "../dist/index.js";
import { tokenCounter } from "../dist/retrieval/budget.js";

async function fixture(t, beforeCleanup) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "mcp-"));
  await cp(resolve("tests/fixtures/basic-project"), root, {
    recursive: true,
    filter: (path) => !path.includes(sep + "cache"),
  });
  t.after(async () => {
    await beforeCleanup?.();
    const rel = relative(parent, root);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const payload = (result) => {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.structuredContent, undefined);
  return JSON.parse(result.content[0].text);
};

test("stdio MCP negotiates three fixed-root tools, preserves one counted payload, and expands stale references", async (t) => {
  const client = new Client({ name: "ctxgate-test", version: "1" });
  const root = await fixture(t, () => client.close());
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "MCP Test");
  git("config", "user.email", "mcp@example.invalid");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  const base = git("rev-parse", "HEAD");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli/index.js"), "mcp", "--root", root],
    stderr: "pipe",
    cwd: root,
  });
  let stderr = "";
  transport.stderr?.on("data", (data) => {
    stderr += data;
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["ctx_check", "ctx_context", "ctx_expand"],
  );
  assert.ok(tools.every((tool) => !tool.inputSchema.properties.root));
  const result = await client.callTool({
      name: "ctx_context",
      arguments: {
        query: "symbol:readSession",
        encoding: "o200k_base",
        budget_tokens: 2000,
      },
    }),
    brief = payload(result);
  ContextResultSchema.parse(brief);
  assert.equal(result.isError, undefined);
  assert.ok(brief.items.length);
  const counter = await tokenCounter("o200k_base");
  assert.equal(brief.budget.count, counter.count(result.content[0].text));
  assert.equal(result.content[0].text, renderResult(brief));
  assert.equal(brief.budget.bytes, Buffer.byteLength(result.content[0].text));
  const reference = brief.items[0].reference;
  const expanded = ExpandResultSchema.parse(
    payload(
      await client.callTool({
        name: "ctx_expand",
        arguments: { reference, budget_tokens: 2000 },
      }),
    ),
  );
  assert.equal(expanded.status, "expanded");
  const path = join(root, reference.path);
  await writeFile(path, (await readFile(path, "utf8")) + "\n// mutation\n");
  const stale = await client.callTool({
    name: "ctx_expand",
    arguments: { reference },
  });
  assert.equal(stale.isError, true);
  assert.equal(payload(stale).status, "stale_reference");
  assert.deepEqual(payload(stale).items, []);
  const invalid = await client.callTool({
    name: "ctx_context",
    arguments: { query: "readSession", root: resolve(".") },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /unrecognized|unknown|invalid/i);
  assert.equal(stderr, "");
  await writeFile(
    join(root, "src/ui/new.ts"),
    'export * from "../db/session";',
  );
  const advisory = await client.callTool({
    name: "ctx_check",
    arguments: { base },
  });
  assert.equal(advisory.isError, undefined);
  assert.equal(payload(advisory).counts.new, 1);
  assert.equal(payload(advisory).mode, "advisory");
  assert.equal(payload(advisory).exit_code, 0);
  const checked = await client.callTool({
    name: "ctx_check",
    arguments: { base: "empty" },
  });
  assert.equal(checked.isError, true);
  assert.equal(payload(checked).exit_code, 2);
  for (const args of [
    { mode: "required" },
    { policy_file: "policy.json" },
    { policy: { schema_version: 1 } },
    { root },
  ])
    assert.equal(
      (await client.callTool({ name: "ctx_check", arguments: args })).isError,
      true,
    );
});

test("MCP validates allowances/unknown fields and handles concurrent requests without prompt logging", async (t) => {
  const root = await fixture(t),
    observations = [],
    server = createMcpServer(root, (event) => observations.push(event)),
    client = new Client({ name: "ctxgate-in-memory-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  for (const args of [
    { query: "x", budget_tokens: 4001 },
    { query: "x", encoding: "invented" },
    { query: "x", neighbors: "yes" },
    { query: "x", unexpected: true },
    { query: "é".repeat(5000) },
  ])
    assert.equal(
      (await client.callTool({ name: "ctx_context", arguments: args })).isError,
      true,
    );
  const results = await Promise.all(
    ["readSession", "path:src/ui/view.ts", "storage"].map((query) =>
      client.callTool({
        name: "ctx_context",
        arguments: { query, budget_tokens: 2000 },
      }),
    ),
  );
  for (const result of results) ContextResultSchema.parse(payload(result));
  assert.equal(observations.length, 3);
  for (const event of observations) {
    assert.equal(event.query, undefined);
    assert.equal(event.excerpt, undefined);
    assert.match(event.request_hash, /^[a-f0-9]{64}$/);
    assert.ok(event.elapsed_ms >= 0);
    assert.ok(event.response_bytes > 0);
  }
  assert.equal(
    payload(
      await client.callTool({
        name: "ctx_context",
        arguments: { query: "qzxvkrpm79426" },
      }),
    ).status,
    "no_match",
  );
});

test("MCP fails before transport startup for uninitialized roots", async (t) => {
  const root = await fixture(t);
  await rm(join(root, ".ctx/config.json"));
  const process = spawnSync(
    globalThis.process.execPath,
    [resolve("dist/cli/index.js"), "mcp", "--root", root],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(process.status, 2);
  assert.equal(process.stdout, "");
  assert.match(process.stderr, /not initialized/);
});
