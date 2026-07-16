import type { Service } from "../types.js";
import { originKey } from "../util/originKey.js";

export interface ScanChange {
  before: Service;
  after: Service;
  /** Which aspects changed: "status" | "tools" | "models" | "operations". */
  fields: string[];
}

export interface ScanDiff {
  added: Service[];
  /** The OLD service object for anything no longer present. */
  removed: Service[];
  changed: ScanChange[];
}

/** Sorted tool-name set of an mcp service (empty for other kinds). */
function toolNames(s: Service): string {
  if (s.kind !== "mcp") return "";
  return s.tools
    .map((t) => t.name)
    .sort()
    .join("\n");
}

function modelNames(s: Service): string {
  if (s.kind !== "llm-api") return "";
  return [...s.models].sort().join("\n");
}

/** Compare two services with the SAME originKey and list what changed. */
function changedFields(before: Service, after: Service): string[] {
  const fields: string[] = [];
  if (before.status !== after.status) fields.push("status");
  if (after.kind === "mcp" && toolNames(before) !== toolNames(after)) {
    fields.push("tools");
  }
  if (after.kind === "llm-api" && modelNames(before) !== modelNames(after)) {
    fields.push("models");
  }
  if (
    after.kind === "openapi" &&
    before.kind === "openapi" &&
    before.operationCount !== after.operationCount
  ) {
    fields.push("operations");
  }
  return fields;
}

/**
 * Diff two scans by originKey. A pair whose `kind` changed between scans is
 * reported as removed + added (not changed) — it is a different service class.
 */
export function diffScans(
  before: ScanResultLike,
  after: ScanResultLike,
): ScanDiff {
  const beforeMap = new Map(before.services.map((s) => [originKey(s), s]));
  const afterMap = new Map(after.services.map((s) => [originKey(s), s]));

  const added: Service[] = [];
  const removed: Service[] = [];
  const changed: ScanChange[] = [];

  for (const [key, a] of afterMap) {
    const b = beforeMap.get(key);
    if (!b) {
      added.push(a);
    } else if (b.kind !== a.kind) {
      removed.push(b);
      added.push(a);
    } else {
      const fields = changedFields(b, a);
      if (fields.length > 0) changed.push({ before: b, after: a, fields });
    }
  }
  for (const [key, b] of beforeMap) {
    if (!afterMap.has(key)) removed.push(b);
  }

  return { added, removed, changed };
}

/** Just the `services` array is needed — accept any object that carries one. */
interface ScanResultLike {
  services: Service[];
}

export function isEmptyDiff(d: ScanDiff): boolean {
  return (
    d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0
  );
}

/** Human one-liners for a TTY. */
export function formatDiff(d: ScanDiff): string {
  const lines: string[] = [];
  for (const s of d.added) lines.push(`+ ${s.name} (${s.kind}, ${s.url})`);
  for (const s of d.removed) lines.push(`- ${s.name} (${s.kind}, ${s.url})`);
  for (const c of d.changed) {
    const bits = c.fields.map((f) => {
      if (f === "status") return `status ${c.before.status}→${c.after.status}`;
      return f;
    });
    lines.push(`~ ${c.after.name}: ${bits.join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : "no changes";
}
