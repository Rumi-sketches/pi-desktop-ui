// The routes that were once two endpoints switching on a field of the JSON
// body (`POST /api/session` with `action`, `POST /api/archiving` with
// `enabled`/`archiveNow`): one operation, one route, one verb.
//
// These started life as characterization tests of the old shape and were
// carried over one for one, so the coverage is the same: every branch that
// existed then still has its test here, under the route that replaced it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Same isolation the verify smoke test uses: the server rewrites its state
// files at boot, so it must never see the real ~/.pi/agent of whoever runs the
// suite. Two variables are needed, and neither covers the other:
// PI_WEB_UI_AGENT_DIR moves this project's own stores, PI_CODING_AGENT_DIR
// moves the agent dir of the pi library, where the SessionManager writes the
// session files, and PI_WEB_UI_TEST=1 is what makes the first one honoured at
// all. All are resolved by module-level constants, hence the overrides have to
// land *before* the dynamic import.
let agentDir;
let server;
let origin;
/** A hand-written session file inside the temporary sessions dir: the only
 *  kind of path an activate route accepts (it must exist and live under
 *  SESSIONS_DIR). */
let sessionFile;

const SESSION_HEADER = {
  type: "session",
  version: 3,
  id: "019fe65c-8714-7ee3-97a0-18b278f8229a",
  cwd: process.cwd(),
};

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-session-endpoints-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionsDir = path.join(agentDir, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  sessionFile = path.join(sessionsDir, "saved.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ ...SESSION_HEADER, timestamp: new Date().toISOString() })}\n`);

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
async function sendJson(method, pathname, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const postJson = (pathname, body) => sendJson("POST", pathname, body);

async function getJson(pathname) {
  const res = await fetch(`${origin}${pathname}`);
  return { status: res.status, body: await res.json() };
}

// A chat is identified by its session file, so the id travels url-encoded.
const sessionUrl = (id, suffix) => `/api/sessions/${encodeURIComponent(id)}/${suffix}`;

// Every route that puts the tab on a chat answers with this exact shape. The
// key is a session file path, or a synthetic one for a chat with no file yet,
// so only its type is pinned here.
function assertContextPayload(payload) {
  assert.deepEqual(Object.keys(payload).sort(), ["cwd", "key", "ok", "running"]);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.key, "string");
  assert.ok(payload.key.length > 0, "key must not be empty");
  assert.equal(typeof payload.cwd, "string");
  assert.equal(typeof payload.running, "boolean");
}

// The isolation this file depends on is invisible while it holds: the pi
// library writes its session files lazily, so dropping PI_CODING_AGENT_DIR
// would not turn any assertion below red -- it would just quietly start
// writing into the real ~/.pi/agent of whoever runs the suite. This pins the
// invariant at its source: the dir the library would write to is the
// temporary one. Reaching into dist/ is the only way to ask it, so a package
// that moves the module skips the check instead of failing the suite.
describe("the agent dir the pi library resolves", () => {
  test("is the temporary one, not the real ~/.pi/agent", async (t) => {
    // Resolved at runtime on purpose: the module is not in the package's
    // `exports`, so a literal import would fail the type check.
    const configPath = path.join(
      import.meta.dirname,
      "..",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "config.js",
    );
    if (!existsSync(configPath)) return t.skip("pi-coding-agent no longer exposes dist/config.js");
    const config = await import(pathToFileURL(configPath).href);
    assert.equal(config.ENV_AGENT_DIR, "PI_CODING_AGENT_DIR");
    assert.equal(path.resolve(config.getAgentDir()), path.resolve(agentDir));
  });
});

describe("the session routes", () => {
  test("POST /api/sessions/activate reopens the most recent chat of the folder", async () => {
    const { status, body } = await postJson("/api/sessions/activate");
    assert.equal(status, 200);
    assertContextPayload(body);
  });

  test("POST /api/sessions starts a chat in the folder of the current one", async () => {
    const { status, body } = await postJson("/api/sessions");
    assert.equal(status, 200);
    assertContextPayload(body);
  });

  test("POST /api/sessions/:id/activate loads that chat and answers with its path as key", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "activate"));
    assert.equal(status, 200);
    assertContextPayload(body);
    assert.equal(body.key, sessionFile);
  });

  test("activating an empty id is a 400", async () => {
    const { status, body } = await postJson("/api/sessions//activate");
    assert.equal(status, 400);
    assert.match(body.error, /missing path/);
  });

  test("activating a file outside the sessions dir is a 400", async () => {
    const outside = path.join(process.cwd(), "package.json");
    const { status, body } = await postJson(sessionUrl(outside, "activate"));
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  test("activating with an unknown cwd is a 400", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "activate"), {
      cwd: path.join(agentDir, "no-such-folder"),
    });
    assert.equal(status, 400);
    assert.match(body.error, /directory not found/);
  });

  test("forking without an entryId is a 400", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "fork"));
    assert.equal(status, 400);
    assert.match(body.error, /missing entryId/);
  });

  // useContext falls back to the most recent chat of the default folder when a
  // key does not resolve: the fork route must refuse the id before that point,
  // or it would branch a chat the caller never named.
  test("forking an id that does not resolve is a 400", async () => {
    const missing = path.join(agentDir, "sessions", "project", "no-such-chat.jsonl");
    const { status, body } = await postJson(sessionUrl(missing, "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /file not found/);
  });

  test("forking a file outside the sessions dir is a 400", async () => {
    const outside = path.join(process.cwd(), "package.json");
    const { status, body } = await postJson(sessionUrl(outside, "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /outside the sessions directory/);
  });

  test("forking a draft chat (no session file yet) is a 400", async () => {
    const { status, body } = await postJson(sessionUrl("draft:/tmp/project", "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /no session file yet/);
  });

  test("forking on an unknown entryId is a 400, not a crash", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "fork"), { entryId: "no-such-entry" });
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  // The `action` field is gone, and so is the endpoint that read it: an old
  // client calling it gets a 404, not a chat it did not ask for.
  test("the old POST /api/session is no longer routed", async () => {
    const { status } = await postJson("/api/session", { action: "new" });
    assert.equal(status, 404);
  });
});

describe("the archiving routes", () => {
  test("GET answers the archiving state", async () => {
    const { status, body } = await getJson("/api/archiving");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["enabled", "firstRunArchivedAt"]);
    assert.equal(typeof body.enabled, "boolean");
  });

  test("PUT { enabled } toggles the feature and answers the new state", async () => {
    const off = await sendJson("PUT", "/api/archiving", { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.deepEqual(Object.keys(off.body).sort(), ["enabled", "firstRunArchivedAt"]);
    assert.equal((await getJson("/api/archiving")).body.enabled, false);

    const on = await sendJson("PUT", "/api/archiving", { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
  });

  test("POST /api/archiving/sweep sweeps and adds the count to the state", async () => {
    const { status, body } = await postJson("/api/archiving/sweep");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["archived", "enabled", "firstRunArchivedAt"]);
    assert.equal(typeof body.archived, "number");
  });

  // The old endpoint dropped the sweep, silently, when `enabled` came along.
  // Two routes cannot shadow each other: the sweep runs whatever is toggled.
  test("a sweep next to a toggle is no longer swallowed", async () => {
    await sendJson("PUT", "/api/archiving", { enabled: true });
    const { status, body } = await postJson("/api/archiving/sweep");
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(typeof body.archived, "number");
  });

  test("a PUT with no enabled field is a 400", async () => {
    const { status, body } = await sendJson("PUT", "/api/archiving", {});
    assert.equal(status, 400);
    assert.match(body.error, /enabled must be a boolean/);
  });

  test("a non-boolean enabled is not a toggle: it is a 400", async () => {
    const { status, body } = await sendJson("PUT", "/api/archiving", { enabled: "yes" });
    assert.equal(status, 400);
    assert.match(body.error, /enabled must be a boolean/);
  });
});

describe("the usage credentials route", () => {
  test("DELETE /api/usage/credentials/:provider reports the state of both providers", async () => {
    const { status, body } = await sendJson("DELETE", "/api/usage/credentials/kimi");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status.kimi.configured, false);
  });

  test("an unknown provider in the path is a 400", async () => {
    const { status, body } = await sendJson("DELETE", "/api/usage/credentials/openai");
    assert.equal(status, 400);
    assert.match(body.error, /unknown provider/);
  });
});
