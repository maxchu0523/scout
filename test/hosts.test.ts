import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandCidr, expandHosts, MAX_HOSTS } from "../src/discovery/hosts.js";

describe("expandCidr", () => {
  it("expands a /24 excluding network and broadcast", () => {
    const hosts = expandCidr("192.168.1.0/24");
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts[253], "192.168.1.254");
    assert.ok(!hosts.includes("192.168.1.0"));
    assert.ok(!hosts.includes("192.168.1.255"));
  });

  it("normalizes a non-network base address", () => {
    const hosts = expandCidr("192.168.1.50/24");
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts.length, 254);
  });

  it("includes both addresses for a /31", () => {
    assert.deepEqual(expandCidr("10.0.0.0/31"), ["10.0.0.0", "10.0.0.1"]);
  });

  it("returns the single address for a /32", () => {
    assert.deepEqual(expandCidr("10.0.0.5/32"), ["10.0.0.5"]);
  });

  it("rejects an invalid prefix", () => {
    assert.throws(() => expandCidr("10.0.0.0/33"), /invalid CIDR/);
  });

  it("rejects an over-large range", () => {
    assert.throws(() => expandCidr("10.0.0.0/8"), /too large/);
  });
});

describe("expandHosts", () => {
  it("returns a single IP unchanged", () => {
    assert.deepEqual(expandHosts("127.0.0.1"), ["127.0.0.1"]);
  });

  it("passes through a hostname", () => {
    assert.deepEqual(expandHosts("example.com"), ["example.com"]);
  });

  it("passes through a hostname containing a hyphen", () => {
    assert.deepEqual(expandHosts("my-macbook.local"), ["my-macbook.local"]);
  });

  it("expands a CIDR", () => {
    assert.equal(expandHosts("192.168.0.0/30").length, 2);
  });

  it("rejects an explicit IP range with a CIDR hint", () => {
    assert.throws(() => expandHosts("10.0.0.1-10.0.0.3"), /use CIDR/);
  });

  it("rejects a last-octet shorthand range with a CIDR hint", () => {
    assert.throws(() => expandHosts("10.0.0.10-12"), /use CIDR/);
  });

  it("trims whitespace", () => {
    assert.deepEqual(expandHosts("  127.0.0.1  "), ["127.0.0.1"]);
  });

  it("keeps MAX_HOSTS sane", () => {
    assert.ok(MAX_HOSTS > 0 && MAX_HOSTS <= 65536);
  });
});
