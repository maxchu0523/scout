import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { chat } from "../src/invoke/chat.js";

let port: number;
let close: () => Promise<void>;

before(async () => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      // Embedding model listed first — auto-pick should skip it.
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "text-embedding-nomic" }, { id: "test-model" }],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello there" } }],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  close = () => new Promise<void>((r) => server.close(() => r()));
});

after(() => close());

describe("chat", () => {
  it("auto-picks the first non-embedding model and returns the reply", async () => {
    const r = await chat(`http://127.0.0.1:${port}`, "hi", { timeoutMs: 3000 });
    assert.equal(r.model, "test-model"); // skipped text-embedding-nomic
    assert.equal(r.text, "hello there");
  });

  it("uses an explicit model when given", async () => {
    const r = await chat(`http://127.0.0.1:${port}`, "hi", {
      model: "my-model",
      timeoutMs: 3000,
    });
    assert.equal(r.model, "my-model");
    assert.equal(r.text, "hello there");
  });
});
