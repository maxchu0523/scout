/**
 * Small shared HTTP helpers for the fingerprint probes (AI APIs, OpenAPI).
 * Every request is best-effort: network/parse failures resolve to null.
 */

/** Ports where a local API would typically be reached over TLS. */
const TLS_PORTS = new Set([443, 8443]);

export interface HttpProbeResponse {
  status: number;
  body: unknown;
  server: string | null;
  wwwAuth: string | null;
}

/** Build the base URL for a (host, port), bracketing IPv6 hosts. */
export function baseUrlFor(host: string, port: number): string {
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  const scheme = TLS_PORTS.has(port) ? "https" : "http";
  return `${scheme}://${hostForUrl}:${port}`;
}

async function requestJson(
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<HttpProbeResponse | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      signal: ctrl.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body — leave null */
    }
    return {
      status: res.status,
      body,
      server: res.headers.get("server"),
      wwwAuth: res.headers.get("www-authenticate"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function getJson(
  url: string,
  timeoutMs: number,
): Promise<HttpProbeResponse | null> {
  return requestJson(url, timeoutMs, { method: "GET" });
}

export function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<HttpProbeResponse | null> {
  return requestJson(url, timeoutMs, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
