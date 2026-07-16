import type { OpenApiServiceResult } from "../types.js";
import { baseUrlFor, getJson } from "./http.js";

/** Well-known OpenAPI document locations, tried in order; first hit wins. */
const SPEC_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v3/api-docs",
  "/api-docs",
];

const MAX_OPERATIONS = 20;
const MAX_DESCRIPTION = 500;

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
] as const;

interface ParsedDoc {
  title: string;
  description?: string;
  version?: string;
  operationCount: number;
  operations: string[];
}

/** Format one operation label, e.g. "GET /pets — List pets". */
function operationLabel(method: string, path: string, op: object): string {
  const summary = (op as { summary?: unknown }).summary;
  const label = `${method.toUpperCase()} ${path}`;
  return typeof summary === "string" && summary
    ? `${label} — ${summary}`
    : label;
}

/** Walk paths×methods; count every operation, keep the first MAX_OPERATIONS. */
function collectOperations(paths: unknown): {
  operations: string[];
  operationCount: number;
} {
  const operations: string[] = [];
  let operationCount = 0;
  if (!paths || typeof paths !== "object")
    return { operations, operationCount };
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (!op || typeof op !== "object") continue;
      operationCount++;
      if (operations.length < MAX_OPERATIONS) {
        operations.push(operationLabel(method, path, op));
      }
    }
  }
  return { operations, operationCount };
}

/**
 * Strict shape check (honesty rule): a document must declare itself OpenAPI
 * (`openapi` or `swagger` string field) AND carry `info.title`. Any other 200
 * JSON is a rejection, not a match.
 */
function parseOpenApiDoc(body: unknown): ParsedDoc | null {
  if (!body || typeof body !== "object") return null;
  const doc = body as {
    openapi?: unknown;
    swagger?: unknown;
    info?: unknown;
    paths?: unknown;
  };
  const declared =
    typeof doc.openapi === "string" || typeof doc.swagger === "string";
  if (!declared || !doc.info || typeof doc.info !== "object") return null;
  const info = doc.info as {
    title?: unknown;
    description?: unknown;
    version?: unknown;
  };
  if (typeof info.title !== "string") return null;

  const { operations, operationCount } = collectOperations(doc.paths);

  return {
    title: info.title,
    description:
      typeof info.description === "string" && info.description
        ? info.description.slice(0, MAX_DESCRIPTION)
        : undefined,
    version: typeof info.version === "string" ? info.version : undefined,
    operationCount,
    operations,
  };
}

/**
 * Probe one open (host, port) for a self-describing OpenAPI service.
 * Opt-in only (--openapi); returns null unless a genuine document is found.
 */
export async function probeOpenApi(
  host: string,
  port: number,
  opts: { timeoutMs: number },
): Promise<OpenApiServiceResult | null> {
  const base = baseUrlFor(host, port);
  const start = Date.now();
  for (const specPath of SPEC_PATHS) {
    const r = await getJson(`${base}${specPath}`, opts.timeoutMs);
    if (r?.status !== 200) continue;
    const doc = parseOpenApiDoc(r.body);
    if (!doc) continue;
    return {
      kind: "openapi",
      url: base,
      specPath,
      status: "available",
      latencyMs: Date.now() - start,
      name: doc.title,
      description: doc.description,
      version: doc.version,
      operationCount: doc.operationCount,
      operations: doc.operations,
      source: "port-scan",
    };
  }
  return null;
}
