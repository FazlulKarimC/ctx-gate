// Explicit research tracing only. Product `ctxgate mcp` does not persist telemetry.
import { appendFileSync } from "node:fs";
import { createMcpServer } from "../../dist/mcp/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const [root, trace] = process.argv.slice(2);
if (!root || !trace)
  throw Error("Bound root and private research trace path required");
const server = createMcpServer(root, (event) =>
  appendFileSync(trace, JSON.stringify(event) + "\n"),
);
await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 65536,
  }),
);
