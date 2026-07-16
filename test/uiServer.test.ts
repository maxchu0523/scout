import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startUiServer, type UiServerHandle } from "../src/server/ui.js";
import type { ScanResult } from "../src/types.js";

let handle: UiServerHandle;
const prevHome = process.env.SCOUT_HOME;

beforeEach(async () => {
  process.env.SCOUT_HOME = await mkdtemp(path.join(tmpdir(), "scout-ui-"));
  handle = await startUiServer({ preferredPort: 0 });
});

afterEach(async () => {
  await handle.close();
  if (prevHome === undefined) delete process.env.SCOUT_HOME;
  else process.env.SCOUT_HOME = prevHome;
});

describe("ui server", { timeout: 30000 }, () => {
  it("serves /api/version", async () => {
    const r = await fetch(`${handle.url}/api/version`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { version: string };
    assert.equal(typeof body.version, "string");
  });

  it("serves an empty registry", async () => {
    const r = await fetch(`${handle.url}/api/registry`);
    const body = (await r.json()) as { version: number; entries: unknown[] };
    assert.equal(body.version, 1);
    assert.deepEqual(body.entries, []);
  });

  it("streams scan events and ends with a ScanResult", async () => {
    // Scan a tiny closed port range on loopback — fast, deterministic.
    const r = await fetch(
      `${handle.url}/api/scan?host=127.0.0.1&ports=59990-59991`,
    );
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await r.text();
    assert.match(text, /event: phase/);
    assert.match(text, /event: done/);

    // The `done` event's data parses as a ScanResult.
    const doneLine = text
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes('"type":"done"'));
    assert.ok(doneLine, "a done event should be present");
    const payload = JSON.parse(doneLine.slice("data:".length).trim()) as {
      result: ScanResult;
    };
    assert.ok(Array.isArray(payload.result.services));
    assert.equal(typeof payload.result.scannedAt, "string");
  });

  it("returns 409 for a concurrent scan", async () => {
    // Start one scan but don't await it (holds the lock).
    const first = fetch(`${handle.url}/api/scan?host=127.0.0.1&ports=1-2000`);
    // Give the server a tick to set scanning=true.
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(
      `${handle.url}/api/scan?host=127.0.0.1&ports=80`,
    );
    assert.equal(second.status, 409);
    await (await first).text(); // drain
  });

  it("rejects path traversal", async () => {
    const r = await fetch(`${handle.url}/../package.json`, {
      redirect: "manual",
    });
    assert.ok(r.status >= 400, `expected 4xx/5xx, got ${r.status}`);
  });

  it("404s unknown /api routes", async () => {
    const r = await fetch(`${handle.url}/api/nope`);
    assert.equal(r.status, 404);
  });
});
