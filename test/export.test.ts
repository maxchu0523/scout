import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportConfig } from "../src/invoke/export.js";
import type {
  AiServiceResult,
  ScanResult,
  ServerResult,
  Service,
} from "../src/types.js";

function mcp(over: Partial<ServerResult>): ServerResult {
  return {
    kind: "mcp",
    url: "http://127.0.0.1:9000/mcp",
    transport: "streamable-http",
    status: "available",
    latencyMs: 5,
    capabilities: { tools: true, resources: false, prompts: false },
    tools: [],
    resources: [],
    prompts: [],
    source: "port-scan",
    name: "My Server",
    ...over,
  };
}

function result(services: Service[]): ScanResult {
  return {
    scannedAt: "2026-07-05T00:00:00.000Z",
    target: "127.0.0.1",
    scanned: { hosts: 1, ports: 1, openPorts: 1, candidates: 1 },
    services,
  };
}

describe("buildExportConfig", () => {
  it("maps http, sse, and stdio servers to client config entries", () => {
    const cfg = buildExportConfig(
      result([
        mcp({ name: "alpha" }),
        mcp({
          name: "beta",
          transport: "sse",
          url: "http://127.0.0.1:9001/sse",
        }),
        mcp({
          name: "gamma",
          transport: "stdio",
          url: "npx -y some-mcp --flag",
        }),
      ]),
      "mcp-json",
      false,
    );
    assert.deepEqual(cfg, {
      mcpServers: {
        alpha: { type: "http", url: "http://127.0.0.1:9000/mcp" },
        beta: { type: "sse", url: "http://127.0.0.1:9001/sse" },
        gamma: { command: "npx", args: ["-y", "some-mcp", "--flag"] },
      },
    });
  });

  it("never re-emits env for stdio servers", () => {
    const cfg = buildExportConfig(
      result([mcp({ name: "s", transport: "stdio", url: "cmd" })]),
      "mcp-json",
      false,
    );
    assert.equal(JSON.stringify(cfg).includes("env"), false);
  });

  it("excludes auth-required servers unless asked", () => {
    const services = [
      mcp({ name: "open" }),
      mcp({
        name: "locked",
        status: "auth-required",
        url: "http://127.0.0.1:9002/mcp",
      }),
    ];
    const strict = buildExportConfig(result(services), "mcp-json", false);
    assert.deepEqual(Object.keys(strict.mcpServers), ["open"]);
    const loose = buildExportConfig(result(services), "mcp-json", true);
    assert.deepEqual(Object.keys(loose.mcpServers), ["open", "locked"]);
  });

  it("skips llm-api services entirely", () => {
    const ai: AiServiceResult = {
      kind: "llm-api",
      url: "http://127.0.0.1:11434",
      api: "ollama",
      status: "available",
      latencyMs: 3,
      models: ["llama3.1"],
      source: "port-scan",
      name: "Ollama",
    };
    const cfg = buildExportConfig(result([ai]), "mcp-json", true);
    assert.deepEqual(cfg.mcpServers, {});
  });

  it("sanitizes names and suffixes collisions", () => {
    const cfg = buildExportConfig(
      result([
        mcp({ name: "My Séb Server!" }),
        mcp({ name: "my sb server", url: "http://127.0.0.1:9003/mcp" }),
        mcp({ name: "MY SB SERVER", url: "http://127.0.0.1:9004/mcp" }),
      ]),
      "mcp-json",
      false,
    );
    assert.deepEqual(Object.keys(cfg.mcpServers), [
      "my-sb-server",
      "my-sb-server-2",
      "my-sb-server-3",
    ]);
  });

  it("wraps in `servers` for the vscode format", () => {
    const cfg = buildExportConfig(
      result([mcp({ name: "a" })]),
      "vscode",
      false,
    );
    assert.ok(cfg.servers);
    assert.equal(cfg.mcpServers, undefined);
  });
});
