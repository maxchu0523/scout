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

  it("enriches Ollama models via /api/show", async () => {
    await withServer(
      {
        "/api/tags": { status: 200, body: { models: [{ name: "llama3.1" }] } },
        "/api/show": {
          status: 200,
          body: {
            details: {
              family: "llama",
              parameter_size: "8.0B",
              quantization_level: "Q4_K_M",
            },
            model_info: { "llama.context_length": 131072 },
          },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "ollama");
        assert.deepEqual(r?.modelInfo, [
          {
            id: "llama3.1",
            family: "llama",
            parameterSize: "8.0B",
            quantization: "Q4_K_M",
            contextLength: 131072,
          },
        ]);
      },
    );
  });

  it("still detects Ollama when /api/show fails", async () => {
    await withServer(
      {
        "/api/tags": { status: 200, body: { models: [{ name: "qwen" }] } },
        "/api/show": { status: 500 },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "ollama");
        assert.deepEqual(r?.models, ["qwen"]);
        assert.equal(r?.modelInfo, undefined);
      },
    );
  });

  it("caps Ollama per-model detail at the limit", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `m${i}` }));
    await withServer(
      {
        "/api/tags": { status: 200, body: { models: many } },
        "/api/show": { status: 200, body: { details: { family: "llama" } } },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.models.length, 12);
        assert.equal(r?.modelInfo?.length, 8);
      },
    );
  });

  it("identifies LM Studio via /api/v0/models", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/system_stats": { status: 404 },
        "/v1/models": {
          status: 200,
          body: { object: "list", data: [{ id: "qwen3" }] },
        },
        "/api/v0/models": {
          status: 200,
          body: {
            data: [
              {
                id: "qwen3",
                arch: "qwen2",
                quantization: "Q4_K_M",
                max_context_length: 32768,
                state: "loaded",
                type: "llm",
              },
            ],
          },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "openai-compatible");
        assert.equal(r?.name, "LM Studio");
        assert.deepEqual(r?.modelInfo, [
          {
            id: "qwen3",
            family: "qwen2",
            quantization: "Q4_K_M",
            contextLength: 32768,
            state: "loaded",
            type: "llm",
          },
        ]);
      },
    );
  });

  it("stays a generic OpenAI-compatible API when /api/v0/models is absent", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/system_stats": { status: 404 },
        "/v1/models": {
          status: 200,
          body: { object: "list", data: [{ id: "qwen3" }] },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.name, "OpenAI-compatible API");
        assert.equal(r?.modelInfo, undefined);
      },
    );
  });

  it("detects ComfyUI via /system_stats and lists checkpoints", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/system_stats": {
          status: 200,
          body: {
            system: { os: "posix", comfyui_version: "0.3.40" },
            devices: [{ name: "mps" }],
          },
        },
        "/models/checkpoints": {
          status: 200,
          body: ["sd_xl_base_1.0.safetensors", "flux1-dev.safetensors"],
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "comfyui");
        assert.equal(r?.name, "ComfyUI");
        assert.equal(r?.version, "0.3.40");
        assert.deepEqual(r?.models, [
          "sd_xl_base_1.0.safetensors",
          "flux1-dev.safetensors",
        ]);
      },
    );
  });

  it("detects older ComfyUI without comfyui_version (system + devices)", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/system_stats": {
          status: 200,
          body: { system: { os: "posix" }, devices: [{ name: "cuda:0" }] },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "comfyui");
        assert.equal(r?.version, undefined);
        assert.deepEqual(r?.models, []);
      },
    );
  });

  it("falls through a non-ComfyUI /system_stats to openai-compatible", async () => {
    await withServer(
      {
        "/api/tags": { status: 404 },
        "/system_stats": { status: 200, body: { uptime: 42 } },
        "/v1/models": {
          status: 200,
          body: { object: "list", data: [{ id: "gpt-x" }] },
        },
      },
      async (port) => {
        const r = await probeAiService("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.api, "openai-compatible");
      },
    );
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
