import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Low-level `Server` (not `McpServer`) is intentional: a transparent proxy needs
// setRequestHandler to forward arbitrary requests verbatim — the SDK's documented
// "advanced use case" for this class.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectMcpClient } from "../probe/mcpProbe.js";
import { VERSION } from "../version.js";

export interface ExposeOptions {
  /** stdio command line, e.g. "npx -y some-mcp". */
  command: string;
  host: string;
  /** 0 → ephemeral. */
  port: number;
  /** Disable the bearer token (loopback only — the CLI enforces that). */
  noAuth: boolean;
  /** Exposed server name (defaults to the upstream's name). */
  name?: string;
}

export interface ExposeHandle {
  url: string;
  port: number;
  token?: string;
  close: () => Promise<void>;
}

/** Read and JSON-parse a request body (empty body → undefined). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Run a local stdio MCP server and re-publish it as a streamable-HTTP MCP
 * server, so network scans can find it and remote agents can call it. Every
 * downstream call is forwarded verbatim to the upstream and its result returned
 * verbatim. Returns once the HTTP server is listening.
 */
export async function startExpose(opts: ExposeOptions): Promise<ExposeHandle> {
  const parts = opts.command.split(" ").filter(Boolean);
  const upstream = await connectMcpClient(
    {
      url: opts.command,
      transport: "auto",
      stdio: { command: parts[0], args: parts.slice(1) },
    },
    15000,
  );

  const info = upstream.getServerVersion();
  const caps = upstream.getServerCapabilities() ?? {};
  const name = opts.name ?? info?.name ?? "exposed-mcp";
  const version = info?.version ?? VERSION;

  const token = opts.noAuth ? undefined : randomBytes(32).toString("hex");

  const http = createServer((req, res) => {
    // Auth: a missing/incorrect bearer token yields exactly the strict signal
    // (401 + WWW-Authenticate) that Scout's own prober treats as auth-required.
    if (token) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, {
          "www-authenticate": 'Bearer realm="scout-expose"',
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    void handleMcp(req, res, upstream, caps, name, version);
  });

  // Kill the upstream child if the downstream server dies.
  const closeUpstream = () => upstream.close().catch(() => {});
  http.on("close", closeUpstream);

  const port = await listen(http, opts.port, opts.host);
  return {
    url: `http://${opts.host}:${port}/mcp`,
    port,
    token,
    close: async () => {
      await new Promise<void>((r) => http.close(() => r()));
      await closeUpstream();
    },
  };
}

/**
 * Build a proxy Server that forwards each advertised capability to `upstream`
 * verbatim. A fresh one is created per HTTP request (stateless transport mode),
 * all sharing the single long-lived upstream client.
 */
function buildProxyServer(
  upstream: Client,
  caps: ServerCapabilities,
  name: string,
  version: string,
): Server {
  const server = new Server({ name, version }, { capabilities: caps });
  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, () =>
      upstream.listTools(),
    );
    server.setRequestHandler(CallToolRequestSchema, (req) =>
      upstream.callTool(req.params),
    );
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, () =>
      upstream.listResources(),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (req) =>
      upstream.readResource(req.params),
    );
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, () =>
      upstream.listPrompts(),
    );
    server.setRequestHandler(GetPromptRequestSchema, (req) =>
      upstream.getPrompt(req.params),
    );
  }
  return server;
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: Client,
  caps: ServerCapabilities,
  name: string,
  version: string,
): Promise<void> {
  // Stateless: one fresh proxy server + transport per request, torn down after.
  const server = buildProxyServer(upstream, caps, name, version);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  const body = req.method === "POST" ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, body);
}

function listen(
  http: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.removeListener("error", reject);
      resolve((http.address() as { port: number }).port);
    });
  });
}
