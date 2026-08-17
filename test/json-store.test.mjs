import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { jsonFile } from "../session-store.mjs";

// Each test gets its own directory: the store creates it on demand, exactly as
// it does with ~/.pi/agent on a fresh install.
async function tempStore(options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-json-store-"));
  const file = path.join(dir, "store.json");
  return { dir, file, store: jsonFile(file, options) };
}

test("jsonFile: save then load round-trips the value and leaves no temp file", async (t) => {
  const { dir, file, store } = await tempStore({ fallback: () => [] });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await store.save(["a", "b"]);

  assert.deepEqual(await store.load(), ["a", "b"]);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(["a", "b"], null, 1));
  await assert.rejects(stat(`${file}.tmp`), { code: "ENOENT" });
});

test("jsonFile: a missing file yields a fresh fallback, never a shared one", async (t) => {
  const { dir, store } = await tempStore({ fallback: () => ({ enabled: true }) });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await store.load();
  first.enabled = false;

  assert.deepEqual(await store.load(), { enabled: true });
});

test("jsonFile: a corrupt or rejected file falls back instead of throwing", async (t) => {
  const { dir, file, store } = await tempStore({
    fallback: () => [],
    revive: (raw) => (Array.isArray(raw) ? raw : undefined),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(file, "{ truncated");
  assert.deepEqual(await store.load(), []);

  await writeFile(file, JSON.stringify({ not: "an array" }));
  assert.deepEqual(await store.load(), []);
});

test("jsonFile: revive validates what was on disk", async (t) => {
  const { dir, file, store } = await tempStore({
    fallback: () => [],
    revive: (raw) => Object.entries(raw).filter(([, v]) => v === "done"),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(file, JSON.stringify({ a: "done", b: "bogus" }));

  assert.deepEqual(await store.load(), [["a", "done"]]);
});

test("jsonFile: concurrent saves are queued, last one wins", async (t) => {
  const { dir, store } = await tempStore({ fallback: () => null });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })]);

  assert.deepEqual(await store.load(), { n: 3 });
});

test("jsonFile: a secret store keeps its owner-only mode across rewrites", { skip: process.platform === "win32" }, async (t) => {
  const { dir, file, store } = await tempStore({ fallback: () => null, mode: 0o600, dirMode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await store.save({ token: "first" });
  await store.save({ token: "second" });

  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
