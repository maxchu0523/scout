import { discoverFromConfig } from "./discovery/config.js";
import { buildEndpointCandidates } from "./discovery/endpoints.js";
import { scanPorts } from "./discovery/portScan.js";
import { probeCandidate } from "./probe/mcpProbe.js";
import type {
  Candidate,
  ScanEvent,
  ScanOptions,
  ScanResult,
  ServerResult,
} from "./types.js";
import { mapPool } from "./util/pool.js";

/** Origin key used to collapse the same server reached via multiple paths. */
function originKey(r: ServerResult): string {
  if (r.transport === "stdio") return `stdio:${r.url}`;
  try {
    return `net:${new URL(r.url).host}`;
  } catch {
    return `net:${r.url}`;
  }
}

/** Prefer an available result over auth-required; otherwise lower latency. */
function better(a: ServerResult, b: ServerResult): ServerResult {
  if (a.status !== b.status) return a.status === "available" ? a : b;
  return a.latencyMs <= b.latencyMs ? a : b;
}

/**
 * The one and only scan engine. Produces the canonical ScanResult and streams
 * progress via `onEvent`. No option here changes the SHAPE of the output —
 * targeting options change WHICH servers are found, never the schema.
 */
export async function runScan(
  opts: ScanOptions,
  onEvent: (e: ScanEvent) => void = () => {},
): Promise<ScanResult> {
  // 1. Port sweep -----------------------------------------------------------
  onEvent({
    type: "phase",
    phase: "ports",
    message: `Sweeping ${opts.ports.length} ports on ${opts.host}`,
  });
  const openPorts = await scanPorts(
    opts.host,
    opts.ports,
    opts.connectTimeoutMs,
    opts.portConcurrency,
    (port, openCount) => onEvent({ type: "port-open", port, openCount }),
  );

  // 2. Build candidates (port-scan endpoints + config-declared servers) ------
  const candidates: Candidate[] = buildEndpointCandidates(
    opts.host,
    openPorts,
    opts.paths,
  );
  // Explicit --config-file paths are always read; --no-config only suppresses
  // the auto-discovered known locations.
  if (opts.includeConfig || opts.extraConfigPaths.length > 0) {
    candidates.push(
      ...(await discoverFromConfig(opts.extraConfigPaths, opts.includeConfig)),
    );
  }
  candidates.forEach((candidate, i) => {
    onEvent({ type: "candidate", candidate, total: i + 1 });
  });

  // 3. Probe every candidate; keep only connectable MCP servers --------------
  onEvent({
    type: "phase",
    phase: "probe",
    message: `Probing ${candidates.length} candidates`,
  });
  const byOrigin = new Map<string, ServerResult>();
  await mapPool(candidates, opts.probeConcurrency, async (cand) => {
    const result = await probeCandidate(cand, {
      timeoutMs: opts.timeoutMs,
      transport: opts.transport,
    });
    if (!result) return;
    const key = originKey(result);
    const existing = byOrigin.get(key);
    const winner = existing ? better(existing, result) : result;
    byOrigin.set(key, winner);
    if (!existing) onEvent({ type: "verified", server: winner });
  });

  // 4. Assemble canonical result --------------------------------------------
  const servers = [...byOrigin.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const result: ScanResult = {
    scannedAt: new Date().toISOString(),
    host: opts.host,
    scanned: {
      ports: opts.ports.length,
      openPorts: openPorts.length,
      candidates: candidates.length,
    },
    servers,
  };
  onEvent({ type: "done", result });
  return result;
}
