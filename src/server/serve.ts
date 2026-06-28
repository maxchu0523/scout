import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { expandHosts } from "../discovery/hosts.js";
import { probeCandidate } from "../probe/mcpProbe.js";
import { runScan } from "../scan.js";
import type { ScanOptions, Transport } from "../types.js";
import { DEFAULT_PORTS, parsePorts } from "../util/pool.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Scout discovers and verifies MCP servers you can connect to right now.
Call list_available_mcps to scan for connectable servers (localhost by default,
or a host/CIDR/range), then connect to whichever one provides the tools you need.
Use probe_mcp to verify a single known URL.`;

/** Build engine options from tool arguments (no rendering concerns here). */
function scanOptionsFrom(args: {
  host?: string;
  ports?: string;
  includeConfig?: boolean;
  timeoutMs?: number;
}): ScanOptions {
  const host = args.host ?? "127.0.0.1";
  return {
    hosts: expandHosts(host),
    target: host,
    ports: args.ports ? parsePorts(args.ports) : DEFAULT_PORTS,
    paths: ["/mcp", "/sse", "/message", "/"],
    includeConfig: args.includeConfig !== false,
    includeAi: true,
    extraConfigPaths: [],
    connectTimeoutMs: 300,
    timeoutMs: args.timeoutMs ?? 3000,
    portConcurrency: 200,
    probeConcurrency: 20,
    transport: "auto",
  };
}

function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Run Scout as an MCP server over stdio. This closes the loop on Scout's
 * purpose: an agent discovers other MCP servers through the very protocol it
 * already speaks, then connects to them — no shell-out, no config parsing.
 *
 * Add to a client (e.g. Claude Code) as a stdio server:
 *   { "scout": { "command": "scout", "args": ["serve"] } }
 */
export async function serveMcp(): Promise<void> {
  const server = new McpServer(
    { name: "scout", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_available_mcps",
    {
      title: "List available MCP servers",
      description:
        "Scan for connectable MCP servers and return each one's transport, " +
        "status (available / auth-required), and the tools it exposes. " +
        "Scans localhost by default; pass a host, CIDR, or range to scan more.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe("IP, hostname, CIDR, range, or 'auto'. Default 127.0.0.1"),
        ports: z
          .string()
          .optional()
          .describe(
            "Port spec, e.g. '3000,8080' or '1-1024'. Default: common ports",
          ),
        includeConfig: z
          .boolean()
          .optional()
          .describe(
            "Also read local client configs for stdio servers. Default true",
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe("Per-server handshake timeout in ms. Default 3000"),
      },
    },
    async (args) => {
      const result = await runScan(scanOptionsFrom(args));
      const servers = result.services.filter((s) => s.kind === "mcp");
      return jsonContent({ ...result, services: servers });
    },
  );

  server.registerTool(
    "list_ai_services",
    {
      title: "List available local AI API services",
      description:
        "Scan for local AI inference APIs (LM Studio, Ollama, vLLM, llama.cpp, " +
        "…) and return each one's api type, status, and available models.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe("IP, hostname, CIDR, range, or 'auto'. Default 127.0.0.1"),
        ports: z
          .string()
          .optional()
          .describe("Port spec, e.g. '1234,11434'. Default: common ports"),
        timeoutMs: z
          .number()
          .optional()
          .describe("Per-service timeout in ms. Default 3000"),
      },
    },
    async (args) => {
      const result = await runScan({
        ...scanOptionsFrom(args),
        includeConfig: false,
      });
      const ai = result.services.filter((s) => s.kind === "llm-api");
      return jsonContent({ ...result, services: ai });
    },
  );

  server.registerTool(
    "probe_mcp",
    {
      title: "Probe a single MCP URL",
      description:
        "Verify one explicit URL: run the MCP handshake and return its status " +
        "and capabilities, or null if it is not a reachable MCP server.",
      inputSchema: {
        url: z.string().describe("Full URL, e.g. http://127.0.0.1:3001/mcp"),
        transport: z
          .enum(["auto", "http", "sse"])
          .optional()
          .describe("Force a transport. Default auto (http then sse)"),
        timeoutMs: z
          .number()
          .optional()
          .describe("Handshake timeout. Default 5000"),
      },
    },
    async ({ url, transport, timeoutMs }) => {
      const hint: Transport =
        transport === "sse" || url.endsWith("/sse") ? "sse" : "streamable-http";
      const result = await probeCandidate(
        { url, transport: hint, source: "port-scan" },
        { timeoutMs: timeoutMs ?? 5000, transport: transport ?? "auto" },
      );
      return jsonContent(result);
    },
  );

  // stdio is how MCP clients spawn local servers; stdout carries the protocol,
  // so nothing else may write to it (our engine only emits via callbacks).
  await server.connect(new StdioServerTransport());
}
