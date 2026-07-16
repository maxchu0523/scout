import { discoverFromConfig } from "./discovery/config.js";
import { buildEndpointCandidates } from "./discovery/endpoints.js";
import { type HostPort, scanHostPorts } from "./discovery/portScan.js";
import { probeAiService } from "./probe/aiProbe.js";
import { probeCandidate } from "./probe/mcpProbe.js";
import { probeOpenApi } from "./probe/openApiProbe.js";
import type {
  Candidate,
  ScanEvent,
  ScanOptions,
  ScanResult,
  Service,
} from "./types.js";
import { originKey, urlHost } from "./util/originKey.js";
import { mapPool } from "./util/pool.js";

/** Prefer an available result over auth-required; otherwise lower latency. */
function better(a: Service, b: Service): Service {
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
  // 1. Port sweep across every (host, port) pair ----------------------------
  const hostLabel =
    opts.hosts.length === 1 ? opts.target : `${opts.hosts.length} hosts`;
  onEvent({
    type: "phase",
    phase: "ports",
    message: `Sweeping ${opts.ports.length} ports on ${hostLabel}`,
  });
  const pairs: HostPort[] = opts.hosts.flatMap((host) =>
    opts.ports.map((port) => ({ host, port })),
  );
  const openPairs = await scanHostPorts(
    pairs,
    opts.connectTimeoutMs,
    opts.portConcurrency,
    (hp, openCount) =>
      onEvent({ type: "port-open", host: hp.host, port: hp.port, openCount }),
  );

  // 2. Build candidates (port-scan endpoints + config-declared servers) ------
  const openByHost = new Map<string, number[]>();
  for (const { host, port } of openPairs) {
    const list = openByHost.get(host) ?? [];
    list.push(port);
    openByHost.set(host, list);
  }
  const candidates: Candidate[] = [];
  for (const [host, ports] of openByHost) {
    candidates.push(...buildEndpointCandidates(host, ports, opts.paths));
  }
  // Explicit --config-file paths are always read; --no-config only suppresses
  // the auto-discovered known locations.
  if (opts.includeConfig || opts.extraConfigPaths.length > 0) {
    candidates.push(
      ...(await discoverFromConfig(opts.extraConfigPaths, opts.includeConfig)),
    );
  }
  // Manual registry entries join the scan as candidates / extra AI targets.
  // Lazy import keeps the registry store off the hot path when disabled.
  let manualAiTargets: { host: string; port: number }[] = [];
  let probedIds = new Set<string>();
  if (opts.includeManual) {
    const { manualWork } = await import("./registry/sync.js");
    const work = await manualWork();
    candidates.push(...work.candidates);
    manualAiTargets = work.aiTargets;
    probedIds = work.probedIds;
  }
  candidates.forEach((candidate, i) => {
    onEvent({ type: "candidate", candidate, total: i + 1 });
  });

  // 3. Probe — MCP candidates + (by default) an AI fingerprint per open port -
  onEvent({
    type: "phase",
    phase: "probe",
    message: `Probing ${candidates.length} candidates`,
  });
  const byOrigin = new Map<string, Service>();
  const record = (result: Service | null) => {
    if (!result) return;
    const key = originKey(result);
    const existing = byOrigin.get(key);
    const winner = existing ? better(existing, result) : result;
    byOrigin.set(key, winner);
    if (!existing) onEvent({ type: "verified", service: winner });
  };

  const mcpWork = mapPool(candidates, opts.probeConcurrency, async (cand) =>
    record(
      await probeCandidate(cand, {
        timeoutMs: opts.timeoutMs,
        transport: opts.transport,
      }),
    ),
  );
  const aiWork = opts.includeAi
    ? mapPool(openPairs, opts.probeConcurrency, async (hp) =>
        record(
          await probeAiService(hp.host, hp.port, { timeoutMs: opts.timeoutMs }),
        ),
      )
    : Promise.resolve([]);
  const openApiWork = opts.includeOpenApi
    ? mapPool(openPairs, opts.probeConcurrency, async (hp) =>
        record(
          await probeOpenApi(hp.host, hp.port, { timeoutMs: opts.timeoutMs }),
        ),
      )
    : Promise.resolve([]);
  // Manual llm-api entries may point at hosts the port sweep never touched.
  // probeAiService stamps source "port-scan"; re-stamp as "manual" since these
  // targets came from the registry, not the sweep.
  const manualAiWork = mapPool(
    manualAiTargets,
    opts.probeConcurrency,
    async (hp) => {
      const svc = await probeAiService(hp.host, hp.port, {
        timeoutMs: opts.timeoutMs,
      });
      if (svc) svc.source = "manual";
      record(svc);
    },
  );
  await Promise.all([mcpWork, aiWork, openApiWork, manualAiWork]);

  // 4. Assemble canonical result --------------------------------------------
  // An OpenAPI match is the weakest identification: when the same origin was
  // verified as MCP or an AI API (e.g. vLLM serves both /v1/models and
  // /openapi.json), the stronger result wins and the openapi row is dropped.
  const all = [...byOrigin.values()];
  const claimed = new Set(all.filter((s) => s.kind !== "openapi").map(urlHost));
  const services = all
    .filter((s) => s.kind !== "openapi" || !claimed.has(urlHost(s)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const result: ScanResult = {
    scannedAt: new Date().toISOString(),
    target: opts.target,
    scanned: {
      hosts: opts.hosts.length,
      ports: opts.ports.length,
      openPorts: openPairs.length,
      candidates: candidates.length,
    },
    services,
  };

  // 5. Reconcile with the registry (best-effort, never fatal to the scan) -----
  if (opts.includeManual || opts.record) {
    const { syncScanToRegistry } = await import("./registry/sync.js");
    await syncScanToRegistry(
      result,
      { record: opts.record, probedIds },
      result.scannedAt,
    );
  }

  onEvent({ type: "done", result });
  return result;
}
