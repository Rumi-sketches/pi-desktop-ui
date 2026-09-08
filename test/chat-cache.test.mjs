import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_CACHE_LIMIT, createChatCache } from "../public/chat-cache.js";

const CHAT_A = "C:\\sessions\\alpha.jsonl";
const CHAT_B = "draft:C:\\work\\beta";

test("drafts and attachments are isolated by opaque session key", () => {
  const persisted = new Map();
  const cache = createChatCache({
    loadDraft: (key) => persisted.get(key) ?? "",
    saveDraft: (key, draft) => persisted.set(key, draft),
    removeDraft: (key) => persisted.delete(key),
  });
  const photo = { kind: "image", data: "base64-only-in-memory" };

  cache.setDraft(CHAT_A, "alpha prompt");
  cache.setAttachments(CHAT_A, [photo]);
  cache.setDraft(CHAT_B, "beta prompt");

  assert.equal(cache.ensure(CHAT_A).composer.draft, "alpha prompt");
  assert.deepEqual(cache.ensure(CHAT_A).composer.attachments, [photo]);
  assert.equal(cache.ensure(CHAT_B).composer.draft, "beta prompt");
  assert.deepEqual(cache.ensure(CHAT_B).composer.attachments, []);
  assert.deepEqual(Object.fromEntries(persisted), {
    [CHAT_A]: "alpha prompt",
    [CHAT_B]: "beta prompt",
  });
  assert.equal(JSON.stringify(Object.fromEntries(persisted)).includes("base64-only-in-memory"), false);
});

test("view snapshots and scroll positions stay with the visited chat", () => {
  const cache = createChatCache();
  const snapshotA = { dom: "alpha" };
  const snapshotB = { dom: "beta" };

  cache.saveView(CHAT_A, { scrollTop: 125, snapshot: snapshotA });
  cache.saveView(CHAT_B, { scrollTop: 9, snapshot: snapshotB });

  assert.equal(cache.ensure(CHAT_A).view.scrollTop, 125);
  assert.equal(cache.takeSnapshot(CHAT_A), snapshotA);
  assert.equal(cache.ensure(CHAT_B).view.scrollTop, 9);
  assert.equal(cache.takeSnapshot(CHAT_B), snapshotB);
  assert.equal(cache.peek(CHAT_A).view.snapshot, null);
});

test("view capture reads scroll before detaching content resets the container", () => {
  const cache = createChatCache();
  const snapshot = { dom: "alpha" };
  let scrollTop = 420;
  const order = [];

  cache.captureView(CHAT_A, {
    readScrollTop: () => {
      order.push("scroll");
      return scrollTop;
    },
    detachSnapshot: () => {
      order.push("detach");
      scrollTop = 0;
      return snapshot;
    },
  });

  assert.deepEqual(order, ["scroll", "detach"]);
  assert.equal(cache.peek(CHAT_A).view.scrollTop, 420);
  assert.equal(cache.takeSnapshot(CHAT_A), snapshot);
});

test("the ninth chat evicts the least recently used of the fixed eight", () => {
  const cache = createChatCache();
  const keys = Array.from({ length: CHAT_CACHE_LIMIT }, (_, index) => `chat:${index}`);
  for (const key of keys) cache.ensure(key);

  cache.ensure(keys[0]);
  cache.ensure("chat:ninth");

  assert.equal(cache.size, CHAT_CACHE_LIMIT);
  assert.equal(cache.peek(keys[1]), null);
  assert.ok(cache.peek(keys[0]));
  assert.deepEqual(cache.keys(), [...keys.slice(2), keys[0], "chat:ninth"]);
});

test("eviction explicitly disposes DOM snapshots, listeners, timers and cleanup hooks", () => {
  const cache = createChatCache({ limit: 1 });
  const target = new EventTarget();
  let calls = 0;
  let clearedTimer = null;
  let cleaned = false;
  let disposedSnapshot = null;
  const listener = () => { calls += 1; };

  cache.trackListener(CHAT_A, target, "ping", listener);
  cache.trackTimer(CHAT_A, 42, (id) => { clearedTimer = id; });
  cache.addCleanup(CHAT_A, () => { cleaned = true; });
  cache.saveView(CHAT_A, {
    snapshot: { node: "detached-tree" },
    disposeSnapshot: (snapshot) => { disposedSnapshot = snapshot; },
  });
  target.dispatchEvent(new Event("ping"));
  cache.ensure(CHAT_B);
  target.dispatchEvent(new Event("ping"));

  assert.equal(calls, 1);
  assert.equal(clearedTimer, 42);
  assert.equal(cleaned, true);
  assert.deepEqual(disposedSnapshot, { node: "detached-tree" });
  assert.equal(cache.peek(CHAT_A), null);
});

test("rekey moves the same transient state and persisted draft to the new opaque key", () => {
  const persisted = new Map([[CHAT_B, "keep this draft"]]);
  const cache = createChatCache({
    loadDraft: (key) => persisted.get(key) ?? "",
    saveDraft: (key, draft) => persisted.set(key, draft),
    removeDraft: (key) => persisted.delete(key),
  });
  const attachment = { kind: "file", text: "not persisted" };
  const before = cache.ensure(CHAT_B);
  cache.setAttachments(CHAT_B, [attachment]);
  cache.saveView(CHAT_B, { scrollTop: 33, snapshot: { dom: "draft" } });

  const nextKey = "C:\\sessions\\beta.jsonl";
  const after = cache.rekey(CHAT_B, nextKey);

  assert.equal(after, before);
  assert.equal(cache.peek(CHAT_B), null);
  assert.equal(cache.peek(nextKey), before);
  assert.equal(after.key, nextKey);
  assert.equal(after.composer.draft, "keep this draft");
  assert.deepEqual(after.composer.attachments, [attachment]);
  assert.equal(after.view.scrollTop, 33);
  assert.deepEqual(after.view.snapshot, { dom: "draft" });
  assert.equal(persisted.has(CHAT_B), false);
  assert.equal(persisted.get(nextKey), "keep this draft");
});
