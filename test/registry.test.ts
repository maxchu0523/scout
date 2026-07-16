import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addServer, removeServer } from "../src/registry/commands.js";
import {
  loadRegistry,
  registryPath,
  saveRegistry,
  upsertEntry,
} from "../src/registry/store.js";
import type { RegistryEntry } from "../src/registry/types.js";
import { runScan } from "../src/scan.js";
import type { ScanOptions } from "../src/types.js";

/** Minimal Ollama-shaped AI fixture so a manual llm-api entry verifies. */
async function withOllama(
  fn: (host: string, port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.1" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn("127.0.0.1", port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function scanOpts(port: number, over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    hosts: ["127.0.0.1"],
    target: "127.0.0.1",
    ports: [port],
    paths: ["/mcp"],
    includeConfig: false,
    includeAi: true,
    includeOpenApi: false,
    includeManual: true,
    record: false,
    extraConfigPaths: [],
    connectTimeoutMs: 500,
    timeoutMs: 2000,
    portConcurrency: 10,
    probeConcurrency: 5,
    transport: "auto",
    ...over,
  };
}

/** Spawn args for the hermetic stdio MCP echo fixture. */
const ECHO_STDIO = `${process.execPath} --import tsx test/fixtures/echo-server.ts`;

let home: string;
const prevHome = process.env.SCOUT_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "scout-reg-"));
  process.env.SCOUT_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SCOUT_HOME;
  else process.env.SCOUT_HOME = prevHome;
});

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "mcp:127.0.0.1:9000",
    kind: "mcp",
    name: "image-tools",
    url: "http://127.0.0.1:9000/mcp",
    transport: "streamable-http",
    addedAt: "2026-07-05T10:00:00.000Z",
    addedBy: "manual",
    firstSeenAt: "2026-07-05T10:00:00.000Z",
    lastSeenAt: "2026-07-05T10:00:00.000Z",
    lastStatus: "available",
    ...over,
  };
}

describe("registry store", () => {
  it("returns an empty registry when the file is missing", async () => {
    const reg = await loadRegistry();
    assert.deepEqual(reg, { version: 1, entries: [] });
  });

  it("round-trips through save/load", async () => {
    const reg = { version: 1 as const, entries: [entry()] };
    await saveRegistry(reg);
    assert.deepEqual(await loadRegistry(), reg);
  });

  it("throws with the path when the file is corrupt", async () => {
    await saveRegistry({ version: 1, entries: [] });
    await writeFile(registryPath(), "{ not json", "utf8");
    await assert.rejects(loadRegistry(), (e: Error) =>
      e.message.includes(registryPath()),
    );
  });

  it("leaves no .tmp file behind after an atomic save", async () => {
    await saveRegistry({ version: 1, entries: [entry()] });
    const files = await readdir(home);
    assert.ok(files.includes("registry.json"));
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
  });

  it("upsert replaces by id and preserves firstSeenAt/addedAt", () => {
    const reg = { version: 1 as const, entries: [entry()] };
    const updated = upsertEntry(
      reg,
      entry({
        name: "renamed",
        addedAt: "2099-01-01T00:00:00.000Z",
        firstSeenAt: "2099-01-01T00:00:00.000Z",
        lastStatus: "auth-required",
      }),
    );
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].name, "renamed");
    assert.equal(updated.entries[0].lastStatus, "auth-required");
    // originals preserved:
    assert.equal(updated.entries[0].addedAt, "2026-07-05T10:00:00.000Z");
    assert.equal(updated.entries[0].firstSeenAt, "2026-07-05T10:00:00.000Z");
  });

  it("upsert appends a new id", () => {
    const reg = { version: 1 as const, entries: [entry()] };
    const updated = upsertEntry(reg, entry({ id: "llm-api:127.0.0.1:11434" }));
    assert.equal(updated.entries.length, 2);
  });
});

