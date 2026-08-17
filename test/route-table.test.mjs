// The route table answers a known path called with the wrong verb with a 405
// and an accurate `Allow` header, instead of running a GET handler for any verb
// that happened to arrive (what the old `if` cascade did on ~12 endpoints).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

// Same isolation as the other endpoint tests: the server rewrites its state
// files at boot, so it must never see the real ~/.pi/agent of whoever runs the
// suite. PI_WEB_UI_AGENT_DIR moves this project's own stores and
// PI_CODING_AGENT_DIR moves the agent dir of the pi library, where the
// SessionManager writes the session files: without the second one every run
// would leave a real session behind. PI_WEB_UI_TEST=1 is what makes the first
// one honoured at all. Module-level constants read the env, hence the overrides
// land *before* the dynamic import.
let agentDir;
let server;
let origin;

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-route-table-"));
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

// The request guard rejects unsafe methods without a same-origin Origin header,
// so every call carries one: a 403 here would hide the 405 under test.
async function request(method, pathname) {
  const res = await fetch(`${origin}${pathname}`, { method, headers: { Origin: origin } });
  return { status: res.status, allow: res.headers.get("allow"), body: await res.text() };
}

describe("method not allowed", () => {
  test("POST /api/state is a 405 that advertises GET", async () => {
    const { status, allow } = await request("POST", "/api/state");
    assert.equal(status, 405);
    assert.equal(allow, "GET, HEAD");
  });

  test("PUT /api/recent-cwds is a 405, not the list", async () => {
    const { status, allow, body } = await request("PUT", "/api/recent-cwds");
    assert.equal(status, 405);
    assert.equal(allow, "DELETE, GET, HEAD");
    assert.ok(!body.includes("recent"), "a rejected verb must not reach the handler");
  });

  test("a path with several verbs lists them all", async () => {
    const { status, allow } = await request("DELETE", "/api/settings");
    assert.equal(status, 405);
    assert.equal(allow, "GET, HEAD, POST");
  });

  test("GET on a POST-only path is a 405, and nothing happens", async () => {
    const { status, allow } = await request("GET", "/api/shutdown");
    assert.equal(status, 405);
    assert.equal(allow, "POST");
  });

  test("a path with a :param is matched too, so a wrong verb on it is a 405", async () => {
    const { status, allow } = await request("GET", "/api/sessions/whatever/fork");
    assert.equal(status, 405);
    assert.equal(allow, "POST");
  });

  test("a :param cannot swallow an extra segment: that is a 404", async () => {
    assert.equal((await request("DELETE", "/api/usage/credentials/kimi/extra")).status, 404);
  });

  test("an unknown path is still a 404, whatever the verb", async () => {
    assert.equal((await request("GET", "/api/nope")).status, 404);
    assert.equal((await request("PUT", "/api/nope")).status, 404);
  });
});

describe("routes that keep working", () => {
  test("GET /api/state is served", async () => {
    const { status } = await request("GET", "/api/state");
    assert.equal(status, 200);
  });

  test("HEAD rides on the GET handler: 200 with no body", async () => {
    const { status, body } = await request("HEAD", "/app.css");
    assert.equal(status, 200);
    assert.equal(body, "");
  });

  test("the vendor sub-tree is a prefix route: unknown verb, 405", async () => {
    const { status, allow } = await request("POST", "/vendor/marked/lib/marked.esm.js");
    assert.equal(status, 405);
    assert.equal(allow, "GET, HEAD");
  });
});
