import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candidate, ScanResult, Service } from "../types.js";
import { originKey } from "../util/originKey.js";
import { entryFromService } from "./commands.js";
import {
  loadRegistry,
  registryPath,
  saveRegistry,
  scoutHome,
  upsertEntry,
} from "./store.js";
import type { RegistryStatus } from "./types.js";

/** An llm-api target extracted from a manual registry entry's URL. */
export interface AiTarget {
  host: string;
  port: number;
}

export interface ManualWork {
  candidates: Candidate[];
  aiTargets: AiTarget[];
  /** originKeys of every manual entry probed this scan (for write-back). */
  probedIds: Set<string>;
}

/**
 * Turn manual registry entries into scan work: MCP entries become candidates,
 * llm-api entries become host:port AI probe targets. Returns empty work if the
 * registry is absent/empty.
 */
export async function manualWork(): Promise<ManualWork> {
  const reg = await loadRegistry();
  const candidates: Candidate[] = [];
  const aiTargets: AiTarget[] = [];
  const probedIds = new Set<string>();

  for (const e of reg.entries) {
    probedIds.add(e.id);
    if (e.kind === "mcp") {
      candidates.push({
        url: e.url,
        transport: e.transport ?? "streamable-http",
        source: "manual",
        name: e.name,
        stdio: e.stdio,
      });
    } else {
      try {
        const u = new URL(e.url);
        const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
        aiTargets.push({ host: u.hostname, port });
      } catch {
        /* skip an unparseable llm-api url */
      }
    }
  }
  return { candidates, aiTargets, probedIds };
}

/** Path of the diff/watch baseline file. */
export function lastScanPath(): string {
  return path.join(scoutHome(), "last-scan.json");
}

/**
 * Reconcile a finished scan with the registry. Best-effort: any IO failure is
 * reported to stderr and swallowed, never fatal to the scan.
 *
 *  - Existing entries matched by originKey → lastSeenAt/lastStatus refreshed.
 *  - Manual entries probed this scan but not found → marked "unreachable".
 *  - With `record`, every verified service is upserted (addedBy "scan") and the
 *    `last-scan.json` baseline is (re)written.
 */
export async function syncScanToRegistry(
  result: ScanResult,
  opts: { record: boolean; probedIds: Set<string> },
  now: string,
): Promise<void> {
  try {
    // A passive scan only touches an existing registry; --record may create one.
    if (!opts.record && !(await registryFileExists())) return;

    let reg = await loadRegistry();
    const byKey = new Map<string, Service>();
    for (const s of result.services) byKey.set(originKey(s), s);

    reg = {
      ...reg,
      entries: reg.entries.map((e) => {
        const hit = byKey.get(e.id);
        if (hit) {
          return { ...e, lastStatus: hit.status, lastSeenAt: now };
        }
        // Only downgrade entries we actually probed this scan.
        if (opts.probedIds.has(e.id)) {
          const unreachable: RegistryStatus = "unreachable";
          return { ...e, lastStatus: unreachable };
        }
        return e;
      }),
    };

    if (opts.record) {
      for (const s of result.services) {
        if (s.kind === "openapi") continue; // transient, never stored
        reg = upsertEntry(reg, entryFromService(s, "scan", now));
      }
    }

    await saveRegistry(reg);
    if (opts.record) await writeLastScan(result);
  } catch (err) {
    process.stderr.write(
      `scout: registry sync skipped — ${(err as Error).message}\n`,
    );
  }
}

async function registryFileExists(): Promise<boolean> {
  try {
    await readFile(registryPath(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Write the diff/watch baseline. Exported so `scout diff` can refresh it. */
export async function writeLastScan(result: ScanResult): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(scoutHome(), { recursive: true });
  await writeFile(
    lastScanPath(),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}
