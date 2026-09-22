import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

let agentDir;
let origin;
let server;

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-persistence-failures-"));
  await writeFile(
    path.join(agentDir, "web-ui-network.json"),
    JSON.stringify({ lanAccess: false, token: null }),
  );
  await writeFile(path.join(agentDir, "settings.json"), "{}\n");
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { startServer } = await import("../server.mjs");
  server = await startServer({ port: 0 });
  origin = server.url.replace(/\/$/, "");
});

after(async () => {
  await server?.stop();
  await rm(agentDir, { recursive: true, force: true });
});

async function request(method, pathname, body, headers = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const get = (pathname) => request("GET", pathname);
const post = (pathname, body) => request("POST", pathname, body);

test("a failed LAN save returns 500, keeps access off, and a later save recovers", async (t) => {
  const file = path.join(agentDir, "web-ui-network.json");
  const tmpFile = `${file}.tmp`;
  await mkdir(tmpFile);
  t.after(() => rm(tmpFile, { recursive: true, force: true }));

  const failed = await post("/api/network", { lanAccess: true });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "internal error" });
  assert.equal((await get("/api/network")).body.lanAccess, false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { lanAccess: false, token: null });

  await rm(tmpFile, { recursive: true, force: true });
  const recovered = await post("/api/network", { lanAccess: true });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.lanAccess, true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).lanAccess, true);
});

test("a failed preference save keeps the confirmed opt-in and later recovers", async (t) => {
  const file = path.join(agentDir, "web-ui-openai-usage.json");
  assert.equal((await post("/api/usage/config", { provider: "openai-codex", enabled: false })).status, 200);
  const tmpFile = `${file}.tmp`;
  await mkdir(tmpFile);
  t.after(() => rm(tmpFile, { recursive: true, force: true }));

  const failed = await post("/api/usage/config", { provider: "openai-codex", enabled: true });
  assert.equal(failed.status, 500);
  assert.equal((await get("/api/usage/config")).body.openai.enabled, false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { enabled: false });

  await rm(tmpFile, { recursive: true, force: true });
  const recovered = await post("/api/usage/config", { provider: "openai-codex", enabled: true });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.status.openai.enabled, true);
});

test("a failed reopened-status save rejects the prompt and releases its starting claim", async (t) => {
  const [{ getBootContext }, { sessionStatusOf, setSessionStatus }] = await Promise.all([
    import("../src/chat/contexts.mjs"),
    import("../src/storage/session-store.mjs"),
  ]);
  const ctx = getBootContext();
  const previousSessionFile = ctx.sessionFile;
  const sessionFile = path.join(agentDir, "sessions", "reopen-fixture.jsonl");
  const statusFile = path.join(agentDir, "web-ui-status.json");
  const tmpFile = `${statusFile}.tmp`;
  ctx.sessionFile = sessionFile;
  await setSessionStatus(sessionFile, "done");
  await mkdir(tmpFile);
  t.after(async () => {
    await rm(tmpFile, { recursive: true, force: true });
    await setSessionStatus(sessionFile, "active").catch(() => {});
    ctx.sessionFile = previousSessionFile;
  });

  const failed = await request("POST", "/api/prompt", { text: "must not reach the provider" }, {
    "x-pi-session": ctx.key,
  });

  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "internal error" });
  assert.equal(sessionStatusOf(sessionFile), "done");
  assert.equal(ctx.promptStarting, false);
  assert.equal(JSON.parse(await readFile(statusFile, "utf8"))[sessionFile], "done");
});

test("concurrent settings mutations preserve both confirmed updates", async () => {
  const [provider, theme] = await Promise.all([
    post("/api/settings", { key: "defaultProvider", value: "fixture-provider" }),
    post("/api/settings", { key: "theme", value: "light" }),
  ]);
  assert.equal(provider.status, 200);
  assert.equal(theme.status, 200);

  const saved = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(saved.defaultProvider, "fixture-provider");
  assert.equal(saved.theme, "light");
});

test("concurrent credential saves keep both providers and never echo secrets", async () => {
  const orgId = "0f9e8d7c-6b5a-4321-8765-0a1b2c3d4e5f";
  const [anthropic, kimi] = await Promise.all([
    post("/api/usage/config", { provider: "anthropic", orgId, cookie: "sessionKey=secret-cookie" }),
    post("/api/usage/config", { provider: "kimi", bearer: "secret.payload.signature" }),
  ]);
  assert.equal(anthropic.status, 200);
  assert.equal(kimi.status, 200);
  assert.equal(JSON.stringify([anthropic.body, kimi.body]).includes("secret"), false);

  const saved = JSON.parse(await readFile(path.join(agentDir, "web-usage.json"), "utf8"));
  assert.equal(saved.anthropic.orgId, orgId);
  assert.equal(saved.anthropic.cookie, "sessionKey=secret-cookie");
  assert.equal(saved.kimi.bearer, "secret.payload.signature");
});
