// The HTTP surface of the integrated terminals: the life cycle of one terminal
// over the real server, and the one rule that has no exception — a peer that is
// not this machine gets a 403 on every terminal route, LAN access or not.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

// Same isolation as the other endpoint tests: the server rewrites its state
// files at boot, so it must never see the real ~/.pi/agent of whoever runs the
// suite. PI_WEB_UI_AGENT_DIR moves this project's stores, PI_CODING_AGENT_DIR
// the agent dir of the pi library, and PI_WEB_UI_TEST=1 is what makes the first
// one honoured at all — all before the dynamic import, which freezes them into
// module-level constants.
let agentDir;
let server;
let origin;

// The life-cycle test spawns a real PowerShell through node-pty.
const WINDOWS = process.platform === "win32";
const skip = WINDOWS ? false : "the terminals are spawned as PowerShell: Windows only";

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-terminal-endpoints-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { startServer } = await import("../server.mjs");
  server = await startServer({ port: 0 });
  origin = server.url.replace(/\/$/, "");
});

after(async () => {
  // Belt and braces: a PTY left alive keeps the event loop up forever.
  const { closeAllTerminals } = await import("../terminals.mjs");
  closeAllTerminals();
  await server?.stop();
  await rm(agentDir, { recursive: true, force: true });
});

