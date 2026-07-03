/**
 * Engine defaults shared by every entry point (CLI flags and `scout serve`
 * tool arguments), so the two can't silently drift apart.
 */

/** Endpoint paths probed on each open port. */
export const DEFAULT_PATHS = ["/mcp", "/sse", "/message", "/"];

/** TCP connect timeout for the port sweep. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 300;

/** Per-server MCP handshake / AI fingerprint timeout. */
export const DEFAULT_TIMEOUT_MS = 3000;

/** Parallelism of the raw port sweep. */
export const DEFAULT_PORT_CONCURRENCY = 200;

/** Parallelism of the (heavier) handshake/fingerprint probes. */
export const DEFAULT_PROBE_CONCURRENCY = 20;
