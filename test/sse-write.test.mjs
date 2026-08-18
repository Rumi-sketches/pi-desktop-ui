// The one rule every SSE stream of the project obeys (DECISIONS.md, the SSE
// entry): nothing is written to a response that is already gone, and a
// response that dies mid-stream never throws an uncaught error.
// The regression this covers is fatal: an `error` on a response with no
// listener used to take the whole server — and with it the app — down.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { SSE_PING, openSseStream, sseSend, sseWrite } from "../http.mjs";

/** A response that records what reached it. */
function fakeRes(state) {
  return {
    writableEnded: false,
    destroyed: false,
    written: [],
    write(chunk) {
      this.written.push(chunk);
      return true;
    },
    ...state,
  };
}

describe("the SSE write guard", () => {
  test("an ended or destroyed response is never written to", () => {
    const ended = fakeRes({ writableEnded: true });
    const destroyed = fakeRes({ destroyed: true });
    assert.equal(sseWrite(ended, SSE_PING), false);
    assert.equal(sseSend(destroyed, { kind: "usage" }), false);
    assert.deepEqual([...ended.written, ...destroyed.written], [], "nothing may reach a dead response");
  });

  test("a live response gets the frame, JSON-encoded", () => {
    const res = fakeRes();
    assert.equal(sseSend(res, { kind: "terminals" }), true);
    assert.deepEqual(res.written, ['data: {"kind":"terminals"}\n\n']);
  });
});

describe("an SSE stream whose client vanished", () => {
  test("keeps writing without taking the process down", async () => {
    let stream;
    let onOpen;
    const opened = new Promise((resolve) => (onOpen = resolve));
    const server = http.createServer((req, res) => {
      openSseStream(res);
      stream = res;
      onOpen();
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

    // A raw socket, so the disconnection can be as rude as a real one.
    const client = net.connect(port, "127.0.0.1");
    await once(client, "connect");
    client.write("GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await opened;

    assert.equal(sseSend(stream, { kind: "attached" }), true, "a live viewer must get its frames");
    assert.ok(stream.listenerCount("error") > 0, "an SSE response must swallow its own socket errors");

    // The browser goes away without a FIN: the next write fails, and it fails
    // asynchronously — which is precisely what no try/catch could have caught.
    client.resetAndDestroy();
    await once(stream, "close");

    // The keepalive of a stream nobody detached yet, firing on the corpse.
    for (let i = 0; i < 5; i++) {
      assert.equal(sseWrite(stream, SSE_PING), false, "a dead stream refuses the ping");
    }
    // Long enough for a swallowed 'error' to have surfaced as an uncaught
    // exception, which the test runner would report as a failure of this file.
    await new Promise((resolve) => setTimeout(resolve, 100));

    client.destroy();
    server.close();
    await once(server, "close");
  });
});
