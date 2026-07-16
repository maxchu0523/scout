import type { Transport } from "../types.js";

/** The minimal identity a thing needs to be keyed — a Service or a registry entry. */
export interface Identifiable {
  kind: "mcp" | "llm-api" | "openapi";
  /** URL for http/sse; the spawn command label for stdio. */
  url: string;
  transport?: Transport;
}

/**
 * Origin key used to collapse the same service reached via multiple paths, and
 * to match a scanned service against a stored registry entry. One scheme shared
 * by the scan engine, the registry, and diff:
 *   - stdio MCP  → `mcp:stdio:<command label>`
 *   - everything → `<kind>:<host:port>`
 */
export function originKey(s: Identifiable): string {
  if (s.kind === "mcp" && s.transport === "stdio") return `mcp:stdio:${s.url}`;
  return `${s.kind}:${urlHost(s)}`;
}

/** host:port of a service URL (the URL itself for stdio / unparseable labels). */
export function urlHost(s: Pick<Identifiable, "url">): string {
  try {
    return new URL(s.url).host;
  } catch {
    return s.url;
  }
}