describe("registry commands", { timeout: 30000 }, () => {
  const now = "2026-07-06T00:00:00.000Z";

  it("adds a verified stdio server", async () => {
    const { entry: e, verified } = await addServer({
      stdio: ECHO_STDIO,
      name: "echo",
      force: false,
      now,
    });
    assert.equal(verified, true);
    assert.equal(e.kind, "mcp");
    assert.equal(e.transport, "stdio");
    assert.equal(e.lastStatus, "available");
    const reg = await loadRegistry();
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].name, "echo");
  });

  it("rejects an unreachable server without --force", async () => {
    await assert.rejects(
      addServer({
        url: "http://127.0.0.1:59998/mcp",
        name: "dead",
        force: false,
        now,
      }),
      /not reachable/,
    );
    assert.equal((await loadRegistry()).entries.length, 0);
  });

  it("stores an unreachable server with --force", async () => {
    const { entry: e, verified } = await addServer({
      url: "http://127.0.0.1:59998/mcp",
      name: "dead",
      force: true,
      now,
    });
    assert.equal(verified, false);
    assert.equal(e.lastStatus, "unreachable");
    assert.equal(e.lastSeenAt, undefined);
  });

  it("upserts rather than duplicating on re-add", async () => {
    await addServer({ stdio: ECHO_STDIO, name: "echo", now });
    await addServer({ stdio: ECHO_STDIO, name: "echo-renamed", now });
    const reg = await loadRegistry();
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].name, "echo-renamed");
  });

  it("removes by name and throws when ambiguous", async () => {
    await saveRegistry({
      version: 1,
      entries: [
        entry({ id: "a", name: "dup", url: "http://127.0.0.1:1/mcp" }),
        entry({ id: "b", name: "dup", url: "http://127.0.0.1:2/mcp" }),
      ],
    });
    await assert.rejects(removeServer("dup"), /ambiguous/);
    // exact id still works:
    const removed = await removeServer("a");
    assert.equal(removed.id, "a");
    assert.equal((await loadRegistry()).entries.length, 1);
  });
});

describe("manual entries in the scan", { timeout: 30000 }, () => {
  it("surfaces a live manual llm-api entry as source=manual", async () => {
    await withOllama(async (host, port) => {
      await saveRegistry({
        version: 1,
        entries: [
          entry({
            id: `llm-api:${host}:${port}`,
            kind: "llm-api",
            name: "my-ollama",
            url: `http://${host}:${port}`,
            transport: undefined,
            api: "ollama",
          }),
        ],
      });
      // Scan a *different* (closed) port — the entry is only found via registry.
      const result = await runScan(scanOpts(port + 1));
      const svc = result.services.find((s) => s.kind === "llm-api");
      assert.ok(svc, "manual llm-api should appear");
      assert.equal(svc?.source, "manual");
      // and its lastSeenAt was refreshed:
      const reg = await loadRegistry();
      assert.equal(reg.entries[0].lastStatus, "available");
      assert.ok(reg.entries[0].lastSeenAt);
    });
  });

  it("marks a dead manual entry unreachable and omits it from services", async () => {
    await saveRegistry({
      version: 1,
      entries: [
        entry({
          id: "mcp:127.0.0.1:59997",
          name: "dead",
          url: "http://127.0.0.1:59997/mcp",
        }),
      ],
    });
    const result = await runScan(scanOpts(59996));
    assert.equal(result.services.length, 0);
    const reg = await loadRegistry();
    assert.equal(reg.entries[0].lastStatus, "unreachable");
  });

  it("--record persists a port-scan discovery", async () => {
    await withOllama(async (_host, port) => {
      // Registry starts empty; scanning the live port with record should store it.
      const result = await runScan(
        scanOpts(port, { includeManual: false, record: true }),
      );
      assert.ok(result.services.some((s) => s.kind === "llm-api"));
      const reg = await loadRegistry();
      assert.equal(reg.entries.length, 1);
      assert.equal(reg.entries[0].addedBy, "scan");
      assert.equal(reg.entries[0].api, "ollama");
    });
  });
});
