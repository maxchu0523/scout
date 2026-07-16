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

/** Max models per service to fetch per-model detail for (Ollama /api/show). */
export const DEFAULT_MODEL_DETAIL_LIMIT = 8;

/** Seconds between sweeps for `scout watch`. */
export const DEFAULT_WATCH_INTERVAL_S = 60;

/** Minimum allowed `scout watch --interval` (guards against a hot loop). */
export const MIN_WATCH_INTERVAL_S = 5;

/** Preferred port for the `scout ui` dashboard (falls back to ephemeral). */
export const DEFAULT_UI_PORT = 7777;
