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
let fetchOpenAIUsage;

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-usage-config-"));
  const blocker = path.join(tmpDir, "not-a-dir");
  await writeFile(blocker, "");
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = path.join(blocker, "agent");
  ({ saveUsageConfig, clearUsageConfig, fetchOpenAIUsage } = await import("../usage-tracker.mjs"));
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
test("OpenAI usage stays inert while its opt-in is off", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const data = await fetchOpenAIUsage({
    enabled: false,
    modelRuntime: { checkAuth: async () => { authCalls += 1; } },
    fetchImpl: async () => { fetchCalls += 1; },
  });
  assert.deepEqual(data, { enabled: false, configured: false });
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

function oauthFixture(accountId = "acct-secret-fixture") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature-secret-fixture`;
  return {
    accessToken,
    modelRuntime: {
      checkAuth: async (_provider, { signal }) => {
        assert.equal(signal instanceof AbortSignal, true);
        return { type: "oauth", source: "OAuth" };
      },
      getAuth: async (_provider, { signal }) => {
        assert.equal(signal instanceof AbortSignal, true);
        return { auth: { apiKey: accessToken }, source: "OAuth" };
      },
    },
  };
}

const OPENAI_PAYLOAD = {
  rate_limit: {
    primary_window: {
      used_percent: 37.5,
      limit_window_seconds: 18_000,
      reset_at: 1_800_000_000,
    },
    secondary_window: {
      used_percent: 62,
      limit_window_seconds: 604_800,
      reset_at: 1_800_500_000,
    },
  },
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("OpenAI usage resolves pi OAuth, scopes the request, and normalizes returned windows", async () => {
  const { accessToken, modelRuntime } = oauthFixture();
  let request;
  const now = Date.UTC(2026, 8, 7, 12);
  const data = await fetchOpenAIUsage({
    enabled: true,
    force: true,
    modelRuntime,
    now,
    cacheStore: { openai: null },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, OPENAI_PAYLOAD);
    },
  });

  assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(request.options.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(request.options.headers["ChatGPT-Account-Id"], "acct-secret-fixture");
  assert.deepEqual(data, {
    enabled: true,
    configured: true,
    fetchedAt: new Date(now).toISOString(),
    windows: [
      { usedPercent: 37.5, durationSeconds: 18_000, resetsAt: new Date(1_800_000_000_000).toISOString() },
      { usedPercent: 62, durationSeconds: 604_800, resetsAt: new Date(1_800_500_000_000).toISOString() },
    ],
  });
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(accessToken), false);
  assert.equal(serialized.includes("acct-secret-fixture"), false);
});

test("OpenAI usage reports 401 without exposing OAuth or account details", async () => {
  const { accessToken, modelRuntime } = oauthFixture();
  const data = await fetchOpenAIUsage({
    enabled: true,
    force: true,
    modelRuntime,
    cacheStore: { openai: null },
    fetchImpl: async () => response(401, { token: accessToken, account_id: "acct-secret-fixture" }),
  });
  assert.equal(data.errorCode, "unauthorized");
  assert.equal(JSON.stringify(data).includes("secret-fixture"), false);
});

test("OpenAI usage aborts a request at its timeout", async () => {
  const { modelRuntime } = oauthFixture();
  const data = await fetchOpenAIUsage({
    enabled: true,
    force: true,
    modelRuntime,
    timeoutMs: 5,
    cacheStore: { openai: null },
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(data.errorCode, "timeout");
});

test("OpenAI usage rejects a changed private response shape", async () => {
  const { modelRuntime } = oauthFixture();
  const data = await fetchOpenAIUsage({
    enabled: true,
    force: true,
    modelRuntime,
    cacheStore: { openai: null },
    fetchImpl: async () => response(200, { rate_limits_v2: OPENAI_PAYLOAD.rate_limit }),
  });
  assert.equal(data.errorCode, "payload_incompatible");
});

test("OpenAI usage caches for 45 seconds and refetches after expiry", async () => {
  const { modelRuntime } = oauthFixture();
  const cacheStore = { openai: null };
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response(200, OPENAI_PAYLOAD);
  };
  await fetchOpenAIUsage({ enabled: true, modelRuntime, fetchImpl, now: 1_000, cacheStore });
  await fetchOpenAIUsage({ enabled: true, modelRuntime, fetchImpl, now: 45_999, cacheStore });
  assert.equal(fetchCalls, 1);
  await fetchOpenAIUsage({ enabled: true, modelRuntime, fetchImpl, now: 46_001, cacheStore });
  assert.equal(fetchCalls, 2);
});

test("saveUsageConfig: a write failure carries no status, so the API answers 500", async () => {
  await assert.rejects(saveUsageConfig("kimi", { bearer: "aaa.bbb.ccc" }), (/** @type {any} */ err) => {
    assert.equal(err.status, undefined, `expected an I/O error without a status, got ${err.status}`);
    assert.notEqual(err.code, undefined, "expected a filesystem error code");
    return true;
  });
});
