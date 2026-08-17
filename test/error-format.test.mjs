// The three endpoints that used to answer a failure with a 200 now answer a
// 4xx carrying `{ error: { code, message } }`. `code` is the half a program
// reads, so it is what these tests pin; the wording of `message` is free to
// change.
//
// `/api/pick-folder` is deliberately absent: calling it opens a real native
// dialog on the machine running the suite. Its cancelled branch is covered by
// hand, and its shape is the same sendError() the other two go through.
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
// land *before* the dynamic import. They also guarantee no
// provider credentials are configured, which is what the usage/test branch
// below needs.
let agentDir;
let server;
let origin;

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-error-format-"));
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

// The request guard rejects an unsafe method without a same-origin Origin
// header, so every call carries one.
async function postJson(pathname, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

function assertErrorPayload(payload, code) {
  assert.deepEqual(Object.keys(payload), ["error"], "an error answer carries nothing else");
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, "string");
  assert.ok(payload.error.message.length > 0, "message must not be empty");
}

describe("POST /api/usage/test", () => {
  test("an unknown provider is a 400 with a code", async () => {
    const { status, body } = await postJson("/api/usage/test", { provider: "nope" });
    assert.equal(status, 400);
    assertErrorPayload(body, "unknown_provider");
  });

  test("credentials that were never saved are a 400, not an ok:false 200", async () => {
    const { status, body } = await postJson("/api/usage/test", { provider: "anthropic" });
    assert.equal(status, 400);
    assertErrorPayload(body, "credentials_missing");
  });

  test("a missing provider is rejected like an unknown one", async () => {
    const { status, body } = await postJson("/api/usage/test", {});
    assert.equal(status, 400);
    assertErrorPayload(body, "unknown_provider");
  });
});

describe("POST /api/cwd", () => {
  test("a folder that does not exist is a 400 with a code", async () => {
    const missing = path.join(agentDir, "there-is-no-such-folder");
    const { status, body } = await postJson("/api/cwd", { path: missing });
    assert.equal(status, 400);
    assertErrorPayload(body, "invalid_folder");
  });
});

describe("the rest of the API", () => {
  test("still answers the flat { error: 'message' }, which the page also reads", async () => {
    const { status, body } = await postJson("/api/status", { path: "x", status: "invented" });
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });
});
