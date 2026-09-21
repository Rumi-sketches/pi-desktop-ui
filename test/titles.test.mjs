// Chat title generation is exercised with a fake ModelRuntime: no provider
// request or real credential is used by this suite.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

let agentDir;
let titles;
let store;
let calls;
let runtime;

const justCreated = () => new Date();
const HAIKU = "anthropic/claude-haiku-4-5";
const LUNA = "openai-codex/gpt-5.6-luna";

/** @param {string} text */
function assistant(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * @param {{
 *   subscriptions?: string[],
 *   models?: string[],
 *   complete?: (...args: any[]) => Promise<any>
 * }} [options]
 */
function fakeRuntime(options = {}) {
  const {
    subscriptions = ["anthropic", "openai-codex"],
    models = [HAIKU, LUNA],
    complete = async () => assistant("Generated title"),
  } = options;
  const subscribed = new Set(subscriptions);
  const catalog = new Set(models);
  return {
    getModel(provider, id) {
      return catalog.has(`${provider}/${id}`) ? { provider, id } : undefined;
    },
    isUsingSubscription(provider) {
      return subscribed.has(provider);
    },
    async completeSimple(model, context, options) {
      calls.push({ model, context, options });
      return complete(model, context, options);
    },
  };
}

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-titles-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  titles = await import("../titles.mjs");
  store = await import("../session-store.mjs");
});

after(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  runtime = fakeRuntime();
  titles.configureTitleModelRuntime(runtime);
  await store.setTitleGenerationEnabled(false);
  await store.setLunaTitleFallbackEnabled(false);
  await store.setTitleGenerationEnabled(true);
});

test("fallbackTitle collapses whitespace and limits titles to four words", () => {
  assert.equal(titles.fallbackTitle("  fix the\n  docker build now please  "), "fix the docker build");
  assert.equal(titles.fallbackTitle(undefined), "");
  const long = titles.fallbackTitle("x".repeat(500));
  assert.equal(long.length, 101);
  assert.ok(long.endsWith("…"));
});

test("Haiku uses completeSimple once and the generated title is permanent", async () => {
  runtime = fakeRuntime({ complete: async () => assistant("Fix del container docker") });
  titles.configureTitleModelRuntime(runtime);

  const first = await titles.titleFor(
    "/sessions/primary.jsonl",
    "ciao, mi si rompe il container docker",
    justCreated(),
  );
  assert.equal(first, "ciao, mi si rompe");
  await titles.flushTitleQueue();

  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].model.provider}/${calls[0].model.id}`, HAIKU);
  assert.match(calls[0].context.systemPrompt, /at most four words/);
  assert.equal(calls[0].options.maxTokens, 32);
  assert.equal(calls[0].options.cacheRetention, "none");
  assert.equal(
    await titles.titleFor("/sessions/primary.jsonl", "whatever it was"),
    "Fix del container docker",
  );
  assert.equal(calls.length, 1, "a cached title must never be regenerated");

  const cached = JSON.parse(await readFile(path.join(agentDir, "web-ui-titles.json"), "utf8"));
  assert.equal(cached["/sessions/primary.jsonl"], "Fix del container docker");
});

test("fallback off never contacts OpenAI when Haiku is unavailable", async () => {
  runtime = fakeRuntime({ subscriptions: ["openai-codex"] });
  titles.configureTitleModelRuntime(runtime);

  assert.equal(
    await titles.titleFor("/sessions/no-fallback.jsonl", "private request", justCreated()),
    "private request",
  );
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0);
});

test("Haiku unavailable uses Luna once only with separate, non-retroactive consent", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const oldChat = new Date();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.setLunaTitleFallbackEnabled(true);
  runtime = fakeRuntime({
    subscriptions: ["openai-codex"],
    complete: async () => assistant("Titolo generato da Luna"),
  });
  titles.configureTitleModelRuntime(runtime);

  await titles.titleFor("/sessions/luna.jsonl", "new fallback chat", justCreated());
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].model.provider}/${calls[0].model.id}`, LUNA);
  assert.equal(await titles.titleFor("/sessions/luna.jsonl", "new fallback chat"), "Titolo generato da Luna");

  calls = [];
  await titles.titleFor("/sessions/pre-luna.jsonl", "older private chat", oldChat);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0, "enabling Luna must not cover older chats automatically");
});

