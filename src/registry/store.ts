import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Registry, RegistryEntry } from "./types.js";

/** Root dir for Scout state; overridable via SCOUT_HOME (tests point it at tmp). */
export function scoutHome(): string {
  return process.env.SCOUT_HOME ?? path.join(os.homedir(), ".scout");
}

export function registryPath(): string {
  return path.join(scoutHome(), "registry.json");
}

function emptyRegistry(): Registry {
  return { version: 1, entries: [] };
}

/**
 * Read the registry. A missing file is an empty registry; a present-but-corrupt
 * file throws (naming the path) so we never silently overwrite real data.
 */
export async function loadRegistry(): Promise<Registry> {
  const file = registryPath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return emptyRegistry();
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`registry at ${file} is not valid JSON`);
  }
  if (
    !doc ||
    typeof doc !== "object" ||
    !Array.isArray((doc as Registry).entries)
  ) {
    throw new Error(`registry at ${file} is malformed (no entries array)`);
  }
  return doc as Registry;
}

/** Write atomically: tmp file then rename, so a crash never truncates the store. */
export async function saveRegistry(reg: Registry): Promise<void> {
  const file = registryPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * Insert or replace an entry by `id`. On update, provenance is preserved:
 * `addedAt`, `firstSeenAt`, and `addedBy` stay as first recorded (a service
 * added manually then re-seen by a scan remains `addedBy: "manual"`).
 */
export function upsertEntry(reg: Registry, entry: RegistryEntry): Registry {
  const existing = reg.entries.find((e) => e.id === entry.id);
  const merged: RegistryEntry = existing
    ? {
        ...entry,
        addedAt: existing.addedAt,
        firstSeenAt: existing.firstSeenAt,
        addedBy: existing.addedBy,
      }
    : entry;
  const entries = existing
    ? reg.entries.map((e) => (e.id === entry.id ? merged : e))
    : [...reg.entries, merged];
  return { ...reg, entries };
}
