import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

// The credentials file lives under an agent dir resolved at import time, so the
// override has to be in place *before* the module is loaded, together with
// PI_WEB_UI_TEST=1, without which the override is ignored and the real
// ~/.pi/agent is used. A regular file
// stands in for the parent directory: every write then fails with a real I/O
// error, which is exactly the case these tests need to tell apart from a
// rejected paste.
let tmpDir;
let saveUsageConfig;
let clearUsageConfig;

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-usage-config-"));
  const blocker = path.join(tmpDir, "not-a-dir");
  await writeFile(blocker, "");
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = path.join(blocker, "agent");
  ({ saveUsageConfig, clearUsageConfig } = await import("../usage-tracker.mjs"));
});

after(() => rm(tmpDir, { recursive: true, force: true }));

const VALID_ORG_ID = "0f9e8d7c-6b5a-4321-8765-0a1b2c3d4e5f";

test("saveUsageConfig: an unknown provider is a 400, not a crash", async () => {
  await assert.rejects(saveUsageConfig("openai", {}), { status: 400, message: "unknown provider" });
});

test("clearUsageConfig: an unknown provider is a 400", async () => {
  await assert.rejects(clearUsageConfig("openai"), { status: 400 });
});

test("saveUsageConfig: a paste with the org id but no cookie is a 400", async () => {
  await assert.rejects(
    saveUsageConfig("anthropic", { paste: `https://claude.ai/api/organizations/${VALID_ORG_ID}/usage` }),
    { status: 400 },
  );
});

test("saveUsageConfig: a token that is not a JWT is a 400", async () => {
  await assert.rejects(saveUsageConfig("kimi", { bearer: "not-a-jwt" }), { status: 400 });
});

// The point of the whole task: valid input that fails on disk must NOT look
// like a rejected paste, or the caller answers 400 and blames the user.
test("saveUsageConfig: a write failure carries no status, so the API answers 500", async () => {
  await assert.rejects(saveUsageConfig("kimi", { bearer: "aaa.bbb.ccc" }), (/** @type {any} */ err) => {
    assert.equal(err.status, undefined, `expected an I/O error without a status, got ${err.status}`);
    assert.notEqual(err.code, undefined, "expected a filesystem error code");
    return true;
  });
});
