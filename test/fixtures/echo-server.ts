// Minimal stdio MCP server used by call.test.ts (hermetic — no network).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo back the message",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `Echo: ${message}` }],
  }),
);

await server.connect(new StdioServerTransport());
