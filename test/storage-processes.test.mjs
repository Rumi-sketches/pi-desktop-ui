import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

const worker = path.resolve("test/fixtures/storage-worker.mjs");
const filename = "web-ui-title-generation.json";
const initial = { enabled: false, enabledAt: null, lunaTitleFallback: false, lunaTitleFallbackEnabledAt: null };
const workers = new WeakMap();
const fixtureWorkers = new Map();
const IPC_TIMEOUT_MS = 10_000; // Includes the real storage lock's five-second timeout.

function bounded(promise, ms, describe) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(describe())), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function start(kind, file, dir, handshake = false) {
  const child = fork(worker, [kind, file, ...(handshake ? ["handshake"] : [])], { env: { ...process.env, PI_WEB_UI_TEST: "1", PI_WEB_UI_AGENT_DIR: dir }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const queue = [];
  const pending = [];
  let failure;
  let stderr = "";
  let closed = false;
  let resolveExit;
  let resolveClose;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const drained = new Promise((resolve) => { resolveClose = resolve; });
  const diagnostic = (reason) => `worker ${kind} pid=${child.pid ?? "unspawned"}: ${reason}${stderr ? `; stderr: ${stderr.trim()}` : ""}`;
  const fail = (error) => {
    failure ??= error;
    for (const waiter of pending.splice(0)) waiter.reject(failure);
  };
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4096); });
  // Listen from spawn, not from the first await: another worker may become ready first.
  child.on("message", (value) => {
    if (failure) return;
    if (pending.length) pending.shift().resolve(value);
    else if (queue.length < 16) queue.push(value);
    else {
      fail(new Error(diagnostic("IPC queue overflow")));
      child.kill();
    }
  });
  child.on("error", (error) => {
    fail(new Error(diagnostic(`process error: ${error.message}`), { cause: error }));
    resolveExit();
  });
  child.once("exit", (code, signal) => {
    fail(new Error(diagnostic(`exited: code=${code}, signal=${signal}`)));
    resolveExit({ code, signal });
  });
  child.once("close", () => { closed = true; resolveClose(); });
  workers.set(child, {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      let waiter;
      const result = new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        pending.push(waiter);
      });
      return bounded(result, IPC_TIMEOUT_MS, () => diagnostic("timed out waiting for IPC message"))
        .finally(() => {
          const index = pending.indexOf(waiter);
          if (index !== -1) pending.splice(index, 1);
        });
    },
    exit() {
      return bounded(exited, IPC_TIMEOUT_MS, () => diagnostic("timed out waiting for exit"))
        .then((result) => {
          if (!result) throw failure;
          return result;
        });
    },
    async stop() {
      if (closed) return;
      child.kill();
      try {
        await bounded(drained, 2_000, () => diagnostic("timed out waiting for cleanup"));
      } catch {
        child.kill("SIGKILL");
        await bounded(drained, 2_000, () => diagnostic("timed out waiting for forced cleanup"));
      }
    },
  });
  fixtureWorkers.get(dir).push(child);
  return child;
}
function message(child) {
  return workers.get(child).next();
}
function exit(child) {
  return workers.get(child).exit();
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-storage-processes-"));
  const children = [];
  fixtureWorkers.set(dir, children);
  t.after(async () => {
    const results = await Promise.allSettled(children.map((child) => workers.get(child).stop()));
    fixtureWorkers.delete(dir);
    await rm(dir, { recursive: true, force: true });
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "storage worker cleanup failed");
  });
  const file = path.join(dir, filename);
  await writeFile(file, JSON.stringify(initial));
  return { dir, file };
}

test("worker messages survive ready B arriving before ready A", async (t) => {
  const { dir, file } = await fixture(t);
  const a = start("enabled", file, dir, true);
  const b = start("luna", file, dir, true);
  const waitingA = message(a);
  const waitingB = message(b);
  assert.deepEqual(await Promise.all([waitingA, waitingB]), ["waiting", "waiting"]);
  const order = [];
  b.once("message", (value) => {
    assert.equal(value, "ready");
    order.push("b");
    a.send("ready");
  });
  a.once("message", () => order.push("a"));
  const readyA = message(a);
  b.send("ready");
  assert.equal(await readyA, "ready");
  assert.deepEqual(order, ["b", "a"]);
  assert.equal(await message(b), "ready");
  const savedA = message(a);
  a.send("go");
  assert.equal(await savedA, "saved");
  const savedB = message(b);
  b.send("go");
  assert.equal(await savedB, "saved");
});

test("separate processes merge independent consents and use distinct temporaries", async (t) => {
  const { dir, file } = await fixture(t);
  const a = start("enabled", file, dir);
  const b = start("luna", file, dir);
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
  assert.equal(await message(a), "ready");
  assert.equal(await message(b), "ready");
  const aResult = message(a);
  const bResult = message(b);
  a.send("go");
  b.send("go");
  assert.deepEqual(await Promise.all([aResult, bResult]), ["saved", "saved"]);
  assert.deepEqual(Object.entries(JSON.parse(await readFile(file, "utf8")))
    .filter(([key]) => key === "enabled" || key === "lunaTitleFallback")
    .map(([, value]) => value), [true, true]);
  assert.deepEqual((await readdir(dir)).sort(), [filename]);
});

test("a running process observes consent revoked by another instance", async (t) => {
  const { dir, file } = await fixture(t);
  const reader = start("check", file, dir);
  assert.equal(await message(reader), "ready");
  const writer = start("enabled", file, dir);
  assert.equal(await message(writer), "ready");
  writer.send("go");
  assert.equal(await message(writer), "saved");
  reader.send("go");
  assert.deepEqual(await message(reader), { enabled: true });
  const revoker = start("disabled", file, dir);
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
  assert.equal(await message(child), "ready");
  child.send("go");
  const result = await message(child);
  assert.ok(result.error);
  assert.equal((await readdir(file)).length, 0);
});

test("a held lock times out, then recovers after owner exit", async (t) => {
  const { dir, file } = await fixture(t);
  const owner = start("hold", file, dir);
  assert.equal(await message(owner), "locked");
  const contender = start("enabled", file, dir);
  assert.equal(await message(contender), "ready");
  contender.send("go");
  assert.match((await message(contender)).error, /timed out waiting/);
  const ownerExit = exit(owner);
  owner.kill();
  await ownerExit;
  const recovered = start("luna", file, dir);
  assert.equal(await message(recovered), "ready");
  recovered.send("go");
  assert.equal(await message(recovered), "saved");
  assert.equal(JSON.parse(await readFile(file, "utf8")).lunaTitleFallback, true);
});

test("crashed owner is recovered without changing the stored value", async (t) => {
  const { dir, file } = await fixture(t);
  const owner = start("crash", file, dir);
  assert.equal(await message(owner), "locked");
  await exit(owner);
  const next = start("enabled", file, dir);
  assert.equal(await message(next), "ready");
  next.send("go");
  assert.equal(await message(next), "saved");
  assert.equal(JSON.parse(await readFile(file, "utf8")).enabled, true);
});
