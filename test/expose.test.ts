import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ExposeHandle, startExpose } from "../src/server/expose.js";

// Reuse the hermetic stdio MCP echo fixture as the upstream to bridge.
const ECHO = `${process.execPath} --import tsx test/fixtures/echo-server.ts`;

describe("scout expose", { timeout: 30000 }, () => {
  let handle: ExposeHandle;

  before(async () => {
    handle = await startExpose({
      command: ECHO,
      host: "127.0.0.1",
      port: 0,
      noAuth: false,
    });
  });

  after(async () => {
    await handle?.close();
  });

  it("issues a bearer token", () => {
    assert.equal(typeof handle.token, "string");
    assert.equal(handle.token?.length, 64); // 32 bytes hex
  });

  it("rejects unauthenticated requests with 401 + WWW-Authenticate", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
  });

  it("forwards tools/list and tools/call to the upstream", async () => {
    const client = new Client({ name: "expose-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: {
          headers: { authorization: `Bearer ${handle.token}` },
        },
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes("echo"), "echo tool should be proxied");

      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "bridged" },
      })) as { content: Array<{ text?: string }> };
      assert.match(result.content[0]?.text ?? "", /Echo: bridged/);
    } finally {
      await client.close();
    }
  });
});