// The request guard rejects unsafe methods without a same-origin Origin header,
// so every call carries one: a CSRF 403 would look like the loopback one.
async function sendJson(method, pathname, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Poll until `check` is true, or give up. */
async function waitFor(check, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * Open the SSE stream of a terminal and collect its `data:` frames until
 * `until` is happy (or the timeout aborts it), then hang up. The `id:` line
 * comes back on the frame, because the resume offset is what these tests are
 * about; `retry:` and the ping carry no data and are skipped.
 *
 * @param {string} id
 * @param {{ lastEventId?: number | string,
 *          until?: (frames: Frame[]) => boolean,
 *          timeout?: number }} [options]
 *
 * @typedef {{ id: number | null, data?: string, reset?: boolean, exited?: number }} Frame
 */
async function readStream(id, { lastEventId, until = () => true, timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) };
  /** @type {Frame[]} */
  const frames = [];
  try {
    const res = await fetch(`${origin}/api/terminals/${encodeURIComponent(id)}/stream`, {
      headers,
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const lines = buffer.slice(0, cut).split("\n");
        buffer = buffer.slice(cut + 2);
        const data = lines.find((line) => line.startsWith("data: "));
        if (!data) continue;
        const eventId = lines.find((line) => line.startsWith("id: "));
        frames.push({ id: eventId ? Number(eventId.slice(4)) : null, ...JSON.parse(data.slice(6)) });
      }
      if (until(frames)) break;
    }
  } catch (err) {
    // The abort is how this helper hangs up, and how it gives up on a stream
    // that never said what the caller was waiting for: the assertions on the
    // frames collected so far are the ones that must report the failure.
    if (err?.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
}

describe("terminal endpoints", () => {
  test("POST /api/terminals refuses a kind outside the whitelist", async () => {
    const { status, body } = await sendJson("POST", "/api/terminals", { kind: "bash" });
    assert.equal(status, 400);
    assert.match(body.error, /pi.*shell/);
  });

  // Where PowerShell is not there to be spawned the feature answers 501 rather
  // than exploding inside node-pty — and the validation above still answers 400,
  // which is what the previous test checks on every platform.
  test("POST /api/terminals answers 501 where the terminals cannot exist", {
    skip: WINDOWS ? "this machine can spawn them" : false,
  }, async () => {
    const { status, body } = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(status, 501);
    assert.match(body.error, /not available/);
  });

  test("an unknown id is a 404, not a crash", async () => {
    assert.equal((await sendJson("POST", "/api/terminals/nope/input", { data: "x" })).status, 404);
    assert.equal((await sendJson("POST", "/api/terminals/nope/resize", { cols: 80, rows: 24 })).status, 404);
    assert.equal((await sendJson("POST", "/api/terminals/nope/open-folder", {})).status, 404);
    assert.equal((await sendJson("POST", "/api/terminals/nope/restart", {})).status, 404);
    assert.equal((await sendJson("DELETE", "/api/terminals/nope")).status, 404);
  });

  test("open-folder resolves the folder from the terminal resource", { skip }, async (t) => {
    const { createTerminal, closeTerminal } = await import("../terminals.mjs");
    const { handleOpenTerminalFolder } = await import("../api-terminals.mjs");
    const terminal = createTerminal({ kind: "shell", cwd: os.tmpdir() });
    t.after(() => closeTerminal(terminal.id));
    let opened = null;
    let status = 0;
    /** @type {any} */
    let payload = {};
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end(body) {
        payload = JSON.parse(body);
      },
    };

    await handleOpenTerminalFolder({
      req,
      res,
      params: { id: terminal.id },
      openFolderImpl: async (cwd) => {
        opened = cwd;
        return { ok: true };
      },
    });

    assert.equal(status, 200);
    assert.equal(opened, terminal.cwd, "the handler must use the selected terminal's cwd");
    assert.equal(payload.cwd, terminal.cwd);

    await handleOpenTerminalFolder({
      req,
      res,
      params: { id: terminal.id },
      openFolderImpl: async () => ({ ok: false, reason: "unavailable" }),
    });
    assert.equal(status, 501);
    assert.equal(payload.error.code, "folder_unavailable");
  });

  test("restart failure has its own observable error and does not report success", { skip }, async () => {
    const { handleRestartTerminal } = await import("../api-terminals.mjs");
    let status = 0;
    /** @type {any} */
    let payload = {};
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end(body) {
        payload = JSON.parse(body);
      },
    };

    await handleRestartTerminal({
      req,
      res,
      params: { id: "terminal-that-stays-put" },
      restartTerminalImpl: () => ({ ok: false, reason: "spawn_failed" }),
    });

    assert.equal(status, 500);
    assert.equal(payload.error.code, "terminal_restart_failed");
    assert.match(payload.error.message, /could not be restarted/);
  });

  test("create → list → input → stream → delete", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    const { id } = created.body;
    assert.ok(id, "the new terminal must come back with an id");
    // Registered before the first assertion that can fail: no orphan PowerShell.
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${id}`);
    });
    assert.equal(created.body.kind, "shell");
    assert.ok(created.body.cwd, "the server resolves the folder, the client never sends it");

    const listed = await sendJson("GET", "/api/terminals");
    assert.equal(listed.status, 200);
    const row = listed.body.terminals.find((terminal) => terminal.id === id);
    assert.ok(row, "the new terminal must be listed");
    assert.equal(row.exited, null);

    // A command whose echo is unmistakable in the scrollback.
    const typed = await sendJson("POST", `/api/terminals/${id}/input`, { data: "echo pi-marker-42\r" });
    assert.equal(typed.status, 200);
    assert.equal(typed.body.ok, true);

    assert.equal((await sendJson("POST", `/api/terminals/${id}/resize`, { cols: 100, rows: 30 })).body.ok, true);
    assert.equal((await sendJson("POST", `/api/terminals/${id}/resize`, { cols: 0, rows: 30 })).status, 400);
    assert.equal((await sendJson("POST", `/api/terminals/${id}/input`, { data: 7 })).status, 400);

    // The stream opens with the scrollback, so a late viewer sees the output
    // that was produced before it attached.
    const seen = await waitFor(async () => {
      const controller = new AbortController();
      try {
        const res = await fetch(`${origin}/api/terminals/${id}/stream`, { signal: controller.signal });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/event-stream/);
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        return text.includes("pi-marker-42");
      } finally {
        controller.abort();
      }
    });
    assert.ok(seen, "the SSE stream must replay the scrollback of the terminal");

    assert.equal((await sendJson("DELETE", `/api/terminals/${id}`)).status, 200);
    const after = await sendJson("GET", "/api/terminals");
    assert.ok(!after.body.terminals.some((terminal) => terminal.id === id), "a deleted terminal leaves the list");
  });

  test("restart replaces one terminal while close still removes it", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    let cleanupId = created.body.id;
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${cleanupId}`);
    });

    const restarted = await sendJson("POST", `/api/terminals/${created.body.id}/restart`, {});
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.previousId, created.body.id);
    assert.notEqual(restarted.body.terminal.id, created.body.id);
    assert.equal(restarted.body.terminal.cwd, created.body.cwd);
    assert.equal(restarted.body.terminal.kind, created.body.kind);
    cleanupId = restarted.body.terminal.id;

    assert.equal(
      (await sendJson("POST", `/api/terminals/${created.body.id}/input`, { data: "x" })).status,
      404,
      "the replaced process must no longer accept requests",
    );
    const listed = (await sendJson("GET", "/api/terminals")).body.terminals;
    assert.ok(!listed.some((terminal) => terminal.id === created.body.id));
    assert.ok(listed.some((terminal) => terminal.id === cleanupId));

    assert.equal((await sendJson("DELETE", `/api/terminals/${cleanupId}`)).status, 200);
    assert.equal((await sendJson("DELETE", `/api/terminals/${cleanupId}`)).status, 404);
  });

  // A reconnecting browser sends back the id of the last frame it saw. What it
  // must not get is the scrollback all over again: an xterm that is written the
  // same screen twice shows the session duplicated.
  test("the stream resumes from Last-Event-ID instead of replaying everything", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    const { id } = created.body;
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${id}`);
    });

    const marker = "pi-resume-marker-7";
    assert.equal((await sendJson("POST", `/api/terminals/${id}/input`, { data: `echo ${marker}\r` })).body.ok, true);

    // A viewer with no offset gets the whole window, flagged as a reset: it has
    // nothing on screen this output could be continuing.
    const fresh = await readStream(id, { until: (f) => f.some((frame) => frame.data.includes(marker)) });
    assert.ok(fresh.length > 0, "the stream must open with the scrollback");
    assert.equal(fresh[0].reset, true, "a viewer that cannot resume is told to reset");
    assert.ok(Number.isInteger(fresh[0].id), "every frame must carry the offset it brings the viewer to");
    assert.ok(fresh.some((frame) => frame.data.includes(marker)), "the scrollback must reach a fresh viewer");

    // Everything this viewer has seen, and the offset it stops at.
    const offset = fresh.at(-1).id;
    assert.ok(offset > 0);

    // Same terminal, same client, one reconnection later: nothing was produced
    // in between, so there is nothing to send.
    const resumed = await readStream(id, { lastEventId: offset, until: (f) => f.length > 0, timeout: 4000 });
    assert.ok(resumed.length > 0, "a resuming viewer must still be anchored to an offset");
    assert.notEqual(resumed[0].reset, true, "a resumable offset must not cost the viewer its screen");
    assert.ok(
      !resumed[0].data.includes(marker),
      `resuming must not replay the scrollback (got: ${JSON.stringify(resumed[0].data.slice(0, 200))})`,
    );
    assert.ok(resumed[0].id >= offset, "the offset never goes backwards");

    // An offset the registry cannot honour — a leftover from a previous life of
    // the server, or something hand-written — is not an error: it is a reset.
    for (const bogus of [offset + 10_000_000, "not-a-number"]) {
      const restarted = await readStream(id, {
        lastEventId: bogus,
        until: (f) => f.some((frame) => frame.data.includes(marker)),
      });
      assert.equal(restarted[0].reset, true, `an unusable Last-Event-ID (${bogus}) must reset the viewer`);
      assert.ok(restarted.some((frame) => frame.data.includes(marker)), "a reset carries the whole window");
    }
  });

  // A pane nobody is typing into has no other way of learning that its process
  // is gone: `ok: false` on the next keystroke would come minutes late, or
  // never. The death has to travel on the stream itself.
  test("the death of the process comes back as an `exited` frame", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    const { id } = created.body;
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${id}`);
    });

    const gotExit = (frames) => frames.some((frame) => typeof frame.exited === "number");
    // The stream is opened first, but the race does not matter: a viewer that
    // attaches after the exit is told at once, one that was already there is
    // told live. Either way the frame arrives.
    const streaming = readStream(id, { until: gotExit });
    assert.equal((await sendJson("POST", `/api/terminals/${id}/input`, { data: "exit 5\r" })).body.ok, true);

    const frames = await streaming;
    const exit = frames.find((frame) => typeof frame.exited === "number");
    assert.ok(exit, "the open stream must be told the process died");
    assert.equal(exit.exited, 5, "the frame carries the exit code of the shell");

    // The row outlives the process: that is what keeps the pane reopenable.
    const row = (await sendJson("GET", "/api/terminals")).body.terminals.find((t2) => t2.id === id);
    assert.ok(row, "an exited terminal stays in the list until it is closed");
    assert.equal(row.exited, 5);

    // Reopening the pane: the viewer arrives long after the death and still has
    // to end up read-only, so the frame is repeated to whoever attaches.
    const late = await readStream(id, { until: gotExit, timeout: 5000 });
    assert.ok(gotExit(late), "a viewer attaching after the exit must be told too");
  });

  // Concluding a chat concludes its consoles: the process stops, the row and
  // its scrollback stay, so the pane reopens read-only.
  test("marking a chat done switches off the terminals opened from it", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    const { id } = created.body;
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${id}`);
    });

    const row = (await sendJson("GET", "/api/terminals")).body.terminals.find((t2) => t2.id === id);
    assert.ok(row.chatKey, "a terminal must remember the chat it was opened from");
    assert.equal(row.exited, null);

    // The chat of this tab is the one the terminal was opened from.
    const done = await sendJson("POST", "/api/status", { path: row.chatKey, status: "done" });
    assert.equal(done.status, 200);

    const off = await waitFor(async () => {
      const list = (await sendJson("GET", "/api/terminals")).body.terminals;
      return list.find((t2) => t2.id === id)?.exited !== null;
    });
    assert.ok(off, "concluding the chat must switch its terminal off");

    const after = (await sendJson("GET", "/api/terminals")).body.terminals.find((t2) => t2.id === id);
    assert.ok(after, "the row must survive the process: the scrollback is still readable");
    assert.equal((await sendJson("POST", `/api/terminals/${id}/input`, { data: "echo late\r" })).body.ok, false);

    // Reopening it: the stream still serves the scrollback, plus the frame that
    // makes the pane read-only.
    const frames = await readStream(id, {
      until: (f) => f.some((frame) => typeof frame.exited === "number"),
      timeout: 5000,
    });
    assert.ok(frames.some((frame) => typeof frame.exited === "number"), "the reopened pane is told it is read-only");
    assert.ok(frames.some((frame) => (frame.data ?? "").length > 0), "the scrollback survives the process");

    // Leave the store as it was found: the other tests read the same chat.
    await sendJson("POST", "/api/status", { path: row.chatKey, status: "active" });
  });

  // A restart kills every terminal, whatever is running in it. With one alive
  // the call is refused until the caller confirms with `force`, and — the part
  // that matters — nothing is stopped in the meantime.
  // Only the refused branch is exercised here on purpose: this suite has no
  // Electron host, so a restart that went through would shut the test server
  // (and this process) down. That the gate lets a terminal-free restart pass is
  // covered by countLiveTerminals() in terminals.test.mjs.
  test("a live terminal makes the restart ask first", { skip }, async (t) => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);
    const { id } = created.body;
    t.after(async () => {
      await sendJson("DELETE", `/api/terminals/${id}`);
    });

    const refused = await sendJson("POST", "/api/restart", {});
    assert.equal(refused.status, 409, "a restart that would close a terminal is not carried out unasked");
    assert.equal(refused.body.error.code, "work_in_progress");
    assert.ok(refused.body.error.terminals >= 1, "the answer says how many terminals are at stake");
    assert.match(refused.body.error.message, /terminal/);

    // Same guard, same answer, on the other route that stops the server.
    const refusedStop = await sendJson("POST", "/api/shutdown", {});
    assert.equal(refusedStop.status, 409, "a shutdown that would close a terminal is not carried out unasked");
    assert.equal(refusedStop.body.error.code, "work_in_progress");

    // The refusal is a refusal: the server is still up and the terminal alive.
    assert.equal((await sendJson("GET", "/api/terminals")).body.terminals.find((t2) => t2.id === id)?.exited, null);
    assert.equal((await sendJson("POST", `/api/terminals/${id}/input`, { data: "echo alive\r" })).body.ok, true);
  });
});

// The guard reads the socket peer, which a test over loopback cannot fake, so
// the handlers are called directly with a request whose peer is a LAN address.
// Everything else is legitimate: same origin, and a valid session — the point
// is that being allowed *into the app* is not being allowed *into a shell*.
describe("terminals are loopback only", () => {
  const handlerNames = [
    ["handleListTerminals", "GET"],
    ["handleCreateTerminal", "POST"],
    ["handleTerminalStream", "GET"],
    ["handleTerminalInput", "POST"],
    ["handleTerminalResize", "POST"],
    ["handleOpenTerminalFolder", "POST"],
    ["handleRestartTerminal", "POST"],
    ["handleDeleteTerminal", "DELETE"],
  ];

  test("every handler answers 403 to a LAN peer", async () => {
    const api = await import("../api-terminals.mjs");
    for (const [name, method] of handlerNames) {
      const sent = { code: null, payload: null };
      const req = {
        method,
        headers: { host: "192.168.1.20:3777" },
        socket: { remoteAddress: "192.168.1.20" },
        // A body the handler must never get as far as reading.
        [Symbol.asyncIterator]: async function* () {},
        on() {},
      };
      const res = {
        headersSent: false,
        writeHead(code) {
          sent.code = code;
          return this;
        },
        write() {
          sent.payload = "stream";
          return true;
        },
        end(body) {
          if (typeof body === "string") sent.payload = body;
        },
      };
      await api[name]({ req, res, sessionKey: null, params: { id: "whatever" } });
      assert.equal(sent.code, 403, `${name} must refuse a non-loopback peer`);
      assert.match(String(sent.payload), /this machine only/);
    }
  });

  test("a loopback peer is not refused by the same guard", async () => {
    const { handleListTerminals } = await import("../api-terminals.mjs");
    const sent = { code: null };
    const req = { method: "GET", headers: { host: "127.0.0.1:3777" }, socket: { remoteAddress: "::ffff:127.0.0.1" } };
    const res = {
      headersSent: false,
      writeHead(code) {
        sent.code = code;
        return this;
      },
      end() {},
    };
    await handleListTerminals({ req, res });
    assert.equal(sent.code, 200);
  });
});

// Last of the file on purpose: it stops the server, which is exactly what it
// has to observe. A quit that forgets the terminals leaves an orphan
// powershell.exe per open one, so the call in stopServer() gets a guard.
describe("stopping the server", () => {
  test("takes the terminals down with it", { skip }, async () => {
    const created = await sendJson("POST", "/api/terminals", { kind: "shell" });
    assert.equal(created.status, 200);

    await server.stop();

    const { listTerminals } = await import("../terminals.mjs");
    assert.deepEqual(listTerminals(), [], "no terminal may outlive the server that owns it");
  });
});
