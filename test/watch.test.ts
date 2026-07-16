import assert from "node:assert/strict";
import type { Server } from "node:http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { diffToEvents, watchOnce } from "../src/registry/watch.js";
import type { ScanOptions } from "../src/types.js";

/** Start an Ollama-shaped fixture; returns the server + its port. */
async function startOllama(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.1" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

function opts(port: number): ScanOptions {
  return {
    hosts: ["127.0.0.1"],
    target: "127.0.0.1",
    ports: [port],
    paths: ["/mcp"],
    includeConfig: false,
    includeAi: true,
    includeOpenApi: false,
    includeManual: false,
    record: false,
    extraConfigPaths: [],
    connectTimeoutMs: 500,
    timeoutMs: 2000,
    portConcurrency: 10,
    probeConcurrency: 5,
    transport: "auto",
  };
}

describe("watch", { timeout: 30000 }, () => {
  it("reports added on first pass, removed once the server stops", async () => {
    const { server, port } = await startOllama();

    // Iteration 1: service is live → appears as added.
    const first = await watchOnce(null, opts(port));
    assert.equal(first.diff.added.length, 1);
    assert.equal(first.diff.removed.length, 0);

    // Stop the server, then iteration 2 diffs against iteration 1.
    await new Promise<void>((r) => server.close(() => r()));
    const second = await watchOnce(first.result, opts(port));
    assert.equal(second.diff.added.length, 0);
    assert.equal(second.diff.removed.length, 1);
    assert.equal(second.result.services.length, 0);
  });

  it("flattens a diff into ordered events", () => {
    const svc = {
      kind: "llm-api" as const,
      url: "http://127.0.0.1:1",
      api: "ollama" as const,
      status: "available" as const,
      latencyMs: 1,
      models: [],
      source: "port-scan" as const,
      name: "x",
    };
    const events = diffToEvents(
      { added: [svc], removed: [], changed: [] },
      "2026-07-06T00:00:00.000Z",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "added");
  });
});
