import type { AiServiceResult } from "../types.js";

async function getJson(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; server: string | null } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    const server = res.headers.get("server");
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body — leave null */
    }
    return { status: res.status, body, server };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function isAuth(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Fingerprint a local AI inference API on one open (host, port).
 * Returns an AiServiceResult for genuine AI APIs (`available` / `auth-required`),
 * or null for anything that isn't one (same honesty rule as the MCP prober).
 *
 * Order matters: Ollama is checked first via its own `/api/tags` because it also
 * serves an OpenAI-compatible `/v1/models`, and we want it labeled `ollama`.
 */
export async function probeAiService(
  host: string,
  port: number,
  opts: { timeoutMs: number },
): Promise<AiServiceResult | null> {
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  const base = `http://${hostForUrl}:${port}`;
  const start = Date.now();

  // 1. Ollama — GET /api/tags → { models: [{ name }] }
  const tags = await getJson(`${base}/api/tags`, opts.timeoutMs);
  if (tags) {
    if (isAuth(tags.status)) {
      return ollamaResult(base, "auth-required", [], tags.server, start);
    }
    const models = ollamaModels(tags.body);
    if (models)
      return ollamaResult(base, "available", models, tags.server, start);
  }

  // 2. OpenAI-compatible — GET /v1/models → { object: "list", data: [{ id }] }
  const v1 = await getJson(`${base}/v1/models`, opts.timeoutMs);
  if (v1) {
    if (isAuth(v1.status)) {
      return openaiResult(base, "auth-required", [], v1.server, start);
    }
    const models = openaiModels(v1.body);
    if (models)
      return openaiResult(base, "available", models, v1.server, start);
  }

  return null;
}

function ollamaModels(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const list = (body as { models?: unknown }).models;
  if (!Array.isArray(list)) return null; // not Ollama's shape
  return list
    .map((m) =>
      m && typeof m === "object" ? (m as { name?: string }).name : undefined,
    )
    .filter((n): n is string => typeof n === "string");
}

function openaiModels(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { object?: unknown; data?: unknown };
  // Must look like an OpenAI model list, not just any 200 JSON.
  if (b.object !== "list" && !Array.isArray(b.data)) return null;
  if (!Array.isArray(b.data)) return [];
  return b.data
    .map((m) =>
      m && typeof m === "object" ? (m as { id?: string }).id : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

function ollamaResult(
  url: string,
  status: "available" | "auth-required",
  models: string[],
  server: string | null,
  start: number,
): AiServiceResult {
  return {
    kind: "llm-api",
    url,
    api: "ollama",
    status,
    latencyMs: Date.now() - start,
    models,
    server: server ?? undefined,
    source: "port-scan",
    name: "Ollama",
  };
}

function openaiResult(
  url: string,
  status: "available" | "auth-required",
  models: string[],
  server: string | null,
  start: number,
): AiServiceResult {
  return {
    kind: "llm-api",
    url,
    api: "openai-compatible",
    status,
    latencyMs: Date.now() - start,
    models,
    server: server ?? undefined,
    source: "port-scan",
    name: server ?? "OpenAI-compatible API",
  };
}
