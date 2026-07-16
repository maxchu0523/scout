import { runScan } from "../scan.js";
import type { ScanOptions, ScanResult, Service } from "../types.js";
import { diffScans, type ScanDiff } from "./diff.js";

/** One reporting event emitted by watch. */
export type WatchEvent =
  | { event: "scan"; at: string; services: number }
  | { event: "added"; at: string; service: Service }
  | { event: "removed"; at: string; service: Service }
  | { event: "changed"; at: string; service: Service; fields: string[] };

const EMPTY: Pick<ScanResult, "services"> = { services: [] };

/**
 * Run a single watch iteration: scan once, diff against the previous result
 * (empty on the first pass, so everything reads as "added"). Pure w.r.t. timing
 * — the infinite loop lives in `watch()` and is not unit-tested.
 */
export async function watchOnce(
  prev: Pick<ScanResult, "services"> | null,
  opts: ScanOptions,
): Promise<{ result: ScanResult; diff: ScanDiff }> {
  const result = await runScan(opts);
  const diff = diffScans(prev ?? EMPTY, result);
  return { result, diff };
}

/** Flatten a diff into the ordered event stream watch reports. */
export function diffToEvents(diff: ScanDiff, at: string): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const service of diff.added)
    events.push({ event: "added", at, service });
  for (const service of diff.removed) {
    events.push({ event: "removed", at, service });
  }
  for (const c of diff.changed) {
    events.push({ event: "changed", at, service: c.after, fields: c.fields });
  }
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WatchOptions {
  scan: ScanOptions;
  intervalMs: number;
  json: boolean;
  /** Sink for reporting (defaults to stdout/stderr writers). */
  emit?: (e: WatchEvent) => void;
  /** Test seam: stop after N iterations instead of looping forever. */
  maxIterations?: number;
}

/** Default human/NDJSON reporter. */
function defaultEmit(json: boolean): (e: WatchEvent) => void {
  return (e) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(e)}\n`);
      return;
    }
    if (e.event === "scan") {
      process.stderr.write(`[${e.at}] scan · ${e.services} services\n`);
    } else if (e.event === "changed") {
      process.stderr.write(
        `[${e.at}] ~ ${e.service.name} (${e.fields.join(", ")})\n`,
      );
    } else {
      const sign = e.event === "added" ? "+" : "-";
      process.stderr.write(`[${e.at}] ${sign} ${e.service.name}\n`);
    }
  };
}

/**
 * Continuously scan, reporting appeared/disappeared/changed services. Uses a
 * setTimeout loop (never setInterval) so a slow scan can't overlap the next.
 * Loops until SIGINT unless `maxIterations` is set (tests).
 */
export async function watch(opts: WatchOptions): Promise<void> {
  const emit = opts.emit ?? defaultEmit(opts.json);
  let prev: Pick<ScanResult, "services"> | null = null;
  let iterations = 0;

  while (opts.maxIterations === undefined || iterations < opts.maxIterations) {
    const { result, diff } = await watchOnce(prev, opts.scan);
    const at = result.scannedAt;
    for (const e of diffToEvents(diff, at)) emit(e);
    emit({ event: "scan", at, services: result.services.length });
    prev = result;
    iterations++;
    if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) {
      break;
    }
    await sleep(opts.intervalMs);
  }
}
