import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStorage } from "../public/draft-storage.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

const metadata = {
  cwd: "C:\\work\\alpha",
  title: "Finish the release",
  modified: "2026-09-22T10:00:00.000Z",
  pending: false,
};

test("draft text and metadata round-trip through the existing storage keys", () => {
  const browser = memoryStorage();
  let scheduled = null;
  const storage = createDraftStorage({
    storage: browser,
    setTimer(callback) { scheduled = callback; return 1; },
    clearTimer() {},
  });

  storage.set("opaque:not/a/path", { draft: "ship it", metadata });
  assert.equal(browser.values.size, 0, "writes remain deferred while typing");
  scheduled();

  const restored = createDraftStorage({ storage: browser });
  assert.deepEqual(restored.get("opaque:not/a/path"), { draft: "ship it", metadata });
  assert.deepEqual(JSON.parse(browser.values.get("piComposerDrafts")), {
    "opaque:not/a/path": "ship it",
  });
  assert.equal(browser.values.get("piComposerDraftMeta").includes("attachments"), false);
});

test("corrupt containers and invalid entries fall back without browser storage globals", () => {
  const browser = memoryStorage({
    piComposerDrafts: "{broken",
    piComposerDraftMeta: JSON.stringify({
      bad: { cwd: 42, title: "bad", modified: "now" },
      valid: { ...metadata, pending: "yes" },
    }),
  });
  const storage = createDraftStorage({ storage: browser });

  assert.deepEqual(storage.get("bad"), { draft: "", metadata: null });
  assert.deepEqual(storage.get("valid"), { draft: "", metadata: { ...metadata, pending: false } });
  assert.deepEqual(storage.get("missing"), { draft: "", metadata: null });
});

test("rekey moves one persisted record and flush writes the latest coalesced value", () => {
  const browser = memoryStorage();
  const callbacks = [];
  const storage = createDraftStorage({
    storage: browser,
    setTimer(callback) { callbacks.push(callback); return callbacks.length; },
    clearTimer() {},
  });

  storage.set("draft:key", { draft: "first", metadata });
  storage.set("draft:key", { draft: "latest", metadata: { ...metadata, title: "Latest" } });
  storage.rekey("draft:key", "session:key");
  assert.equal(callbacks.length, 1, "mutations share one delayed flush");
  storage.flush();

  assert.deepEqual(storage.get("draft:key"), { draft: "", metadata: null });
  assert.deepEqual(storage.get("session:key"), {
    draft: "latest",
    metadata: { ...metadata, title: "Latest" },
  });
  assert.deepEqual(JSON.parse(browser.values.get("piComposerDrafts")), { "session:key": "latest" });
});
