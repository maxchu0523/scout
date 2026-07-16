import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Spin up Scout-as-an-MCP-server (run from source via tsx) and drive it with a
// real MCP client, exercising the full discovery-over-MCP loop.
let client: Client;

function textOf(res: unknown): string {
  const content = (res as { content: Array<{ text?: string }> }).content;
  return content[0]?.text ?? "";
}

describe("scout serve (MCP server)", { timeout: 30000 }, () => {
  before(async () => {
    // Isolate the registry so the scan the server runs can't touch ~/.scout.
    const home = await mkdtemp(path.join(tmpdir(), "scout-serve-"));
    client = new Client({ name: "scout-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "serve"],
        stderr: "ignore",
        env: { ...process.env, SCOUT_HOME: home },
      }),
    );
  });

  after(async () => {
    await client?.close();
  });

  it("exposes the discovery tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "list_ai_services",
      "list_available_mcps",
      "probe_mcp",
    ]);
  });

  it("list_available_mcps returns a valid canonical result", async () => {
    const res = await client.callTool({
      name: "list_available_mcps",
      arguments: { ports: "59999", includeConfig: false },
    });
    const parsed = JSON.parse(textOf(res));
    assert.equal(parsed.target, "127.0.0.1");
    assert.ok(Array.isArray(parsed.services));
    assert.equal(parsed.scanned.openPorts, 0);
  });

  it("list_ai_services returns only llm-api services", async () => {
    const res = await client.callTool({
      name: "list_ai_services",
      arguments: { ports: "59999" },
    });
    const parsed = JSON.parse(textOf(res));
    assert.ok(Array.isArray(parsed.services));
    assert.ok(
      parsed.services.every((s: { kind: string }) => s.kind === "llm-api"),
    );
  });

  it("probe_mcp returns null for an unreachable URL", async () => {
    const res = await client.callTool({
      name: "probe_mcp",
      arguments: { url: "http://127.0.0.1:59999/mcp", timeoutMs: 1000 },
    });
    assert.equal(JSON.parse(textOf(res)), null);
  });
});