test("a valid but imperfect Haiku answer never triggers Luna", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  runtime = fakeRuntime({
    complete: async (model) => {
      if (model.provider === "openai-codex") throw new Error("Luna must not run");
      return assistant("one two three four five six seven eight nine.");
    },
  });
  titles.configureTitleModelRuntime(runtime);

  await titles.titleFor("/sessions/imperfect.jsonl", "style does not trigger fallback", justCreated());
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].model.provider}/${calls[0].model.id}`, HAIKU);
  assert.equal(
    await titles.titleFor("/sessions/imperfect.jsonl", "style does not trigger fallback"),
    "one two three four",
  );
});

test("when both subscription models are absent no remote call is made", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  titles.configureTitleModelRuntime(fakeRuntime({ subscriptions: [] }));

  await titles.titleFor("/sessions/absent.jsonl", "no provider chat", justCreated());
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0);
});

test("unavailable models do not requeue and recover when availability changes", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  let available = false;
  runtime = {
    getModel(provider, id) {
      return available && `${provider}/${id}` === HAIKU ? { provider, id } : undefined;
    },
    isUsingSubscription(provider) {
      return available && provider === "anthropic";
    },
    async completeSimple(model, context, options) {
      calls.push({ model, context, options });
      return assistant("Recovered title");
    },
  };
  titles.configureTitleModelRuntime(runtime);
  const chat = { path: "/sessions/local-miss.jsonl", firstMessage: "provider unavailable" };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await titles.titleFor(chat.path, chat.firstMessage, justCreated());
    await titles.flushTitleQueue();
  }
  const backfills = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    backfills.push(await titles.queueMissingTitles([chat]));
    await titles.flushTitleQueue();
  }
  assert.deepEqual(backfills, [0, 0, 0, 0, 0]);
  assert.equal(calls.length, 0);

  available = true;
  assert.equal(await titles.queueMissingTitles([chat]), 1);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);
  assert.equal(await titles.titleFor(chat.path, chat.firstMessage), "Recovered title");
});

test("three remote failures ten minutes apart exhaust the chat budget", async () => {
  runtime = fakeRuntime({ complete: async () => { throw new Error("upstream unavailable"); } });
  titles.configureTitleModelRuntime(runtime);
  const t0 = Date.parse("2026-09-07T12:00:00Z");
  const listAt = async (minutes) => {
    await titles.titleFor(
      "/sessions/retry.jsonl",
      "retry title generation",
      justCreated(),
      t0 + minutes * 60_000,
    );
    await titles.flushTitleQueue();
  };

  await listAt(0);
  await listAt(9);
  assert.equal(calls.length, 1, "cooldown blocks an early retry");
  await listAt(10);
  await listAt(20);
  assert.equal(calls.length, 3);
  await listAt(30);
  await listAt(24 * 60);
  assert.equal(calls.length, 3, "the budget does not reset with time");
});

test("Haiku and Luna share one budget of three remote calls", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  runtime = fakeRuntime({ complete: async () => { throw new Error("provider unavailable"); } });
  titles.configureTitleModelRuntime(runtime);
  const t0 = Date.parse("2026-09-07T14:00:00Z");

  await titles.titleFor("/sessions/shared-budget.jsonl", "fallback retry", justCreated(), t0);
  await titles.flushTitleQueue();
  assert.deepEqual(calls.map((call) => `${call.model.provider}/${call.model.id}`), [HAIKU, LUNA]);

  await titles.titleFor(
    "/sessions/shared-budget.jsonl",
    "fallback retry",
    justCreated(),
    t0 + 10 * 60_000,
  );
  await titles.flushTitleQueue();
  assert.deepEqual(calls.map((call) => `${call.model.provider}/${call.model.id}`), [HAIKU, LUNA, HAIKU]);
});

test("requestTitle applies its timeout through the runtime signal", async () => {
  let observedSignal;
  runtime = fakeRuntime({
    complete: async (_model, _context, options) => {
      observedSignal = options.signal;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });

  const result = await titles.requestTitle("timeout chat", runtime, undefined, 5);
  assert.equal(result.status, "unavailable");
  assert.equal(result.attempted, true);
  assert.equal(observedSignal.aborted, true);
});

test("duplicate listings queue one request and only 1000 input characters", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  runtime = fakeRuntime({
    complete: async () => {
      await pending;
      return assistant("Long message summarized");
    },
  });
  titles.configureTitleModelRuntime(runtime);
  const text = "y".repeat(5000);

  await Promise.all([
    titles.titleFor("/sessions/deduplicated.jsonl", text, justCreated()),
    titles.titleFor("/sessions/deduplicated.jsonl", text, justCreated()),
  ]);
  assert.equal(calls.length, 1);
  release();
  await titles.flushTitleQueue();
  assert.equal(calls[0].context.messages[0].content.length, 1000);
});

test("backfill is explicit, requires the primary toggle, and follows Luna's toggle", async () => {
  await store.setTitleGenerationEnabled(false);
  await store.setLunaTitleFallbackEnabled(true);
  titles.configureTitleModelRuntime(fakeRuntime({ subscriptions: ["openai-codex"] }));

  assert.equal(
    await titles.queueMissingTitles([{ path: "/sessions/backfill-off.jsonl", firstMessage: "old chat" }]),
    0,
  );
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0);

  await store.setTitleGenerationEnabled(true);
  assert.equal(
    await titles.queueMissingTitles([{ path: "/sessions/backfill-on.jsonl", firstMessage: "old chat" }]),
    1,
  );
  await titles.flushTitleQueue();
  assert.equal(`${calls[0].model.provider}/${calls[0].model.id}`, LUNA);
});

test("primary consent is off by default behavior and never retroactive", async () => {
  const beforePrimary = new Date(Date.now() - 60_000);
  await store.setTitleGenerationEnabled(false);
  await titles.titleFor("/sessions/primary-off.jsonl", "switch is off", justCreated());
  await store.setTitleGenerationEnabled(true);
  await titles.titleFor("/sessions/primary-old.jsonl", "older chat", beforePrimary);
  await titles.titleFor("/sessions/primary-undated.jsonl", "undated chat", undefined);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 0);
});

test("a valid empty Haiku response does not authorize Luna", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  runtime = fakeRuntime({ complete: async () => assistant("   ") });
  titles.configureTitleModelRuntime(runtime);

  await titles.titleFor("/sessions/empty-answer.jsonl", "empty model answer", justCreated());
  await titles.flushTitleQueue();
  assert.deepEqual(calls.map((call) => `${call.model.provider}/${call.model.id}`), [HAIKU]);
});

test("one failed job does not stop the single worker from processing the next", async () => {
  let invocation = 0;
  runtime = fakeRuntime({
    complete: async () => {
      invocation += 1;
      if (invocation === 1) throw new Error("first request failed");
      return assistant("Second chat title");
    },
  });
  titles.configureTitleModelRuntime(runtime);

  assert.equal(await titles.queueMissingTitles([
    { path: "/sessions/queue-failure.jsonl", firstMessage: "first chat" },
    { path: "/sessions/queue-success.jsonl", firstMessage: "second chat" },
  ]), 2);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 2);
  assert.equal(await titles.titleFor("/sessions/queue-success.jsonl", "second chat"), "Second chat title");
});

test("backfill skips cached chats and blank first messages", async () => {
  runtime = fakeRuntime({ complete: async () => assistant("Already cached title") });
  titles.configureTitleModelRuntime(runtime);
  await titles.titleFor("/sessions/backfill-cached.jsonl", "cached chat", justCreated());
  await titles.flushTitleQueue();
  calls = [];

  assert.equal(await titles.queueMissingTitles([
    { path: "/sessions/backfill-cached.jsonl", firstMessage: "cached chat" },
    { path: "/sessions/backfill-blank.jsonl", firstMessage: "   " },
    { path: "/sessions/backfill-new.jsonl", firstMessage: "new old chat" },
  ]), 1);
  await titles.flushTitleQueue();
  assert.equal(calls.length, 1);
});

test("SDK error messages authorize Luna and never cache partial failure text", async () => {
  await store.setLunaTitleFallbackEnabled(true);
  for (const stopReason of ["error", "aborted"]) {
    const sessionPath = `/sessions/sdk-${stopReason}.jsonl`;
    titles.configureTitleModelRuntime(fakeRuntime({
      complete: async (model) => model.provider === "anthropic"
        ? { ...assistant("Partial failure text"), stopReason }
        : assistant("Recovered title"),
    }));
    calls = [];
    await titles.titleFor(sessionPath, "provider failure", justCreated());
    await titles.flushTitleQueue();
    assert.deepEqual(calls.map((call) => `${call.model.provider}/${call.model.id}`), [HAIKU, LUNA]);
    assert.equal(await titles.titleFor(sessionPath, "provider failure"), "Recovered title");
  }
});

test("revoking title consent prevents queued calls and a not-yet-started Luna fallback", async () => {
  for (const toggle of ["primary", "luna"]) {
    await store.setTitleGenerationEnabled(true);
    await store.setLunaTitleFallbackEnabled(true);
    let release;
    const response = new Promise((resolve) => { release = resolve; });
    let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    calls = [];
    titles.configureTitleModelRuntime(fakeRuntime({ complete: async (model) => {
      if (model.provider === "anthropic") {
        started();
        await response;
        return { ...assistant(""), stopReason: "error" };
      }
      return assistant("Luna title");
    } }));
    await titles.titleFor(`/sessions/revoke-${toggle}.jsonl`, "first request", justCreated());
    await firstStarted;
    if (toggle === "primary") {
      await titles.titleFor("/sessions/revoke-backlog.jsonl", "queued request", justCreated());
      await store.setTitleGenerationEnabled(false);
    } else {
      await store.setLunaTitleFallbackEnabled(false);
    }
    release();
    await titles.flushTitleQueue();
    assert.deepEqual(calls.map((call) => `${call.model.provider}/${call.model.id}`), [HAIKU]);
  }
});

test("an empty input never calls the runtime", async () => {
  const outcome = await titles.requestTitle("", runtime);
  assert.deepEqual(outcome, { status: "unavailable", attempted: false, title: null });
  assert.equal(calls.length, 0);
});
