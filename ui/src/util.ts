import type { Service } from "@scout/types";

/** A registry entry as returned by /api/registry (mirrors src/registry/types). */
export interface RegistryEntry {
  id: string;
  kind: "mcp" | "llm-api";
  name: string;
  url: string;
  transport?: string;
  lastSeenAt?: string;
  lastStatus: "available" | "auth-required" | "unreachable";
}

export interface Registry {
  version: number;
  entries: RegistryEntry[];
}

/**
 * Client-side twin of src/util/originKey.ts. Reimplemented (not imported) to
 * keep the UI free of runtime imports from the Node engine — it only shares the
 * type surface. Must stay in sync with the server's scheme.
 */
export function originKey(s: {
  kind: string;
  url: string;
  transport?: string;
}): string {
  if (s.kind === "mcp" && s.transport === "stdio") return `mcp:stdio:${s.url}`;
  return `${s.kind}:${urlHost(s.url)}`;
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The display host bucket for a service (stdio servers group together). */
export function hostOf(s: Service): string {
  if (s.kind === "mcp" && s.transport === "stdio") return "local (stdio)";
  try {
    return new URL(s.url).hostname;
  } catch {
    return s.url;
  }
}

/** "2h ago" / "3d ago" / "just now". */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export interface CountChip {
  label: string;
}

/** The count chip text for a service ("3 tools" / "2 models" / "5 ops"). */
export function countChip(s: Service): string {
  if (s.kind === "mcp") return `${s.tools.length} tools`;
  if (s.kind === "llm-api") return `${s.models.length} models`;
  return `${s.operationCount} ops`;
}

export function kindBadge(s: Service): string {
  if (s.kind === "mcp") return "MCP";
  if (s.kind === "llm-api") return "LLM";
  return "API";
}
