import { DEFAULT_MODEL_DETAIL_LIMIT } from "../defaults.js";
import type { AiApi, AiServiceResult, ModelInfo, Status } from "../types.js";
import { mapPool } from "../util/pool.js";
import {
  baseUrlFor,
  getJson,
  type HttpProbeResponse,
  postJson,
} from "./http.js";

/**
 * Only treat a rejection as a genuine AI-auth challenge — not just any 4xx.
 * Requires HTTP 401 plus either a `WWW-Authenticate` header or an OpenAI-style
 * `{ error: … }` JSON body. This excludes unrelated services that return a bare
 * 403 (e.g. macOS AirTunes/AirPlay on ports 5000/7000).
 */
function isAiAuth(r: HttpProbeResponse): boolean {
  if (r.status !== 401) return false;
  if (r.wwwAuth) return true;
  return (
    Boolean(r.body) &&
    typeof r.body === "object" &&
    "error" in (r.body as object)
  );
}

interface FingerprintOpts {
  timeoutMs: number;
}

/**
 * One protocol family Scout knows how to identify. Each fingerprint asks the
 * live service a shape-specific question and reports only what it verified —
 * never assumed metadata. Returns null to fall through to the next family.
 */
type AiFingerprint = (
  base: string,
  opts: FingerprintOpts,
  start: number,
) => Promise<AiServiceResult | null>;

/* ------------------------------------------------------------------ *
 * Ollama — GET /api/tags, enriched per-model via POST /api/show
 * ------------------------------------------------------------------ */

