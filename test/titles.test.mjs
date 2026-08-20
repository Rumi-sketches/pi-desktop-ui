// Chat titles: what the sidebar shows while the summary is not there yet, what
// it shows once it is, and the three ways a summary can fail without the user
// ever noticing. No request leaves this file: `fetch` is replaced by a stub, so
// a green run proves the fallbacks work offline too.
//
// The feature is off by default, so most of the file runs with the switch
// turned on and with chats created after that instant — the only shape that
// generates anything. The tests at the bottom pin the other side: switch off,
// chat older than the switch, and the explicit backfill that ignores both.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

// AGENT_DIR is a module-level constant, so the override has to land before the
// dynamic import below. PI_WEB_UI_TEST=1 is what makes it honoured at all.
let agentDir;
let titles;
let store;
const realFetch = globalThis.fetch;
// A chat created right now: newer than the switch, hence covered by it.
const justCreated = () => new Date();
/** Every request the module made, in order. */
let calls;

// A credential shaped like the one pi writes for an Anthropic subscription.
const oauthCredential = (expires) => ({
  anthropic: { type: "oauth", access: "sk-ant-oat01-test", refresh: "sk-ant-ort01-test", expires },
});

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

const answering = (title) =>
  new Response(JSON.stringify({ content: [{ type: "text", text: title }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const writeAuth = (data) => writeFile(path.join(agentDir, "auth.json"), JSON.stringify(data));

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-titles-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  titles = await import("../titles.mjs");
  store = await import("../session-store.mjs");
  // Off is the default and the subject of its own test below; everything else
  // needs the switch on to have anything to observe.
  await store.setTitleGenerationEnabled(true);
});

after(async () => {
  globalThis.fetch = realFetch;
  await rm(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

test("fallbackTitle: one line, collapsed whitespace, cut when too long", () => {
  assert.equal(titles.fallbackTitle("  fix the\n  docker build  "), "fix the docker build");
  assert.equal(titles.fallbackTitle(""), "");
  assert.equal(titles.fallbackTitle(undefined), "");
  const long = titles.fallbackTitle("x".repeat(500));
  assert.equal(long.length, 101); // 100 characters plus the ellipsis
  assert.ok(long.endsWith("…"));
});

test("a chat with no cached title falls back at once and is summarized in the background", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => answering("Fix del container docker"));

  const first = await titles.titleFor("/sessions/a.jsonl", "ciao, mi si rompe il container docker", justCreated());
  assert.equal(first, "ciao, mi si rompe il container docker"); // the old truncation

  await titles.flushTitleQueue();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-ant-oat01-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "claude-haiku-4-5");
  assert.match(body.system[0].text, /^You are Claude Code/);
  assert.equal(await titles.titleFor("/sessions/a.jsonl", "ciao, mi si rompe il container docker"), "Fix del container docker");
});

test("a title already in the cache is never generated again", async () => {
  stubFetch(() => {
    throw new Error("the cache must answer without a request");
  });

  assert.equal(await titles.titleFor("/sessions/a.jsonl", "whatever it was"), "Fix del container docker");
  assert.equal(calls.length, 0);

  const cached = JSON.parse(await readFile(path.join(agentDir, "web-ui-titles.json"), "utf8"));
  assert.equal(cached["/sessions/a.jsonl"], "Fix del container docker");
});

test("an expired token means no request at all, and the fallback stands", async () => {
  await writeAuth(oauthCredential(Date.now() - 1_000));
  stubFetch(() => answering("never asked for"));

  assert.equal(await titles.titleFor("/sessions/b.jsonl", "expired token chat", justCreated()), "expired token chat");
  await titles.flushTitleQueue();

  assert.equal(calls.length, 0);
  assert.equal(await titles.titleFor("/sessions/b.jsonl", "expired token chat", justCreated()), "expired token chat");
});

test("a missing credential is not an error either", async () => {
  await writeAuth({});
  stubFetch(() => answering("never asked for"));

  assert.equal(await titles.titleFor("/sessions/c.jsonl", "no credential chat", justCreated()), "no credential chat");
  await titles.flushTitleQueue();

  assert.equal(calls.length, 0);
});

test("a refused request leaves the chat on its fallback, caches nothing and is not retried at once", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => new Response("upstream is down", { status: 500 }));

  const t0 = Date.parse("2026-08-19T10:00:00Z");
  assert.equal(await titles.titleFor("/sessions/d.jsonl", "server error chat", justCreated(), t0), "server error chat");
  await titles.flushTitleQueue();

  assert.equal(calls.length, 1);

  // nothing was cached, so the row keeps its fallback — but the failure is not
  // chased at every refresh of the list: the next attempt is ten minutes away.
  const oneMinuteLater = t0 + 60_000;
  assert.equal(
    await titles.titleFor("/sessions/d.jsonl", "server error chat", justCreated(), oneMinuteLater),
    "server error chat",
  );
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);

  const cached = JSON.parse(await readFile(path.join(agentDir, "web-ui-titles.json"), "utf8"));
  assert.equal(cached["/sessions/d.jsonl"], undefined);
});

