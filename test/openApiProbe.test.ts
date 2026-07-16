import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { probeOpenApi } from "../src/probe/openApiProbe.js";
import { runScan } from "../src/scan.js";
import type { ScanOptions } from "../src/types.js";

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

function scanOptions(port: number, includeOpenApi: boolean): ScanOptions {
  return {
    hosts: ["127.0.0.1"],
    target: "127.0.0.1",
    ports: [port],
    paths: ["/mcp"],
    includeConfig: false,
    includeAi: true,
    includeOpenApi,
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

const PETSTORE = {
  openapi: "3.1.0",
  info: {
    title: "Petstore",
    description: "A sample API",
    version: "1.2.3",
  },
  paths: {
    "/pets": {
      get: { summary: "List pets" },
      post: { summary: "Create a pet" },
    },
    "/pets/{id}": { get: {} },
  },
};

describe("probeOpenApi", () => {
  it("detects a service exposing /openapi.json", async () => {
    await withServer(
      { "/openapi.json": { status: 200, body: PETSTORE } },
      async (port) => {
        const r = await probeOpenApi("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.kind, "openapi");
        assert.equal(r?.name, "Petstore");
        assert.equal(r?.version, "1.2.3");
        assert.equal(r?.description, "A sample API");
        assert.equal(r?.specPath, "/openapi.json");
        assert.equal(r?.operationCount, 3);
        assert.deepEqual(r?.operations, [
          "GET /pets — List pets",
          "POST /pets — Create a pet",
          "GET /pets/{id}",
        ]);
      },
    );
  });

  it("rejects 200 JSON that is not an OpenAPI document", async () => {
    await withServer(
      { "/openapi.json": { status: 200, body: { hello: "world" } } },
      async (port) => {
        const r = await probeOpenApi("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r, null);
      },
    );
  });

  it("caps operations at 20 but counts them all", async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) paths[`/things/${i}`] = { get: {} };
    await withServer(
      {
        "/swagger.json": {
          status: 200,
          body: { swagger: "2.0", info: { title: "Big" }, paths },
        },
      },
      async (port) => {
        const r = await probeOpenApi("127.0.0.1", port, { timeoutMs: 2000 });
        assert.equal(r?.specPath, "/swagger.json");
        assert.equal(r?.operationCount, 25);
        assert.equal(r?.operations.length, 20);
      },
    );
  });

  it("is not reported by a default scan (opt-in only)", async () => {
    await withServer(
      { "/openapi.json": { status: 200, body: PETSTORE } },
      async (port) => {
        const off = await runScan(scanOptions(port, false));
        assert.equal(off.services.length, 0);
        const on = await runScan(scanOptions(port, true));
        assert.deepEqual(
          on.services.map((s) => s.kind),
          ["openapi"],
        );
      },
    );
  });

  it("is suppressed when the same origin is already a verified AI API", async () => {
    await withServer(
      {
        "/openapi.json": { status: 200, body: PETSTORE },
        "/v1/models": {
          status: 200,
          body: { object: "list", data: [{ id: "m" }] },
        },
      },
      async (port) => {
        const r = await runScan(scanOptions(port, true));
        assert.deepEqual(
          r.services.map((s) => s.kind),
          ["llm-api"],
        );
      },
    );
  });
});
