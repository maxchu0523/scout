import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Candidate, Transport } from "../types.js";

/** Known MCP client config files across common tools (best-effort). */
function knownConfigPaths(): string[] {
  const home = os.homedir();
  const p = (...parts: string[]) => path.join(home, ...parts);
  return [
    p(".claude.json"),
    p(".claude", "settings.json"),
    p("Library", "Application Support", "Claude", "claude_desktop_config.json"),
    p(".config", "Claude", "claude_desktop_config.json"),
    p(".cursor", "mcp.json"),
    p(".codeium", "windsurf", "mcp_config.json"),
    p("Library", "Application Support", "Code", "User", "settings.json"),
    p(".config", "Code", "User", "settings.json"),
  ];
}

interface RawServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Pull every `{ name: serverDef }` map out of one parsed config document. */
function extractServerMaps(doc: unknown): Record<string, RawServer>[] {
  const maps: Record<string, RawServer>[] = [];
  if (!doc || typeof doc !== "object") return maps;
  const obj = doc as Record<string, unknown>;

  const pushIfMap = (v: unknown) => {
    if (v && typeof v === "object") maps.push(v as Record<string, RawServer>);
  };

  // Claude Desktop / Claude Code / Cursor / Windsurf: top-level mcpServers
  pushIfMap(obj.mcpServers);

  // VS Code: { "mcp": { "servers": {...} } } or { "servers": {...} }
  if (obj.mcp && typeof obj.mcp === "object") {
    pushIfMap((obj.mcp as Record<string, unknown>).servers);
  }
  pushIfMap(obj.servers);

  // Claude Code: per-project mcpServers under projects[path]
  if (obj.projects && typeof obj.projects === "object") {
    for (const proj of Object.values(obj.projects as Record<string, unknown>)) {
      if (proj && typeof proj === "object") {
        pushIfMap((proj as Record<string, unknown>).mcpServers);
      }
    }
  }

  return maps;
}

function toCandidate(name: string, def: RawServer): Candidate | null {
  if (def.url) {
    const transport: Transport = def.type === "sse" ? "sse" : "streamable-http";
    return { url: def.url, transport, source: "config", name };
  }
  if (def.command) {
    const args = Array.isArray(def.args) ? def.args : [];
    const label = [def.command, ...args].join(" ");
    return {
      url: label,
      transport: "stdio",
      source: "config",
      name,
      stdio: { command: def.command, args, env: def.env },
    };
  }
  return null;
}

/**
 * Read declared MCP servers from known client configs (plus any `extraPaths`).
 * HTTP/SSE entries become network candidates; `command` entries become stdio
 * candidates (verified later by spawning). Deduped by transport+url.
 */
export async function discoverFromConfig(
  extraPaths: string[] = [],
  includeKnown = true,
): Promise<Candidate[]> {
  const files = [...(includeKnown ? knownConfigPaths() : []), ...extraPaths];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  await Promise.all(
    files.map(async (file) => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return; // absent / unreadable — skip silently
      }
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        return; // not valid JSON (e.g. JSONC settings) — skip
      }
      for (const map of extractServerMaps(doc)) {
        for (const [name, def] of Object.entries(map)) {
          if (!def || typeof def !== "object") continue;
          const cand = toCandidate(name, def as RawServer);
          if (!cand) continue;
          const key = `${cand.transport}:${cand.url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(cand);
        }
      }
    }),
  );

  return candidates;
}
