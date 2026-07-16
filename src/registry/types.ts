/**
 * Registry types — deliberately NOT part of the scan contract (src/types.ts).
 * The registry remembers services across scans, including their staleness,
 * which the two-status scan contract forbids in `scout scan` output.
 */
import type { AiApi, Status, Transport } from "../types.js";

/** A registry entry can be reachable, gated, or (uniquely to the registry) stale. */
export type RegistryStatus = Status | "unreachable";

/** How the entry entered the registry. */
export type AddedBy = "manual" | "scan";

/** One remembered service. mcp/llm-api only — openapi services are transient. */
export interface RegistryEntry {
  /** originKey of the service — the stable identity across scans. */
  id: string;
  kind: "mcp" | "llm-api";
  name: string;
  /** URL for http/sse; the spawn command label for stdio. */
  url: string;
  /** mcp only. */
  transport?: Transport;
  /** llm-api only. */
  api?: AiApi;
  /** stdio mcp only. */
  stdio?: { command: string; args?: string[]; env?: Record<string, string> };
  addedAt: string;
  addedBy: AddedBy;
  firstSeenAt: string;
  /** Omitted when the entry has never been reached (added with --force). */
  lastSeenAt?: string;
  lastStatus: RegistryStatus;
  notes?: string;
}

export interface Registry {
  version: 1;
  entries: RegistryEntry[];
}
