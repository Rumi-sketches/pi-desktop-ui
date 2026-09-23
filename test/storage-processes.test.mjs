import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

const worker = path.resolve("test/fixtures/storage-worker.mjs");
const filename = "web-ui-title-generation.json";
const initial = { enabled: false, enabledAt: null, lunaTitleFallback: false, lunaTitleFallbackEnabledAt: null };
function start(kind, file, dir) {
  const child = fork(worker, [kind, file], { env: { ...process.env, PI_WEB_UI_TEST: "1", PI_WEB_UI_AGENT_DIR: dir }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr.on("data", () => {});
  return child;
}
function message(child) {
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`worker exited: ${code}`)));
  });
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-storage-processes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, filename);
  await writeFile(file, JSON.stringify(initial));
  return { dir, file };
}

test("separate processes merge independent consents and use distinct temporaries", async (t) => {
  const { dir, file } = await fixture(t);
  const a = start("enabled", file, dir);
  const b = start("luna", file, dir);
  t.after(() => { a.kill(); b.kill(); });
  assert.equal(await message(a), "ready");
  assert.equal(await message(b), "ready");
  a.send("go");
  assert.equal(await message(a), "saved");
  b.send("go");
  assert.equal(await message(b), "saved");
  const result = JSON.parse(await readFile(file, "utf8"));
  assert.equal(result.enabled, true);
  assert.equal(result.lunaTitleFallback, true);
  assert.ok(result.enabledAt && result.lunaTitleFallbackEnabledAt);
  assert.deepEqual((await readdir(dir)).sort(), [filename]);
});

test("simultaneous writers do not collide or lose distinct fields", async (t) => {
  const { dir, file } = await fixture(t);
  const a = start("enabled", file, dir);
  const b = start("luna", file, dir);
  t.after(() => { a.kill(); b.kill(); });
  assert.equal(await message(a), "ready");
  assert.equal(await message(b), "ready");
  const aResult = message(a);
  const bResult = message(b);
  a.send("go");
  b.send("go");
  assert.equal(await aResult, "saved");
  assert.equal(await bResult, "saved");
  assert.deepEqual(Object.entries(JSON.parse(await readFile(file, "utf8")))
    .filter(([key]) => key === "enabled" || key === "lunaTitleFallback")
    .map(([, value]) => value), [true, true]);
  assert.deepEqual((await readdir(dir)).sort(), [filename]);
});

test("a running process observes consent revoked by another instance", async (t) => {
  const { dir, file } = await fixture(t);
  const reader = start("check", file, dir);
  t.after(() => reader.kill());
  assert.equal(await message(reader), "ready");
  const writer = start("enabled", file, dir);
  t.after(() => writer.kill());
  assert.equal(await message(writer), "ready");
  writer.send("go");
  assert.equal(await message(writer), "saved");
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: true });
  const revoker = start("disabled", file, dir);
  t.after(() => revoker.kill());
  assert.equal(await message(revoker), "ready");
  revoker.send("go");
  assert.equal(await message(revoker), "saved");
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: false });
});

test("LAN authorization notices token rotation and fails closed on unreadable state", async (t) => {
  const { dir, file } = await fixture(t);
  const networkFile = path.join(dir, "web-ui-network.json");
  await writeFile(networkFile, JSON.stringify({ lanAccess: true, token: "fixture-token" }));
  const reader = start("network-check", file, dir);
  t.after(() => reader.kill());
  assert.equal(await message(reader), "ready");
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: true, valid: true });
  await writeFile(networkFile, JSON.stringify({ lanAccess: false, token: null }));
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: false, valid: false });
  await rm(networkFile);
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: false, valid: false });
});

test("an unreadable storage target fails without reporting success", async (t) => {
  const { dir, file } = await fixture(t);
  await rm(file);
  await mkdir(file);
  const child = start("enabled", file, dir);
  t.after(() => child.kill());
  assert.equal(await message(child), "ready");
  child.send("go");
  const result = await message(child);
  assert.ok(result.error);
  assert.equal((await readdir(file)).length, 0);
});

test("a held lock times out, then recovers after owner exit", async (t) => {
  const { dir, file } = await fixture(t);
  const owner = start("hold", file, dir);
  t.after(() => owner.kill());
  assert.equal(await message(owner), "locked");
  const contender = start("enabled", file, dir);
  t.after(() => contender.kill());
  assert.equal(await message(contender), "ready");
  contender.send("go");
  assert.match((await message(contender)).error, /timed out waiting/);
  owner.kill();
  await new Promise((resolve) => owner.once("exit", resolve));
  const recovered = start("luna", file, dir);
  t.after(() => recovered.kill());
  assert.equal(await message(recovered), "ready");
  recovered.send("go");
  assert.equal(await message(recovered), "saved");
  assert.equal(JSON.parse(await readFile(file, "utf8")).lunaTitleFallback, true);
});

test("crashed owner is recovered without changing the stored value", async (t) => {
  const { dir, file } = await fixture(t);
  const owner = start("crash", file, dir);
  assert.equal(await message(owner), "locked");
  await new Promise((resolve) => owner.once("exit", resolve));
  const next = start("enabled", file, dir);
  t.after(() => next.kill());
  assert.equal(await message(next), "ready");
  next.send("go");
  assert.equal(await message(next), "saved");
  assert.equal(JSON.parse(await readFile(file, "utf8")).enabled, true);
});
