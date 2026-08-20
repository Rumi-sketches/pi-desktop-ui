// GET /api/search — the other half of the sidebar search: the words inside the
// messages, read from the session files instead of from the titles.
//
// The chats here are hand-written .jsonl: a header line plus message entries,
// the same shape the SessionManager writes, so the handler is exercised on
// exactly what it meets on disk (malformed lines included).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

// Same isolation as the other endpoint tests: PI_WEB_UI_AGENT_DIR moves this
// project's stores, PI_CODING_AGENT_DIR moves the agent dir of the pi library
// (where the sessions are read from), PI_WEB_UI_TEST=1 makes the first one
// honoured at all. All are read by module-level constants, so they land before
// the dynamic import.
let agentDir;
let sessionsDir;
let server;
let origin;

let clock = Date.parse("2026-01-01T00:00:00.000Z");
// One chat per file, newest last: the handler answers newest first, and the cap
// test needs an order it can predict.
async function writeChat(name, messages) {
  clock += 60_000;
  const stamp = new Date(clock).toISOString();
  const header = { type: "session", version: 3, id: `id-${name}`, cwd: agentDir, timestamp: stamp };
  const lines = [JSON.stringify(header)];
  for (const [role, text] of messages) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `${name}-${lines.length}`,
        timestamp: stamp,
        message: { role, content: [{ type: "text", text }] },
      }),
    );
  }
  const file = path.join(sessionsDir, `${name}.jsonl`);
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-search-endpoint-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  sessionsDir = path.join(agentDir, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });

  // Written first, so they are the oldest: the file budget bites on them and
  // the chats the other tests look for stay well inside the cap. 250 of them
  // plus the ones below put the total past the 300 the scan reads.
  for (let i = 0; i < 250; i++) await writeChat(`filler-${String(i).padStart(3, "0")}`, [["user", "filler chat"]]);

  // the two words live in two different messages, in the reverse order and in
  // another case than the query
  await writeChat("split-words", [
    ["user", "The Docker build keeps failing"],
    ["assistant", "The fix is a missing layer in the image"],
  ]);
  // a chat with one word only: it must never come back
  await writeChat("half-match", [["user", "docker compose up"]]);
  // the word is there, but only outside the text of a user/assistant message
  await writeChat("only-in-tooling", [["user", "run the tests"]]);
  await appendFile(
    path.join(sessionsDir, "only-in-tooling.jsonl"),
    `${JSON.stringify({
      type: "message",
      id: "tool-1",
      timestamp: new Date(clock).toISOString(),
      message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "pineapple" }] },
    })}\n${JSON.stringify({
      type: "message",
      id: "think-1",
      timestamp: new Date(clock).toISOString(),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "pineapple" }] },
    })}\n`,
  );
  // a broken line in the middle must not hide what comes after it
  await writeChat("broken-line", [["user", "before the mess"]]);
  await appendFile(
    path.join(sessionsDir, "broken-line.jsonl"),
    `{ this is not json\n${JSON.stringify({
      type: "message",
      id: "after-1",
      timestamp: new Date(clock).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "kumquat marmalade" }] },
    })}\n`,
  );
  // more chats than the cap, all matching the same word
  for (let i = 0; i < 55; i++) await writeChat(`bulk-${String(i).padStart(2, "0")}`, [["user", "cappuccino please"]]);

  const { startServer } = await import("../server.mjs");
  server = await startServer({ port: 0 });
  origin = server.url.replace(/\/$/, "");
});

after(async () => {
  await server?.stop();
  await rm(agentDir, { recursive: true, force: true });
});

async function search(query) {
  const res = await fetch(`${origin}/api/search?scope=all&q=${encodeURIComponent(query)}`);
  return { status: res.status, body: await res.json() };
}

const pathsOf = (body) => body.sessions.map((s) => path.basename(s.path));

