import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { probeAiService } from "../src/probe/aiProbe.js";

type Routes = Record<string, { status: number; body?: unknown }>;

/** Spin up a throwaway HTTP server that answers a fixed route table. */
async function withServer(
  routes: Routes,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = routes[req.url ?? ""];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(route.body === undefined ? "" : JSON.stringify(route.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("probeAiService", () => {
  it("detects Ollama via /api/tags", async () => {
    await withServer(
      {
        "/api/tags": {
          status: 200,
          body: { models: [{ name: "llama3.1" }, { name: "qwen" }] },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.kind, "llm-api");
        assert.equal(r?.api, "ollama");
        assert.equal(r?.status, "available");
        assert.deepEqual(r?.models, ["llama3.1", "qwen"]);
      },
    );
  });

  it("detects an OpenAI-compatible API via /v1/models", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/v1/models": {
          status: 200,
          body: { object: "list", data: [{ id: "qwen3" }] },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "openai-compatible");
        assert.deepEqual(r?.models, ["qwen3"]);
      },
    );
  });

  it("reports auth-required on a 401 with an OpenAI-style error body", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/v1/models": { status: 401, body: { error: { message: "no key" } } },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.status, "auth-required");
        assert.deepEqual(r?.models, []);
      },
    );
  });

  it("ignores a bare 403 with no AI signal (e.g. AirTunes/AirPlay)", async () => {
    await withServer(
      { "/api/tags": { status: 403 }, "/v1/models": { status: 403 } },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r, null);
      },
    );
  });

  it("detects Ollama even with zero models", async () => {
    await withServer(
      { "/api/tags": { status: 200, body: { models: [] } } },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "ollama");
        assert.deepEqual(r?.models, []);
      },
    );
  });

  it("returns null for a non-AI HTTP service", async () => {
    await withServer(
      { "/v1/models": { status: 200, body: { hello: "world" } } },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r, null);
      },
    );
  });

  it("returns null when nothing is listening", async () => {
    const r = await probeAiService("127.0.0.1", 59999, { timeoutMs: 500 });
    assert.equal(r, null);
  });

  it("uses https on TLS ports (443/8443), http otherwise", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    // Capture the requested URL; answer 404 so the probe just returns null.
    globalThis.fetch = ((input: string | URL) => {
      urls.push(String(input));
      return Promise.resolve({
        status: 404,
        headers: { get: () => null },
        json: () => Promise.resolve(null),
      } as unknown as Response);
    }) as typeof fetch;

    try {
      await probeAiService("10.0.0.5", 443, { timeoutMs: 500 });
      await probeAiService("10.0.0.5", 8443, { timeoutMs: 500 });
      await probeAiService("10.0.0.5", 1234, { timeoutMs: 500 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(
      urls.includes("https://10.0.0.5:443/api/tags"),
      "port 443 should be probed over https",
    );
    assert.ok(
      urls.includes("https://10.0.0.5:8443/v1/models"),
      "port 8443 should be probed over https",
    );
    assert.ok(
      urls.includes("http://10.0.0.5:1234/api/tags"),
      "non-TLS port should stay http",
    );
    assert.ok(
      !urls.some((u) => u.startsWith("http://10.0.0.5:443")),
      "port 443 must never be probed over plain http",
    );
  });
});
