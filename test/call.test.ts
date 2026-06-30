import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/invoke/call.js";

const stdioTarget = {
  url: "echo-fixture",
  transport: "auto" as const,
  stdio: {
    command: process.execPath,
    args: ["--import", "tsx", "test/fixtures/echo-server.ts"],
  },
};

describe("callMcpTool", { timeout: 30000 }, () => {
  it("invokes a tool and returns its text result", async () => {
    const r = await callMcpTool(
      stdioTarget,
      "echo",
      { message: "scout" },
      20000,
    );
    assert.equal(r.isError, false);
    assert.match(r.text, /Echo: scout/);
  });

  it("rejects when the server can't be reached", async () => {
    await assert.rejects(
      callMcpTool(
        { url: "http://127.0.0.1:59999/mcp", transport: "http" },
        "echo",
        {},
        1500,
      ),
      /could not connect/,
    );
  });
});