async function fingerprintOllama(
  base: string,
  opts: FingerprintOpts,
  start: number,
): Promise<AiServiceResult | null> {
  const tags = await getJson(`${base}/api/tags`, opts.timeoutMs);
  if (!tags) return null;
  const models = ollamaModels(tags.body);
  if (models) {
    const modelInfo = await ollamaModelInfo(base, models, opts.timeoutMs);
    return aiResult({
      base,
      api: "ollama",
      name: "Ollama",
      status: "available",
      models,
      modelInfo,
      server: tags.server,
      start,
    });
  }
  if (isAiAuth(tags)) {
    return aiResult({
      base,
      api: "ollama",
      name: "Ollama",
      status: "auth-required",
      models: [],
      server: tags.server,
      start,
    });
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

/** Best-effort per-model detail; any failure just omits that entry. */
async function ollamaModelInfo(
  base: string,
  models: string[],
  timeoutMs: number,
): Promise<ModelInfo[]> {
  const subset = models.slice(0, DEFAULT_MODEL_DETAIL_LIMIT);
  const infos = await mapPool(subset, 4, async (name) => {
    const r = await postJson(`${base}/api/show`, { model: name }, timeoutMs);
    if (r?.status !== 200 || !r.body || typeof r.body !== "object") {
      return null;
    }
    const body = r.body as {
      details?: {
        family?: unknown;
        parameter_size?: unknown;
        quantization_level?: unknown;
      };
      model_info?: Record<string, unknown>;
    };
    const d = body.details ?? {};
    const info: ModelInfo = { id: name };
    if (typeof d.family === "string") info.family = d.family;
    if (typeof d.parameter_size === "string") {
      info.parameterSize = d.parameter_size;
    }
    if (typeof d.quantization_level === "string") {
      info.quantization = d.quantization_level;
    }
    if (body.model_info && typeof body.model_info === "object") {
      for (const [key, value] of Object.entries(body.model_info)) {
        if (key.endsWith(".context_length") && typeof value === "number") {
          info.contextLength = value;
          break;
        }
      }
    }
    return info;
  });
  return infos.filter((i): i is ModelInfo => i !== null);
}

/* ------------------------------------------------------------------ *
 * ComfyUI — GET /system_stats, models via GET /models/checkpoints
 * ------------------------------------------------------------------ */

async function fingerprintComfyUi(
  base: string,
  opts: FingerprintOpts,
  start: number,
): Promise<AiServiceResult | null> {
  const stats = await getJson(`${base}/system_stats`, opts.timeoutMs);
  if (!stats) return null;
  if (stats.status === 200 && stats.body && typeof stats.body === "object") {
    const body = stats.body as { system?: unknown; devices?: unknown };
    const sys =
      body.system && typeof body.system === "object"
        ? (body.system as { comfyui_version?: unknown })
        : null;
    // Strict: a `system` object with a comfyui_version string, or (older
    // builds without the version field) `system` plus a `devices` array.
    const version =
      sys && typeof sys.comfyui_version === "string"
        ? sys.comfyui_version
        : undefined;
    if (sys && (version !== undefined || Array.isArray(body.devices))) {
      return aiResult({
        base,
        api: "comfyui",
        name: "ComfyUI",
        status: "available",
        models: await comfyCheckpoints(base, opts.timeoutMs),
        server: stats.server,
        version,
        start,
      });
    }
  }
  if (isAiAuth(stats)) {
    return aiResult({
      base,
      api: "comfyui",
      name: "ComfyUI",
      status: "auth-required",
      models: [],
      server: stats.server,
      start,
    });
  }
  return null;
}

/** Checkpoint filenames; an empty list is a valid (verified) answer. */
async function comfyCheckpoints(
  base: string,
  timeoutMs: number,
): Promise<string[]> {
  const r = await getJson(`${base}/models/checkpoints`, timeoutMs);
  if (r?.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.filter((m): m is string => typeof m === "string");
}

/* ------------------------------------------------------------------ *
 * OpenAI-compatible — GET /v1/models; LM Studio via GET /api/v0/models
 * ------------------------------------------------------------------ */

async function fingerprintOpenAiCompatible(
  base: string,
  opts: FingerprintOpts,
  start: number,
): Promise<AiServiceResult | null> {
  const v1 = await getJson(`${base}/v1/models`, opts.timeoutMs);
  if (!v1) return null;
  const models = openaiModels(v1.body);
  if (models) {
    const lms = await lmStudioModelInfo(base, opts.timeoutMs);
    return aiResult({
      base,
      api: "openai-compatible",
      name: lms ? "LM Studio" : (v1.server ?? "OpenAI-compatible API"),
      status: "available",
      models,
      modelInfo: lms ?? undefined,
      server: v1.server,
      start,
    });
  }
  if (isAiAuth(v1)) {
    return aiResult({
      base,
      api: "openai-compatible",
      name: v1.server ?? "OpenAI-compatible API",
      status: "auth-required",
      models: [],
      server: v1.server,
      start,
    });
  }
  return null;
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

/**
 * LM Studio's native model listing. A match both identifies the vendor and
 * yields per-model detail; any shape mismatch → null (plain OpenAI service).
 */
async function lmStudioModelInfo(
  base: string,
  timeoutMs: number,
): Promise<ModelInfo[] | null> {
  const r = await getJson(`${base}/api/v0/models`, timeoutMs);
  if (r?.status !== 200 || !r.body || typeof r.body !== "object") {
    return null;
  }
  const data = (r.body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const infos: ModelInfo[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") return null;
    const m = entry as {
      id?: unknown;
      arch?: unknown;
      quantization?: unknown;
      max_context_length?: unknown;
      state?: unknown;
      type?: unknown;
    };
    if (typeof m.id !== "string") return null;
    const info: ModelInfo = { id: m.id };
    if (typeof m.arch === "string") info.family = m.arch;
    if (typeof m.quantization === "string") info.quantization = m.quantization;
    if (typeof m.max_context_length === "number") {
      info.contextLength = m.max_context_length;
    }
    if (m.state === "loaded" || m.state === "not-loaded") info.state = m.state;
    if (typeof m.type === "string") info.type = m.type;
    infos.push(info);
  }
  return infos;
}

/* ------------------------------------------------------------------ */

/** Order matters: Ollama before openai-compatible (it serves both API
 *  surfaces); ComfyUI anywhere before the openai-compatible catch-all. */
const FINGERPRINTS: AiFingerprint[] = [
  fingerprintOllama,
  fingerprintComfyUi,
  fingerprintOpenAiCompatible,
];

function aiResult(args: {
  base: string;
  api: AiApi;
  name: string;
  status: Status;
  models: string[];
  modelInfo?: ModelInfo[];
  server: string | null;
  version?: string;
  start: number;
}): AiServiceResult {
  const result: AiServiceResult = {
    kind: "llm-api",
    url: args.base,
    api: args.api,
    status: args.status,
    latencyMs: Date.now() - args.start,
    models: args.models,
    server: args.server ?? undefined,
    source: "port-scan",
    name: args.name,
  };
  if (args.modelInfo && args.modelInfo.length > 0) {
    result.modelInfo = args.modelInfo;
  }
  if (args.version !== undefined) result.version = args.version;
  return result;
}

/**
 * Fingerprint a local AI inference API on one open (host, port).
 * Returns an AiServiceResult for genuine AI APIs (`available` / `auth-required`),
 * or null for anything that isn't one (same honesty rule as the MCP prober).
 *
 * Protocol families are tried in FINGERPRINTS order; first match wins.
 */
export async function probeAiService(
  host: string,
  port: number,
  opts: { timeoutMs: number },
): Promise<AiServiceResult | null> {
  const base = baseUrlFor(host, port);
  const start = Date.now();
  for (const fingerprint of FINGERPRINTS) {
    const result = await fingerprint(base, opts, start);
    if (result) return result;
  }
  return null;
}
