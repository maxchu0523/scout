import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_UI_PORT } from "../defaults.js";
import { runScan } from "../scan.js";
import type { ScanEvent } from "../types.js";
import { resolveScanOptions } from "../util/scanOptions.js";
import { VERSION } from "../version.js";

/** Static assets live next to the built cli.js, in dist/ui/. */
const ASSETS_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** GET /api/registry → the registry file, or an empty registry. */
async function handleRegistry(res: ServerResponse): Promise<void> {
  const { loadRegistry } = await import("../registry/store.js");
  try {
    sendJson(res, 200, await loadRegistry());
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

/**
 * GET /api/scan → SSE stream of ScanEvents. One scan at a time; a concurrent
 * request gets 409. A `: ping` keep-alive is written every 15s.
 */
function handleScan(
  req: IncomingMessage,
  res: ServerResponse,
  state: { scanning: boolean },
): void {
  if (state.scanning) {
    sendJson(res, 409, { error: "a scan is already in progress" });
    return;
  }
  state.scanning = true;

  const url = new URL(req.url ?? "/", "http://localhost");
  const opts = resolveScanOptions({
    host: url.searchParams.get("host") ?? undefined,
    ports: url.searchParams.get("ports") ?? undefined,
    includeOpenApi: url.searchParams.get("openapi") === "1",
  });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  const send = (e: ScanEvent) => {
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  runScan(opts, send)
    .catch((err) => {
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({ message: (err as Error).message })}\n\n`,
      );
    })
    .finally(() => {
      clearInterval(ping);
      state.scanning = false;
      res.end();
    });
}

/** Serve a static asset from dist/ui/, guarding against path traversal. */
async function handleStatic(
  reqPath: string,
  res: ServerResponse,
): Promise<void> {
  const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const resolved = path.resolve(ASSETS_DIR, rel);
  // Reject anything that escapes the assets dir.
  if (
    resolved !== ASSETS_DIR.replace(/\/$/, "") &&
    !resolved.startsWith(ASSETS_DIR)
  ) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  try {
    const buf = await readFile(resolved);
    const type =
      CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  } catch {
    // No built UI (dev via tsx before a build) or a genuine 404.
    try {
      await readFile(path.join(ASSETS_DIR, "index.html"));
      sendJson(res, 404, { error: "not found" });
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "Scout UI not built. Run `npm run build` first, or use the Vite dev " +
          "server in ui/ (see ui/README.md).\n",
      );
    }
  }
}

export interface UiServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the dashboard HTTP server. Resolves once listening. Tries
 * `preferredPort` (default 7777), falling back to an ephemeral port if taken.
 */
export function startUiServer(opts: {
  host?: string;
  preferredPort?: number;
}): Promise<UiServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const state = { scanning: false };

  const server = createServer((req, res) => {
    const reqPath = (req.url ?? "/").split("?")[0];
    if (reqPath === "/api/version")
      return sendJson(res, 200, { version: VERSION });
    if (reqPath === "/api/registry") return void handleRegistry(res);
    if (reqPath === "/api/scan") return handleScan(req, res, state);
    if (reqPath.startsWith("/api/"))
      return sendJson(res, 404, { error: "not found" });
    return void handleStatic(reqPath, res);
  });

  const listen = (port: number): Promise<UiServerHandle> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) {
          server.removeListener("error", onError);
          resolve(listen(0)); // fall back to an ephemeral port
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        const actual = (server.address() as { port: number }).port;
        resolve({
          port: actual,
          url: `http://${host}:${actual}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });

  return listen(opts.preferredPort ?? DEFAULT_UI_PORT);
}
