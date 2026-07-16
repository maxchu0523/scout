/**
 * Shared resolver that turns loosely-typed inputs into a complete `ScanOptions`,
 * applying every engine default. Used by the CLI (`buildScanOptions`) and the
 * UI server, so the two entry points can't drift in how they build a scan.
 *
 * This is the pure core: it does NOT print warnings or exit the process. The
 * CLI wraps it to add flag-specific UX (e.g. the --full / large-range warnings).
 */
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PATHS,
  DEFAULT_PORT_CONCURRENCY,
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
} from "../defaults.js";
import { expandHosts } from "../discovery/hosts.js";
import type { ScanOptions } from "../types.js";
import { DEFAULT_PORTS, parsePorts } from "./pool.js";

export interface RawScanInputs {
  host?: string;
  /** Port spec like "3000,8080" or "1-1024". Ignored when `fullPorts`. */
  ports?: string;
  /** Scan all 65535 ports. */
  fullPorts?: boolean;
  /** Comma-separated endpoint paths. */
  paths?: string;
  includeConfig?: boolean;
  includeAi?: boolean;
  includeOpenApi?: boolean;
  includeManual?: boolean;
  record?: boolean;
  extraConfigPaths?: string[];
  connectTimeoutMs?: number;
  timeoutMs?: number;
  /** Single knob; portConcurrency = this, probeConcurrency = this/10. */
  concurrency?: number;
  transport?: "auto" | "http" | "sse";
}

/** All 1..65535, allocated once per call only when `fullPorts` is set. */
function allPorts(): number[] {
  return Array.from({ length: 65535 }, (_, i) => i + 1);
}

export function resolveScanOptions(i: RawScanInputs): ScanOptions {
  const host = i.host ?? "127.0.0.1";
  const ports = i.fullPorts
    ? allPorts()
    : i.ports
      ? parsePorts(i.ports)
      : DEFAULT_PORTS;

  const paths = (i.paths ?? DEFAULT_PATHS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    hosts: expandHosts(host),
    target: host,
    ports,
    paths,
    includeConfig: i.includeConfig !== false,
    includeAi: i.includeAi !== false,
    includeOpenApi: Boolean(i.includeOpenApi),
    includeManual: i.includeManual !== false,
    record: Boolean(i.record),
    extraConfigPaths: i.extraConfigPaths ?? [],
    connectTimeoutMs: i.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    timeoutMs: i.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    portConcurrency: i.concurrency ?? DEFAULT_PORT_CONCURRENCY,
    probeConcurrency: i.concurrency
      ? Math.max(1, Math.floor(i.concurrency / 10))
      : DEFAULT_PROBE_CONCURRENCY,
    transport: i.transport ?? "auto",
  };
}
