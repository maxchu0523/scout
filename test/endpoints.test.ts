import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEndpointCandidates } from "../src/discovery/endpoints.js";

describe("buildEndpointCandidates", () => {
  it("builds one candidate per port × path", () => {
    const c = buildEndpointCandidates("127.0.0.1", [3000], ["/mcp", "/sse"]);
    assert.equal(c.length, 2);
    assert.equal(c[0].url, "http://127.0.0.1:3000/mcp");
    assert.equal(c[1].url, "http://127.0.0.1:3000/sse");
  });

  it("hints sse transport for /sse paths, http otherwise", () => {
    const [mcp, sse] = buildEndpointCandidates(
      "127.0.0.1",
      [3000],
      ["/mcp", "/sse"],
    );
    assert.equal(mcp.transport, "streamable-http");
    assert.equal(sse.transport, "sse");
  });

  it("collapses the root path to no trailing slash", () => {
    const [c] = buildEndpointCandidates("127.0.0.1", [8080], ["/"]);
    assert.equal(c.url, "http://127.0.0.1:8080");
  });

  it("uses https for TLS ports", () => {
    const [c] = buildEndpointCandidates("127.0.0.1", [443], ["/mcp"]);
    assert.equal(c.url, "https://127.0.0.1:443/mcp");
  });

  it("brackets IPv6 hosts", () => {
    const [c] = buildEndpointCandidates("::1", [3000], ["/mcp"]);
    assert.equal(c.url, "http://[::1]:3000/mcp");
  });

  it("normalizes paths missing a leading slash", () => {
    const [c] = buildEndpointCandidates("127.0.0.1", [3000], ["mcp"]);
    assert.equal(c.url, "http://127.0.0.1:3000/mcp");
  });

  it("tags candidates as port-scan source", () => {
    const [c] = buildEndpointCandidates("127.0.0.1", [3000], ["/mcp"]);
    assert.equal(c.source, "port-scan");
  });

  it("returns nothing when there are no open ports", () => {
    assert.deepEqual(buildEndpointCandidates("127.0.0.1", [], ["/mcp"]), []);
  });
});
