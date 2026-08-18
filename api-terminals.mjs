/**
 * api-terminals.mjs — the HTTP surface of the integrated terminals.
 *
 * The registry (terminals.mjs) owns the processes; this module only exposes
 * them: create one in the folder of the chat the tab is on, list them, stream
 * their output, type into them, resize them, kill them.
 *
 * One rule overrides everything else here: **these routes answer the local
 * machine only**. A terminal is an unrestricted shell with the privileges of
 * whoever started the server, so LAN access — token, cookie and all — buys no
 * right to it. The guard is the TCP peer, the only signal a client cannot
 * forge, and it is hard-coded: there is no setting that turns it off.
 *
 * Transport: SSE for the output (scrollback first, then live), plain POSTs for
 * input and resize. No WebSocket, so the page stays a page.
 */
import { isLoopbackPeer } from "./access-control.mjs";
import { SSE_PING, SSE_PING_MS, jsonBody, openSseStream, send, sseSend, sseWrite } from "./http.mjs";
import { broadcastGlobal, useContext } from "./contexts.mjs";
import {
  closeTerminal,
  createTerminal,
  getScrollbackSince,
  getTerminal,
  isTerminalKind,
  listTerminals,
  resize,
  setTerminalsChangedListener,
  subscribe,
  writeTo,
} from "./terminals.mjs";

// Any change to the list (create, exit on its own, close) is pushed to every
// open tab, which reloads the sidebar section. Registered on import: the
// server imports this module to route the terminals, so there is no state in
// which the routes exist and the notification does not.
setTerminalsChangedListener(() => broadcastGlobal({ kind: "terminals" }));

/**
 * The whole authorization of this module: is the socket peer this machine?
 * @param {import("node:http").IncomingMessage} req
 */
function isLocalRequest(req) {
  return isLoopbackPeer(req.socket?.remoteAddress);
}

/** @param {import("node:http").ServerResponse} res */
function denyRemote(res) {
  return send(res, 403, { error: "terminals are available from this machine only" });
}

/** @param {import("node:http").ServerResponse} res */
function notFound(res) {
  return send(res, 404, { error: "unknown terminal" });
}

/**
 * Where a reconnecting viewer says it got to. The header is written by the
 * browser, not by our code, and an old or hand-made one is not an error: it is
 * simply not resumable, and the registry answers that with a reset.
 * @param {import("node:http").IncomingMessage} req
 * @returns {number | null} null when there is nothing usable to resume from
 */
function lastEventId(req) {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const offset = Number(value.trim());
  return Number.isSafeInteger(offset) ? offset : null;
}

// ---- the routes ------------------------------------------------------------

/** POST /api/terminals — a terminal in the folder of the tab's chat. */
export async function handleCreateTerminal({ req, res, sessionKey }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  const { kind } = await jsonBody(req);
  if (!isTerminalKind(kind)) return send(res, 400, { error: "kind must be 'pi' or 'shell'" });
  // The registry spawns PowerShell by absolute path: elsewhere the spawn would
  // fail deep inside node-pty and surface as a bare 500. Same 501 the other
  // platform-bound endpoints answer with (api-chat.mjs). It comes after the
  // validation, so a malformed request reads the same on every platform.
  if (process.platform !== "win32") {
    return send(res, 501, { error: "integrated terminals are not available on this system" });
  }
  // The client never names a folder: it is the chat's own cwd, resolved here.
  const ctx = await useContext(sessionKey);
  // The chat is remembered, not just its folder: concluding that chat is what
  // switches these terminals off (POST /api/status).
  const terminal = createTerminal({ kind, cwd: ctx.cwd, chatKey: ctx.key });
  return send(res, 200, { id: terminal.id, kind: terminal.kind, cwd: terminal.cwd });
}

/** GET /api/terminals — what the sidebar draws. */
export async function handleListTerminals({ req, res }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  return send(res, 200, { terminals: listTerminals() });
}

/**
 * GET /api/terminals/:id/stream — the scrollback, then the live output, as SSE
 * frames `{ data }`. Chunks travel inside JSON because a terminal emits raw
 * control bytes and newlines, which the SSE framing would otherwise eat.
 *
 * Every frame carries the offset it brings the viewer to, so a reconnect (a
 * dropped socket, a laptop coming back from sleep) replays what was missed and
 * nothing else. When the offset asked for has already scrolled out of the
 * scrollback the first frame comes with `reset: true`: the viewer clears its
 * screen and takes the window as it is, because the bytes in between are gone.
 *
 * The death of the process travels on the same channel, as `{ exited: code }`:
 * a pane nobody is typing into has no other way of learning that it has become
 * read-only.
 */
export async function handleTerminalStream({ req, res, params }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  const id = params.id;
  const terminal = getTerminal(id);
  if (!terminal) return notFound(res);
  // Keystroke echo is the most latency-sensitive traffic this server carries,
  // and a terminal nobody types into stays silent far longer than a chat does:
  // the keepalive of the shared helper is what holds the socket open.
  openSseStream(res);
  // Snapshot and subscription happen in the same tick, with no await between
  // them: a chunk cannot slip through the gap and be lost by both.
  const missed = getScrollbackSince(id, lastEventId(req));
  if (!missed) return res.end();
  // Sent even when empty: it is what anchors the client to an offset, so its
  // next reconnect has a Last-Event-ID to resume from.
  sseSend(res, missed.reset ? { data: missed.data, reset: true } : { data: missed.data }, missed.offset);
  // A terminal that died before this viewer attached (a reopened pane, a
  // reconnection after the exit) is told right away: the frame is the only
  // thing that makes the pane read-only, so it cannot be one the client misses.
  if (terminal.exited !== null) sseSend(res, { exited: terminal.exited }, missed.offset);
  const detach = subscribe(
    id,
    (data, offset) => sseSend(res, { data }, offset),
    (code, offset) => sseSend(res, { exited: code }, offset),
  );
  if (!detach) return res.end();
  // The old try/catch here protected nothing: a write on a dead socket fails
  // asynchronously, so the guard has to come before it, not around it.
  const ping = setInterval(() => sseWrite(res, SSE_PING), SSE_PING_MS);
  ping.unref();
  // Without this the subscriber set grows by one on every reload, and the
  // registry keeps writing into dead responses forever.
  req.on("close", () => {
    clearInterval(ping);
    detach();
  });
  return;
}

/** POST /api/terminals/:id/input — what the user typed. */
export async function handleTerminalInput({ req, res, params }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  if (!getTerminal(params.id)) return notFound(res);
  const { data } = await jsonBody(req);
  if (typeof data !== "string") return send(res, 400, { error: "data must be a string" });
  // `ok: false` means the process died: the row is still there, it just cannot
  // be typed into anymore. That is a state, not a failure of the request.
  return send(res, 200, { ok: writeTo(params.id, data) });
}

/** POST /api/terminals/:id/resize — the viewport of the xterm that shows it. */
export async function handleTerminalResize({ req, res, params }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  if (!getTerminal(params.id)) return notFound(res);
  const { cols, rows } = await jsonBody(req);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    return send(res, 400, { error: "cols and rows must be positive integers" });
  }
  return send(res, 200, { ok: resize(params.id, cols, rows) });
}

/** DELETE /api/terminals/:id — kill the process and drop the row. */
export async function handleDeleteTerminal({ req, res, params }) {
  if (!isLocalRequest(req)) return denyRemote(res);
  if (!closeTerminal(params.id)) return notFound(res);
  return send(res, 200, { ok: true });
}
