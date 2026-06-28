import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PORTS, mapPool, parsePorts } from "../src/util/pool.js";

describe("parsePorts", () => {
  it("parses a single port", () => {
    assert.deepEqual(parsePorts("3000"), [3000]);
  });

  it("parses a comma list", () => {
    assert.deepEqual(parsePorts("3000,8080"), [3000, 8080]);
  });

  it("expands a range", () => {
    assert.deepEqual(parsePorts("1-3"), [1, 2, 3]);
  });

  it("normalizes a reversed range and sorts output", () => {
    assert.deepEqual(parsePorts("8080-8078"), [8078, 8079, 8080]);
  });

  it("dedupes repeats", () => {
    assert.deepEqual(parsePorts("80,80,80"), [80]);
  });

  it("drops invalid and out-of-range entries", () => {
    assert.deepEqual(parsePorts("0,70000,abc,443"), [443]);
  });

  it("tolerates whitespace", () => {
    assert.deepEqual(parsePorts(" 80 , 443 "), [80, 443]);
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(parsePorts(""), []);
  });
});

describe("DEFAULT_PORTS", () => {
  it("are all valid TCP ports", () => {
    for (const p of DEFAULT_PORTS) {
      assert.ok(Number.isInteger(p) && p >= 1 && p <= 65535, `bad port ${p}`);
    }
  });

  it("includes common dev port 3000", () => {
    assert.ok(DEFAULT_PORTS.includes(3000));
  });
});

describe("mapPool", () => {
  it("maps preserving input order", async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (x) => x * 2);
    assert.deepEqual(out, [2, 4, 6, 8]);
  });

  it("handles an empty array", async () => {
    const out = await mapPool([], 4, async (x) => x);
    assert.deepEqual(out, []);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapPool(items, 3, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x;
    });
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`);
  });
});