test("a failing chat gets three attempts, ten minutes apart, and then no more", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => new Response("upstream is down", { status: 500 }));

  const t0 = Date.parse("2026-08-19T12:00:00Z");
  const minutes = (n) => t0 + n * 60_000;
  const listAt = async (now) => {
    await titles.titleFor("/sessions/flaky.jsonl", "flaky chat", justCreated(), now);
    await titles.flushTitleQueue();
  };

  await listAt(t0); // first attempt
  assert.equal(calls.length, 1);

  await listAt(minutes(9)); // too soon: the window is ten minutes
  assert.equal(calls.length, 1);

  await listAt(minutes(10)); // second attempt
  assert.equal(calls.length, 2);

  await listAt(minutes(21)); // third and last attempt
  assert.equal(calls.length, 3);

  await listAt(minutes(40));
  await listAt(minutes(60 * 24)); // a day later: the budget is spent for good
  assert.equal(calls.length, 3);

  // the explicit backfill does not buy extra attempts either
  assert.equal(
    await titles.queueMissingTitles([{ path: "/sessions/flaky.jsonl", firstMessage: "flaky chat" }], minutes(60 * 24)),
    0,
  );
  await titles.flushTitleQueue();
  assert.equal(calls.length, 3);
});

test("a request that never left does not spend an attempt", async () => {
  await writeAuth({}); // no credential: the queue is dropped before any fetch
  stubFetch(() => answering("never asked for"));

  const t0 = Date.parse("2026-08-19T14:00:00Z");
  await titles.titleFor("/sessions/tokenless.jsonl", "tokenless chat", justCreated(), t0);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0);

  // once the credential is back the chat is summarized right away, without
  // waiting out a ten minute window it never earned
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => answering("Chat senza token"));
  await titles.titleFor("/sessions/tokenless.jsonl", "tokenless chat", justCreated(), t0 + 1_000);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);
  assert.equal(await titles.titleFor("/sessions/tokenless.jsonl", "tokenless chat"), "Chat senza token");
});

test("a network failure is swallowed, the queue survives it", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });

  assert.equal(await titles.titleFor("/sessions/e.jsonl", "offline chat", justCreated()), "offline chat");
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);

  stubFetch(() => answering("A working title"));
  await titles.titleFor("/sessions/f.jsonl", "second chat", justCreated());
  await titles.flushTitleQueue();
  assert.equal(await titles.titleFor("/sessions/f.jsonl", "second chat", justCreated()), "A working title");
});

test("with the switch off, listing a chat sends nothing at all", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => answering("never asked for"));
  await store.setTitleGenerationEnabled(false);

  try {
    assert.equal(await titles.titleFor("/sessions/off.jsonl", "switched off chat", justCreated()), "switched off chat");
    await titles.flushTitleQueue();
    assert.equal(calls.length, 0);
  } finally {
    await store.setTitleGenerationEnabled(true);
  }
});

test("the switch is not retroactive: a chat older than it is left alone", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => answering("never asked for"));

  const beforeTheSwitch = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  assert.equal(await titles.titleFor("/sessions/old.jsonl", "last week's chat", beforeTheSwitch), "last week's chat");
  // an unknown creation date counts as older, never as newer
  assert.equal(await titles.titleFor("/sessions/undated.jsonl", "undated chat", undefined), "undated chat");
  await titles.flushTitleQueue();

  assert.equal(calls.length, 0);
});

test("queueMissingTitles is the explicit click: it covers the old chats, switch or not", async () => {
  await writeAuth(oauthCredential(Date.now() + 3_600_000));
  stubFetch(() => answering("Chat di la settimana scorsa"));
  await store.setTitleGenerationEnabled(false);

  try {
    const queued = await titles.queueMissingTitles([
      { path: "/sessions/old.jsonl", firstMessage: "last week's chat" },
      // already summarized earlier in this file: never asked for twice
      { path: "/sessions/a.jsonl", firstMessage: "ciao, mi si rompe il container docker" },
      // no first message, nothing to summarize
      { path: "/sessions/empty.jsonl", firstMessage: "   " },
    ]);
    assert.equal(queued, 1);

    await titles.flushTitleQueue();
    assert.equal(calls.length, 1);
    assert.equal(
      await titles.titleFor("/sessions/old.jsonl", "last week's chat"),
      "Chat di la settimana scorsa",
    );
  } finally {
    await store.setTitleGenerationEnabled(true);
  }
});

test("requestTitle: prose becomes a title, an unusable answer becomes null", async () => {
  stubFetch(() => answering('  "Refactor the session store"  '));
  assert.equal(await titles.requestTitle("refactor please", "sk-ant-oat01-test"), "Refactor the session store");

  stubFetch(() => answering("one two three four five six seven eight nine"));
  assert.equal(await titles.requestTitle("count", "sk-ant-oat01-test"), "one two three four five six seven");

  stubFetch(() => answering("   "));
  assert.equal(await titles.requestTitle("empty answer", "sk-ant-oat01-test"), null);

  stubFetch(() => new Response(JSON.stringify({ error: "nope" }), { status: 200 }));
  assert.equal(await titles.requestTitle("unknown shape", "sk-ant-oat01-test"), null);

  calls = [];
  assert.equal(await titles.requestTitle("", "sk-ant-oat01-test"), null);
  assert.equal(await titles.requestTitle("no token", ""), null);
  assert.equal(calls.length, 0);
});

test("only the first 1000 characters of the first message are ever sent", async () => {
  stubFetch(() => answering("Long message summarized"));
  await titles.requestTitle("y".repeat(5000), "sk-ant-oat01-test");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages[0].content.length, 1000);
});
