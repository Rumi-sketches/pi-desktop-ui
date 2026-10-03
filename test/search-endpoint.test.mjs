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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Server } from "node:http";
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

const SKILL_BODY_SENTINEL = "SECRET_SKILL_SEARCH_BODY";
const SKILL_TEXT = `<skill name="release-check" location="C:/skills/release-check/SKILL.md">\n${SKILL_BODY_SENTINEL}\n</skill>\n\npublic-argument`;

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
  // Persisted skill text contains its full instructions for the model. Search
  // and result previews may expose only the semantic invocation and arguments.
  await writeChat("skill-expanded", [["user", SKILL_TEXT]]);
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
  test("a cold sidebar lookup reads all three archives asynchronously once", async () => {
    const paths = ["web-ui-titles.json", "web-ui-favorites.json", "web-ui-status.json"]
      .map((name) => path.join(agentDir, name));
    const originalSync = fs.readFileSync;
    const originalAsync = fs.promises.readFile;
    const syncReads = new Map(paths.map((file) => [file, 0]));
    const asyncReads = new Map(paths.map((file) => [file, 0]));
    Object.defineProperty(fs, "readFileSync", { configurable: true, value: (file, ...args) => {
      if (syncReads.has(file)) syncReads.set(file, syncReads.get(file) + 1);
      return originalSync(file, ...args);
    } });
    Object.defineProperty(fs.promises, "readFile", { configurable: true, value: async (file, ...args) => {
      if (asyncReads.has(file)) asyncReads.set(file, asyncReads.get(file) + 1);
      return originalAsync(file, ...args);
    } });
    syncBuiltinESMExports();
    try {
      assert.equal((await search("cappuccino")).body.sessions.length, 50);
      assert.deepEqual(paths.map((file) => asyncReads.get(file)), [1, 1, 1]);
      assert.deepEqual(paths.map((file) => syncReads.get(file)), [0, 0, 0]);
    } finally {
      fs.readFileSync = originalSync;
      fs.promises.readFile = originalAsync;
      syncBuiltinESMExports();
    }
  });

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

  test("skill search sees its compact mention and arguments, never hidden instructions", async () => {
    assert.deepEqual((await search(SKILL_BODY_SENTINEL)).body.sessions, []);
    const { body } = await search("release-check public-argument");
    assert.deepEqual(pathsOf(body), ["skill-expanded.jsonl"]);
    assert.equal(JSON.stringify(body).includes(SKILL_BODY_SENTINEL), false);
    assert.equal(body.sessions[0].firstMessage, "/skill:release-check public-argument");
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
      ["branch", "cwd", "favorite", "firstMessage", "id", "issues", "messageCount", "model", "modified", "name", "path", "provider", "pullRequests", "status", "thinkingLevel", "title"],
    );
  });

  test("list and search read each shared archive once per response and see later writes", async () => {
    const files = ["web-ui-titles.json", "web-ui-favorites.json", "web-ui-status.json"];
    const target = path.join(sessionsDir, "bulk-54.jsonl");
    const paths = files.map((name) => path.join(agentDir, name));
    const originalSync = fs.readFileSync;
    const originalAsync = fs.promises.readFile;
    const syncReads = new Map(paths.map((file) => [file, 0]));
    const asyncReads = new Map(paths.map((file) => [file, 0]));
    Object.defineProperty(fs, "readFileSync", { configurable: true, value: (file, ...args) => {
      if (syncReads.has(file)) syncReads.set(file, syncReads.get(file) + 1);
      return originalSync(file, ...args);
    } });
    Object.defineProperty(fs.promises, "readFile", { configurable: true, value: async (file, ...args) => {
      if (asyncReads.has(file)) asyncReads.set(file, asyncReads.get(file) + 1);
      return originalAsync(file, ...args);
    } });
    syncBuiltinESMExports();
    try {
      async function check(url, title, favorite, status) {
        syncReads.forEach((_, file) => syncReads.set(file, 0));
        asyncReads.forEach((_, file) => asyncReads.set(file, 0));
        const response = await fetch(`${origin}${url}`);
        assert.equal(response.status, 200);
        const { sessions } = await response.json();
        assert.ok(sessions.length >= 50);
        const row = sessions.find((s) => s.path === target);
        assert.equal(row?.title, title);
        assert.equal(row.favorite, favorite);
        assert.equal(row.status, status);
        assert.deepEqual(paths.map((file) => asyncReads.get(file)), [1, 1, 1]);
        assert.deepEqual(paths.map((file) => syncReads.get(file)), [0, 0, 0]);
      }
      await writeFile(paths[0], JSON.stringify({ [target]: "External title one" }));
      await writeFile(paths[1], JSON.stringify([target]));
      await writeFile(paths[2], JSON.stringify({ [target]: "done" }));
      await check("/api/sessions?scope=all", "External title one", true, "done");
      await writeFile(paths[0], JSON.stringify({ [target]: "External title two" }));
      await writeFile(paths[1], "[]");
      await writeFile(paths[2], "{}");
      await check("/api/search?scope=all&q=cappuccino", "External title two", false, "active");
    } finally {
      fs.readFileSync = originalSync;
      fs.promises.readFile = originalAsync;
      syncBuiltinESMExports();
      await Promise.all(paths.map((file) => rm(file, { force: true })));
    }
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

  // Observe only Node's HTTP and filesystem boundaries, leaving the route and
  // streams real. Discovery opens every jsonl once; a second opening is the
  // content scan. Waiting for the HTTP listener's promise makes the final
  // read/write assertions deterministic, without sleeps after a client abort.
  async function observeDroppedSearch(afterReads) {
    const pathname = `/api/search?scope=all&q=rutabaga&abort-test=${afterReads}`;
    const originalEmit = Server.prototype.emit;
    const originalReadStream = fs.createReadStream;
    let complete, fail;
    const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const openings = new Map();
    const reads = [];
    const readsAfterClose = [];
    const writes = [];
    let exchange;
    let closed = false;
    let readsAtClose;
    let client;

    Server.prototype.emit = function (event, ...args) {
      const [req, res] = args;
      if (event !== "request" || req.url !== pathname) return originalEmit.call(this, event, ...args);
      exchange = { req, res };
      for (const method of ["writeHead", "write", "end"]) {
        const original = res[method];
        res[method] = function (...values) {
          writes.push({ method, values });
          return original.apply(this, values);
        };
      }
      // These are the real server's public request listeners, not a substitute
      // handler. Retain their promises so assertions run after routing finishes.
      Promise.all(this.listeners("request").map((listener) => listener.call(this, req, res)))
        .then(() => complete(), fail);
      return true;
    };
    fs.createReadStream = function (file, ...args) {
      const stream = originalReadStream.call(this, file, ...args);
      if (!exchange || path.dirname(String(file)) !== sessionsDir || !String(file).endsWith(".jsonl")) return stream;
      const count = (openings.get(file) ?? 0) + 1;
      openings.set(file, count);
      if (count > 1) {
        reads.push(file);
        if (closed) readsAfterClose.push(file);
      }
      if (!closed && (afterReads === 0 || reads.length === afterReads)) {
        closed = true;
        readsAtClose = reads.length;
        if (afterReads === 0) {
          // Close while discovery is pending, before any content scan. Keep
          // res writable to prove the request-close signal alone stops work.
          exchange.req.emit("close");
        } else {
          // Synchronous server-side destruction at the Nth real scan opening:
          // no dependence on when a client-side abort reaches the server.
          exchange.res.destroy();
        }
      }
      return stream;
    };
    syncBuiltinESMExports();
    try {
      client = fetch(`${origin}${pathname}`).then((res) => res.text()).catch(() => null);
      await completed;
      assert.equal(closed, true, "the disconnect boundary must be reached");
      assert.equal(readsAtClose, afterReads);
      assert.equal(reads.length, afterReads, "no further content file may be opened");
      assert.deepEqual(readsAfterClose, [], "no content read after disconnection");
      assert.deepEqual(writes, [], "no headers, body or end on a dropped response");
    } finally {
      exchange?.res.destroy();
      if (client) await client;
      Server.prototype.emit = originalEmit;
      fs.createReadStream = originalReadStream;
      syncBuiltinESMExports();
    }
  }

  test("a request the client dropped mid-scan stops the scan and writes nothing", { timeout: 15000 }, async () => {
    await observeDroppedSearch(5);
  });

  test("a request already closed is not scanned at all", { timeout: 15000 }, async () => {
    await observeDroppedSearch(0);
  });

  test("an empty query is a 400, not the whole list", async () => {
    const { status, body } = await search("   ");
    assert.equal(status, 400);
    assert.equal(body.error.code, "missing_query");
  });
});
