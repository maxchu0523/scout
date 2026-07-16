import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffScans, isEmptyDiff } from "../src/registry/diff.js";
import type {
  AiServiceResult,
  ScanResult,
  ServerResult,
  Service,
} from "../src/types.js";

function mcp(over: Partial<ServerResult> = {}): ServerResult {
  return {
    kind: "mcp",
    url: "http://127.0.0.1:9000/mcp",
    transport: "streamable-http",
    status: "available",
    latencyMs: 5,
    capabilities: { tools: true, resources: false, prompts: false },
    tools: [{ name: "a" }, { name: "b" }],
    resources: [],
    prompts: [],
    source: "port-scan",
    name: "srv",
    ...over,
  };
}

function ai(over: Partial<AiServiceResult> = {}): AiServiceResult {
  return {
    kind: "llm-api",
    url: "http://127.0.0.1:11434",
    api: "ollama",
    status: "available",
    latencyMs: 3,
    models: ["llama3.1"],
    source: "port-scan",
    name: "Ollama",
    ...over,
  };
}

function scan(services: Service[]): ScanResult {
  return {
    scannedAt: "2026-07-06T00:00:00.000Z",
    target: "127.0.0.1",
    scanned: { hosts: 1, ports: 1, openPorts: 1, candidates: 1 },
    services,
  };
}

describe("diffScans", () => {
  it("reports an added service", () => {
    const d = diffScans(scan([]), scan([mcp()]));
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 0);
  });

  it("reports a removed service (the old object)", () => {
    const d = diffScans(scan([mcp({ name: "old" })]), scan([]));
    assert.equal(d.removed.length, 1);
    assert.equal(d.removed[0].name, "old");
  });

  it("detects a status change", () => {
    const d = diffScans(
      scan([mcp()]),
      scan([mcp({ status: "auth-required" })]),
    );
    assert.equal(d.changed.length, 1);
    assert.deepEqual(d.changed[0].fields, ["status"]);
  });

  it("detects a tool-set change for mcp", () => {
    const d = diffScans(
      scan([mcp()]),
      scan([mcp({ tools: [{ name: "a" }, { name: "c" }] })]),
    );
    assert.deepEqual(d.changed[0].fields, ["tools"]);
  });

  it("ignores tool ordering", () => {
    const d = diffScans(
      scan([mcp({ tools: [{ name: "a" }, { name: "b" }] })]),
      scan([mcp({ tools: [{ name: "b" }, { name: "a" }] })]),
    );
    assert.ok(isEmptyDiff(d));
  });

  it("detects a model-set change for llm-api", () => {
    const d = diffScans(
      scan([ai()]),
      scan([ai({ models: ["llama3.1", "qwen"] })]),
    );
    assert.deepEqual(d.changed[0].fields, ["models"]);
  });

  it("treats a kind change as removed + added", () => {
    // same origin host:port, different kind → not a "change"
    const before = scan([mcp({ url: "http://127.0.0.1:9000/mcp" })]);
    const after = scan([
      ai({ url: "http://127.0.0.1:9000", api: "openai-compatible" }),
    ]);
    // different originKey (mcp:… vs llm-api:…) so both are independent:
    const d = diffScans(before, after);
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 1);
    assert.equal(d.changed.length, 0);
  });

  it("reports no changes for identical scans", () => {
    assert.ok(isEmptyDiff(diffScans(scan([mcp(), ai()]), scan([mcp(), ai()]))));
  });
});
