/**
 * Scout — shared types and the single canonical output contract.
 *
 * STRICT RULE (see plan): the scan engine produces exactly ONE data shape —
 * `ScanResult`. `--json` prints it verbatim; the Ink renderer only filters/sorts
 * /abbreviates it for display. No flag changes what the engine computes.
 */

/** How Scout learned about a candidate server. */
export type Source = "port-scan" | "config";

/** MCP transport a server speaks. */
export type Transport = "streamable-http" | "sse" | "stdio";

/**
 * Only connectable servers are ever emitted.
 *  - available     : handshake succeeded, capabilities listed
 *  - auth-required : speaks MCP but needs authentication (401 / OAuth / bearer)
 * Anything else (open-but-not-MCP, declared-but-dead) is a discarded candidate,
 * never a row.
 */
export type Status = "available" | "auth-required";

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ResourceInfo {
  uri: string;
  name?: string;
}

export interface PromptInfo {
  name: string;
  description?: string;
}

export interface ServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

/** One connectable MCP server in the canonical result. */
export interface ServerResult {
  /** URL for http/sse transports; for stdio this is the spawn command string. */
  url: string;
  transport: Transport;
  status: Status;
  latencyMs: number;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  capabilities: ServerCapabilities;
  /** Always fully enumerated by the engine (subject to per-server timeout). */
  tools: ToolInfo[];
  resources: ResourceInfo[];
  prompts: PromptInfo[];
  source: Source;
  /** Human-readable name, derived from serverInfo or the config/stdio label. */
  name: string;
}

/** The single canonical object the engine resolves to and `--json` prints. */
export interface ScanResult {
  scannedAt: string;
  /** The original --host spec (single IP, CIDR, range, or "auto"). */
  target: string;
  scanned: {
    /** Number of hosts scanned (1 for a single host, N for a LAN range). */
    hosts: number;
    /** Distinct ports probed per host. */
    ports: number;
    /** Total open (host, port) pairs found. */
    openPorts: number;
    candidates: number;
  };
  servers: ServerResult[];
}

/* ------------------------------------------------------------------ *
 * Internal pipeline types (not part of the JSON contract)
 * ------------------------------------------------------------------ */

/** A thing worth attempting an MCP handshake against. */
export interface Candidate {
  /** For http/sse: full URL. For stdio: a label; spawn details in `stdio`. */
  url: string;
  transport: Transport | "unknown";
  source: Source;
  /** Display name hint (e.g. config server name). */
  name?: string;
  /** Present for stdio candidates discovered from config. */
  stdio?: { command: string; args?: string[]; env?: Record<string, string> };
}

/** Options that control what the engine scans (NOT how it renders). */
export interface ScanOptions {
  /** Resolved concrete hosts to scan (already expanded from the spec). */
  hosts: string[];
  /** The original spec, kept for display/output (e.g. "192.168.1.0/24"). */
  target: string;
  ports: number[];
  paths: string[];
  includeConfig: boolean;
  extraConfigPaths: string[];
  connectTimeoutMs: number;
  timeoutMs: number;
  portConcurrency: number;
  probeConcurrency: number;
  transport: "auto" | "http" | "sse";
}

/** Events streamed from the engine so renderers can show live progress. */
export type ScanEvent =
  | { type: "phase"; phase: "ports" | "probe"; message: string }
  | { type: "port-open"; host: string; port: number; openCount: number }
  | { type: "candidate"; candidate: Candidate; total: number }
  | { type: "verified"; server: ServerResult }
  | { type: "done"; result: ScanResult };