describe("GET /api/search", () => {
  test("all the words match, in any order, across different messages", async () => {
    const { status, body } = await search("FIX docker");
    assert.equal(status, 200);
    assert.ok(pathsOf(body).includes("split-words.jsonl"), "the chat holding both words must be there");
  });

  test("a chat with only some of the words is not a result", async () => {
    const { body } = await search("docker fix");
    assert.ok(!pathsOf(body).includes("half-match.jsonl"));
  });

  test("only user and assistant text is searched, not tool output or thinking", async () => {
    const { body } = await search("pineapple");
    assert.deepEqual(body.sessions, []);
  });

  test("a malformed line is skipped, not fatal: the rest of the file still matches", async () => {
    const { status, body } = await search("kumquat");
    assert.equal(status, 200);
    assert.deepEqual(pathsOf(body), ["broken-line.jsonl"]);
  });

  test("the results carry the same fields as /api/sessions", async () => {
    const { body } = await search("kumquat");
    assert.deepEqual(
      Object.keys(body.sessions[0]).sort(),
      ["cwd", "favorite", "firstMessage", "id", "messageCount", "model", "modified", "name", "path", "provider", "status", "title"],
    );
  });

  test("no more than 50 results, and it says so", async () => {
    const { body } = await search("cappuccino");
    assert.equal(body.sessions.length, 50);
    assert.equal(body.truncated, true);
    // newest first: the last chats written are the ones kept
    assert.equal(pathsOf(body)[0], "bulk-54.jsonl");
  });

  test("the scan stops at 300 files and says which cap it hit", async () => {
    const { body } = await search("rutabaga");
    assert.deepEqual(body.sessions, []);
    assert.equal(body.scanned, 300);
    assert.equal(body.capped, true);
    assert.equal(body.truncated, true);
  });

  test("the chats inside the budget still answer when the scan stops early", async () => {
    // The scan reads on after a match (there may be 50), so a search with few
    // hits ends on the cap: what it did find must come back all the same.
    const { body } = await search("kumquat");
    assert.deepEqual(pathsOf(body), ["broken-line.jsonl"]);
    assert.equal(body.capped, true);
  });

  test("with full search on the scan covers every chat", async () => {
    const on = await fetch(`${origin}/api/full-search`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.status, 200);
    try {
      const { body } = await search("rutabaga");
      assert.equal(body.capped, false);
      assert.equal(body.truncated, false);
      assert.ok(body.scanned > 300, `every chat is read, got ${body.scanned}`);
    } finally {
      await fetch(`${origin}/api/full-search`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ enabled: false }),
      });
    }
  });

  // The handler is called straight, with a request and a response the test
  // owns: an aborted fetch would prove the client gave up, not that the server
  // stopped reading. `writes` is the other half of the promise: nothing may be
  // written on a response that is already gone (DECISIONS.md).
  function fakeExchange({ deadAfter = Infinity } = {}) {
    const req = new EventEmitter();
    let checks = 0;
    const writes = [];
    const res = {
      headersSent: false,
      get destroyed() {
        checks += 1;
        return checks > deadAfter;
      },
      writeHead: (...a) => writes.push(a),
      end: (...a) => writes.push(a),
    };
    // "rutabaga" is in no chat: left alone the scan reads the whole budget
    const url = new URL(`${origin}/api/search?scope=all&q=rutabaga`);
    return { req, res, url, writes, checked: () => checks };
  }

  test("a request the client dropped mid-scan stops the scan and writes nothing", async () => {
    const { handleSearchMessages } = await import("../api-chat.mjs");
    const x = fakeExchange({ deadAfter: 5 });
    await handleSearchMessages({ req: x.req, res: x.res, url: x.url, sessionKey: null });
    assert.deepEqual(x.writes, [], "nothing may be written on a dead response");
    // one check per file: the scan stops on the sixth instead of reading 300
    assert.ok(x.checked() <= 10, `the scan must stop at once, checked ${x.checked()} files`);
  });

  test("a request already closed is not scanned at all", async () => {
    const { handleSearchMessages } = await import("../api-chat.mjs");
    const x = fakeExchange();
    const done = handleSearchMessages({ req: x.req, res: x.res, url: x.url, sessionKey: null });
    // the close listener is registered before the first await, so this lands
    // while the handler is still resolving the context
    x.req.emit("close");
    await done;
    assert.deepEqual(x.writes, []);
    // the close event alone answers "is it gone?": the response is never even
    // asked, and no file is read
    assert.equal(x.checked(), 0, "the loop must break on its first look");
  });

  test("an empty query is a 400, not the whole list", async () => {
    const { status, body } = await search("   ");
    assert.equal(status, 400);
    assert.equal(body.error.code, "missing_query");
  });
});
