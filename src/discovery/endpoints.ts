import type { Candidate } from "../types.js";

const TLS_PORTS = new Set([443, 8443]);

/**
 * Build MCP handshake candidates from open ports × probe paths.
 *
 * A path ending in `/sse` is hinted as the legacy SSE transport; everything
 * else is hinted as streamable-http. The hint only orders which transport the
 * prober tries first — `auto` mode still falls back to the other.
 */
export function buildEndpointCandidates(
  host: string,
  openPorts: number[],
  paths: string[],
): Candidate[] {
  // URLs want bracketed IPv6 literals.
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  const candidates: Candidate[] = [];

  for (const port of openPorts) {
    const scheme = TLS_PORTS.has(port) ? "https" : "http";
    for (const rawPath of paths) {
      const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      const url = `${scheme}://${hostForUrl}:${port}${path === "/" ? "" : path}`;
      candidates.push({
        url: url || `${scheme}://${hostForUrl}:${port}/`,
        transport: path.endsWith("/sse") ? "sse" : "streamable-http",
        source: "port-scan",
      });
    }
  }
  return candidates;
}
