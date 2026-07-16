import { readFile, writeFile } from "node:fs/promises";
import type { ScanResult, ServerResult } from "../types.js";

export type ExportFormat = "mcp-json" | "vscode";

type ExportEntry =
  | { type: "http" | "sse"; url: string }
  | { command: string; args: string[] };

/** Lowercase, spaces→dashes, strip anything outside [a-z0-9_-]. */
function sanitizeName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return clean || "server";
}

function toEntry(server: ServerResult): ExportEntry {
  if (server.transport === "stdio") {
    // The stdio url is the spawn label "command arg1 arg2". env is never
    // re-emitted: config-discovered env may contain secrets.
    const parts = server.url.split(" ").filter(Boolean);
    return { command: parts[0] ?? server.url, args: parts.slice(1) };
  }
  return {
    type: server.transport === "sse" ? "sse" : "http",
    url: server.url,
  };
}

/**
 * Build a ready-to-paste MCP client config object from a scan result.
 * `mcp-json` → { mcpServers: {...} } (Claude Desktop/Code, Cursor, .mcp.json);
 * `vscode`   → { servers: {...} }.
 */
export function buildExportConfig(
  result: ScanResult,
  format: ExportFormat,
  includeAuthRequired: boolean,
): Record<string, Record<string, ExportEntry>> {
  const servers: Record<string, ExportEntry> = {};
  for (const service of result.services) {
    if (service.kind !== "mcp") continue;
    if (service.status !== "available" && !includeAuthRequired) continue;
    let key = sanitizeName(service.name);
    for (let n = 2; key in servers; n++) {
      key = `${sanitizeName(service.name)}-${n}`;
    }
    servers[key] = toEntry(service);
  }
  return format === "vscode" ? { servers } : { mcpServers: servers };
}

/** Read a prior `scout scan --json` output file. Throws on the wrong shape. */
export async function loadScanFile(path: string): Promise<ScanResult> {
  const text = await readFile(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (
    !doc ||
    typeof doc !== "object" ||
    !Array.isArray((doc as { services?: unknown }).services)
  ) {
    throw new Error(
      `${path} does not look like \`scout scan --json\` output (no services array)`,
    );
  }
  return doc as ScanResult;
}

/** Pretty-print the config to stdout or a file. */
export async function writeExport(
  config: unknown,
  outPath: string | undefined,
): Promise<void> {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (outPath) await writeFile(outPath, text, "utf8");
  else process.stdout.write(text);
}
