import { DEFAULT_PROBE_CONCURRENCY, DEFAULT_TIMEOUT_MS } from "../defaults.js";
import { probeAiService } from "../probe/aiProbe.js";
import { probeCandidate } from "../probe/mcpProbe.js";
import type { Candidate, Service, Transport } from "../types.js";
import { originKey } from "../util/originKey.js";
import { mapPool } from "../util/pool.js";
import { loadRegistry, saveRegistry, upsertEntry } from "./store.js";
import type { Registry, RegistryEntry, RegistryStatus } from "./types.js";

// Re-exported so command wiring imports registry helpers from one module.
export { loadRegistry } from "./store.js";

/** Build a registry entry from a freshly verified service. */
export function entryFromService(
  service: Service,
  addedBy: "manual" | "scan",
  now: string,
  notes?: string,
): RegistryEntry {
  const base = {
    id: originKey(service),
    name: service.name,
    url: service.url,
    addedAt: now,
    addedBy,
    firstSeenAt: now,
    lastSeenAt: now,
    lastStatus: service.status,
    notes,
  };
  if (service.kind === "mcp") {
    return { ...base, kind: "mcp", transport: service.transport };
  }
  if (service.kind === "llm-api") {
    return { ...base, kind: "llm-api", api: service.api };
  }
  // openapi services are transient and never stored; callers must filter them.
  throw new Error("openapi services cannot be stored in the registry");
}

/**
 * Verify a URL as MCP first, then (if that misses) as a local AI API, so any
 * connectable service can be remembered — not just MCP servers. Returns the
 * verified service with source "manual", or null.
 */
async function probeUrl(
  url: string,
  transport: "auto" | "http" | "sse",
): Promise<Service | null> {
  const hint: Transport =
    transport === "sse" || url.endsWith("/sse") ? "sse" : "streamable-http";
  const mcp = await probeCandidate(
    { url, transport: hint, source: "manual" },
    { timeoutMs: DEFAULT_TIMEOUT_MS, transport },
  );
  if (mcp) return mcp;

  // Fall back to an AI fingerprint (Ollama / LM Studio / ComfyUI / …).
  try {
    const u = new URL(url);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const ai = await probeAiService(u.hostname, port, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (ai) ai.source = "manual";
    return ai;
  } catch {
    return null;
  }
}

export interface AddOptions {
  url?: string;
  stdio?: string;
  name?: string;
  transport?: "auto" | "http" | "sse";
  force?: boolean;
  notes?: string;
  now: string;
}

export interface AddResult {
  entry: RegistryEntry;
  verified: boolean;
}

/**
 * Verify then remember a service. Returns the stored entry. Throws if the probe
 * fails and `force` is not set (the CLI maps that to exit 1).
 */
export async function addServer(opts: AddOptions): Promise<AddResult> {
  let service: Service | null = null;
  let label: string;
  let candidate: Candidate;

  if (opts.stdio) {
    const parts = opts.stdio.split(" ").filter(Boolean);
    candidate = {
      url: opts.stdio,
      transport: "stdio",
      source: "manual",
      name: opts.name,
      stdio: { command: parts[0], args: parts.slice(1) },
    };
    label = opts.name ?? opts.stdio;
    service = await probeCandidate(candidate, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      transport: "auto",
    });
  } else if (opts.url) {
    label = opts.name ?? opts.url;
    service = await probeUrl(opts.url, opts.transport ?? "auto");
  } else {
    throw new Error("add requires a <url> or --stdio <command>");
  }

  const reg = await loadRegistry();

  if (service) {
    const entry = entryFromService(service, "manual", opts.now, opts.notes);
    if (opts.name) entry.name = opts.name;
    await saveRegistry(upsertEntry(reg, entry));
    return { entry, verified: true };
  }

  if (!opts.force) {
    throw new Error(
      `${label} is not reachable — pass --force to store it anyway`,
    );
  }

  // Forced store of an unreachable service. Preserve stdio spawn details.
  const isStdio = Boolean(opts.stdio);
  const url = opts.stdio ?? opts.url ?? "";
  const transport: Transport = isStdio ? "stdio" : "streamable-http";
  const tokens = url.split(" ").filter(Boolean);
  const entry: RegistryEntry = {
    id: originKey({ kind: "mcp", url, transport }),
    kind: "mcp",
    name: opts.name ?? url,
    url,
    transport,
    stdio: isStdio ? { command: tokens[0], args: tokens.slice(1) } : undefined,
    addedAt: opts.now,
    addedBy: "manual",
    firstSeenAt: opts.now,
    lastStatus: "unreachable",
    notes: opts.notes,
  };
  await saveRegistry(upsertEntry(reg, entry));
  return { entry, verified: false };
}

/** Remove by exact id, else exact url, else exact name. Throws if ambiguous. */
export async function removeServer(selector: string): Promise<RegistryEntry> {
  const reg = await loadRegistry();
  const byId = reg.entries.filter((e) => e.id === selector);
  const byUrl = reg.entries.filter((e) => e.url === selector);
  const byName = reg.entries.filter((e) => e.name === selector);
  let matches = byName;
  if (byId.length > 0) matches = byId;
  else if (byUrl.length > 0) matches = byUrl;

  if (matches.length === 0)
    throw new Error(`no registry entry matches "${selector}"`);
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    throw new Error(`"${selector}" is ambiguous — matches ${ids}`);
  }
  const removed = matches[0];
  await saveRegistry({
    ...reg,
    entries: reg.entries.filter((e) => e.id !== removed.id),
  });
  return removed;
}

/** Re-probe every entry and update lastStatus/lastSeenAt in the file. */
export async function verifyEntries(now: string): Promise<Registry> {
  const reg = await loadRegistry();
  const updated = await mapPool(
    reg.entries,
    DEFAULT_PROBE_CONCURRENCY,
    async (e) => {
      const service = await reprobeEntry(e);
      if (service) {
        return { ...e, lastStatus: service.status, lastSeenAt: now };
      }
      const unreachable: RegistryStatus = "unreachable";
      return { ...e, lastStatus: unreachable };
    },
  );
  const next: Registry = { ...reg, entries: updated };
  await saveRegistry(next);
  return next;
}

/** Re-probe a single entry by its kind. */
function reprobeEntry(e: RegistryEntry): Promise<Service | null> {
  if (e.kind === "llm-api") {
    try {
      const u = new URL(e.url);
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      return probeAiService(u.hostname, port, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch {
      return Promise.resolve(null);
    }
  }
  if (e.transport === "stdio") {
    return probeCandidate(
      {
        url: e.url,
        transport: "stdio",
        source: "manual",
        name: e.name,
        stdio: e.stdio ?? { command: e.url.split(" ")[0] },
      },
      { timeoutMs: DEFAULT_TIMEOUT_MS, transport: "auto" },
    );
  }
  return probeUrl(e.url, "auto");
}

/** "2h ago" / "3d ago" / "just now" from an ISO timestamp relative to `now`. */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const GLYPH: Record<RegistryStatus, string> = {
  available: "✓",
  "auth-required": "🔒",
  unreachable: "✗",
};

/** Render the registry as one human line per entry. */
export function formatList(reg: Registry, now: number): string {
  if (reg.entries.length === 0) return "registry is empty";
  return reg.entries
    .map((e) => {
      const seen = relativeTime(e.lastSeenAt, now);
      return `${GLYPH[e.lastStatus]} ${e.name}  [${e.kind}]  ${e.url}  (${seen})`;
    })
    .join("\n");
}
