import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverFromConfig } from "../src/discovery/config.js";

let dir: string;
const path = (name: string) => join(dir, name);

const MIXED = {
  mcpServers: {
    "http-one": { type: "http", url: "https://example.com/mcp" },
    "sse-one": { type: "sse", url: "https://example.com/sse" },
    "stdio-one": { command: "npx", args: ["-y", "@scope/server"] },
    empty: {},
  },
  projects: {
    "/proj": {
      mcpServers: { "proj-http": { url: "http://localhost:9/mcp" } },
    },
  },
};

const VSCODE = {
  mcp: { servers: { "vs-one": { url: "http://localhost:1/mcp" } } },
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "scout-cfg-"));
  writeFileSync(path("mixed.json"), JSON.stringify(MIXED));
  writeFileSync(path("vscode.json"), JSON.stringify(VSCODE));
  writeFileSync(path("broken.json"), "{ not valid json ");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverFromConfig", () => {
  it("parses http, sse, stdio, and nested project servers; skips empty", async () => {
    const c = await discoverFromConfig([path("mixed.json")], false);
    const byName = new Map(c.map((x) => [x.name, x]));

    assert.equal(c.length, 4, "empty {} entry must be skipped");
    assert.equal(byName.get("http-one")?.transport, "streamable-http");
    assert.equal(byName.get("sse-one")?.transport, "sse");
    assert.equal(byName.get("proj-http")?.transport, "streamable-http");

    const stdio = byName.get("stdio-one");
    assert.equal(stdio?.transport, "stdio");
    assert.equal(stdio?.stdio?.command, "npx");
    assert.deepEqual(stdio?.stdio?.args, ["-y", "@scope/server"]);
    assert.equal(stdio?.url, "npx -y @scope/server");
  });

  it("tags every candidate with source=config", async () => {
    const c = await discoverFromConfig([path("mixed.json")], false);
    assert.ok(c.every((x) => x.source === "config"));
  });

  it("understands the VS Code mcp.servers shape", async () => {
    const c = await discoverFromConfig([path("vscode.json")], false);
    assert.equal(c.length, 1);
    assert.equal(c[0].name, "vs-one");
    assert.equal(c[0].transport, "streamable-http");
  });

  it("dedupes identical entries across files", async () => {
    const c = await discoverFromConfig(
      [path("mixed.json"), path("mixed.json")],
      false,
    );
    assert.equal(c.length, 4);
  });

  it("ignores missing files", async () => {
    const c = await discoverFromConfig([path("does-not-exist.json")], false);
    assert.deepEqual(c, []);
  });

  it("ignores invalid JSON without throwing", async () => {
    const c = await discoverFromConfig([path("broken.json")], false);
    assert.deepEqual(c, []);
  });
});
