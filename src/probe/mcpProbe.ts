import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Candidate,
  PromptInfo,
  ResourceInfo,
  ServerResult,
  ToolInfo,
  Transport,
} from "../types.js";
import { VERSION } from "../version.js";

const CLIENT_INFO = { name: "scout", version: VERSION };

/**
 * Confirm a candidate is a genuine *auth-gated MCP server* rather than some
 * unrelated HTTP service that happens to reject us (e.g. macOS AirTunes returns
 * a bare 403). Per the MCP auth spec, a real server challenges with HTTP 401 +
 * a `WWW-Authenticate` header. We require exactly that signal.
 */
async function confirmAuthRequired(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
      signal: ctrl.signal,
    });
    return res.status === 401 && res.headers.has("www-authenticate");
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms (${label})`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Build the ordered list of (transport, factory) attempts for a candidate. */
function transportPlan(
  cand: Candidate,
  mode: "auto" | "http" | "sse",
): { transport: Transport; make: () => McpTransport }[] {
  if (cand.transport === "stdio" && cand.stdio) {
    const { command, args, env } = cand.stdio;
    return [
      {
        transport: "stdio",
        make: () =>
          new StdioClientTransport({
            command,
            args,
            env: env ?? (process.env as Record<string, string>),
            // Keep spawned servers' logs off our terminal — stdout must stay
            // pure JSON, and the TUI shouldn't be polluted by child chatter.
            stderr: "ignore",
          }),
      },
    ];
  }

  const url = new URL(cand.url);
  const http = {
    transport: "streamable-http" as Transport,
    make: () => new StreamableHTTPClientTransport(url),
  };
  const sse = {
    transport: "sse" as Transport,
    make: () => new SSEClientTransport(url),
  };

  if (mode === "http") return [http];
  if (mode === "sse") return [sse];
  // auto: try the hinted transport first, then the other as fallback.
  return cand.transport === "sse" ? [sse, http] : [http, sse];
}

async function enumerate(client: Client): Promise<{
  tools: ToolInfo[];
  resources: ResourceInfo[];
  prompts: PromptInfo[];
  caps: { tools: boolean; resources: boolean; prompts: boolean };
}> {
  const serverCaps = client.getServerCapabilities() ?? {};
  const caps = {
    tools: Boolean((serverCaps as Record<string, unknown>).tools),
    resources: Boolean((serverCaps as Record<string, unknown>).resources),
    prompts: Boolean((serverCaps as Record<string, unknown>).prompts),
  };

  let tools: ToolInfo[] = [];
  let resources: ResourceInfo[] = [];
  let prompts: PromptInfo[] = [];

  if (caps.tools) {
    try {
      const r = await client.listTools();
      tools = r.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }));
    } catch {
      /* advertised but failed to list — leave empty */
    }
  }
  if (caps.resources) {
    try {
      const r = await client.listResources();
      resources = r.resources.map((x) => ({ uri: x.uri, name: x.name }));
    } catch {
      /* ignore */
    }
  }
  if (caps.prompts) {
    try {
      const r = await client.listPrompts();
      prompts = r.prompts.map((x) => ({
        name: x.name,
        description: x.description,
      }));
    } catch {
      /* ignore */
    }
  }

  return { tools, resources, prompts, caps };
}

/**
 * Attempt the MCP handshake against one candidate.
 * Returns a ServerResult for connectable servers (`available` /
 * `auth-required`), or null for anything that isn't a reachable MCP server.
 */
/**
 * Connect a `Client` to an MCP target, trying transports per the plan. Shared by
 * the prober and the `scout call` invoke path. Caller is responsible for
 * `client.close()`. Throws if no transport connects.
 */
export async function connectMcpClient(
  target: {
    url: string;
    transport: "auto" | "http" | "sse";
    stdio?: { command: string; args?: string[] };
  },
  timeoutMs: number,
): Promise<Client> {
  const cand: Candidate = target.stdio
    ? {
        url: target.url,
        transport: "stdio",
        source: "port-scan",
        stdio: target.stdio,
      }
    : { url: target.url, transport: "streamable-http", source: "port-scan" };

  let lastErr: unknown;
  for (const attempt of transportPlan(cand, target.transport)) {
    const client = new Client(CLIENT_INFO);
    try {
      await withTimeout(client.connect(attempt.make()), timeoutMs, "connect");
      return client;
    } catch (e) {
      lastErr = e;
      await client.close().catch(() => {});
    }
  }
  throw new Error(
    `could not connect to ${target.url}: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

export async function probeCandidate(
  cand: Candidate,
  opts: { timeoutMs: number; transport: "auto" | "http" | "sse" },
): Promise<ServerResult | null> {
  const plan = transportPlan(cand, opts.transport);

  for (const attempt of plan) {
    const client = new Client(CLIENT_INFO);
    const transport = attempt.make();
    const start = Date.now();
    try {
      await withTimeout(client.connect(transport), opts.timeoutMs, "connect");
      const latencyMs = Date.now() - start;
      const { tools, resources, prompts, caps } = await withTimeout(
        enumerate(client),
        opts.timeoutMs,
        "enumerate",
      );
      const version = client.getServerVersion();
      const protocolVersion = (transport as { protocolVersion?: string })
        .protocolVersion;
      await client.close().catch(() => {});

      return {
        kind: "mcp",
        url: cand.url,
        transport: attempt.transport,
        status: "available",
        latencyMs,
        serverInfo: version
          ? { name: version.name, version: version.version }
          : undefined,
        protocolVersion,
        capabilities: caps,
        tools,
        resources,
        prompts,
        source: cand.source,
        name: version?.name ?? cand.name ?? cand.url,
      };
    } catch {
      await client.close().catch(() => {});
      // try next transport in the plan
    }
  }

  // Handshake failed on all transports. Only call it auth-required if the
  // endpoint gives the spec's genuine MCP auth challenge (401 + WWW-Authenticate);
  // stdio has no such concept and a bare 403 (e.g. AirTunes) is just "not MCP".
  if (cand.transport !== "stdio") {
    const authed = await confirmAuthRequired(cand.url, opts.timeoutMs);
    if (authed) {
      return {
        kind: "mcp",
        url: cand.url,
        transport: cand.transport === "sse" ? "sse" : "streamable-http",
        status: "auth-required",
        latencyMs: 0,
        capabilities: { tools: false, resources: false, prompts: false },
        tools: [],
        resources: [],
        prompts: [],
        source: cand.source,
        name: cand.name ?? cand.url,
      };
    }
  }

  return null;
}
