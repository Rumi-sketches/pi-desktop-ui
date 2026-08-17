/**
 * api-chat.mjs — the endpoints of a chat: what it is, what it did, what it can
 * do next.
 *
 * Everything here is scoped to the context a tab is attached to (`?s=<key>` or
 * the `x-pi-session` header, resolved by useContext): its model, its folder,
 * its history, the files it touched, the sessions it can switch to. Handlers
 * stay thin on purpose — parse the request, ask contexts.mjs or the store, send
 * the answer — so the rules live in one place and the HTTP layer in another.
 */
import path from "node:path";
import { pickFolder, openFolder, openTerminal, platformCapabilities } from "./platform.mjs";
import { isNonEmptyString, jsonBody, send, sendError } from "./http.mjs";
import {
  SESSIONS_DIR,
  SESSION_STATUS_INPUTS,
  forgetCwd,
  isArchivingEnabled,
  isFavorite,
  isInsideDir,
  listFavorites,
  recentCwdList,
  redactSecrets,
  rememberCwd,
  resolveDir,
  resolveFile,
  sessionStatusOf,
  setFavorite,
  setSessionStatus,
} from "./session-store.mjs";
import {
  attachEventClient,
  broadcast,
  broadcastGlobal,
  broadcastUsage,
  createContext,
  extractToolText,
  gitStatus,
  pickerModels,
  sanitizeArgs,
  sessionCommands,
  summarizeTool,
  supportedThinkingLevels,
  availableModels,
  openContextKeys,
  runningContextKeys,
  tabCwd,
  totals,
  useContext,
} from "./contexts.mjs";
import { scanSessionFile } from "./analytics.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// ---- the event stream ------------------------------------------------------
export async function handleEvents({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    // tells nginx and friends not to buffer the stream
    "X-Accel-Buffering": "no",
  });
  // events are small and latency-sensitive, and the socket must outlive a
  // long silent turn of the agent
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  res.write("retry: 1000\n\n");
  req.on("close", attachEventClient(ctx, res));
  return;
}

/**
 * @typedef {object} ChatUsage tokens and cost of a single chat.
 * @property {number} tokens
 * @property {number} input
 * @property {number} output
 * @property {number} cacheWrite
 * @property {number} cacheRead
 * @property {number} cost
 * @property {number} requests
 */

/**
 * @typedef {object} StatePayload body of `GET /api/state`: everything the page
 *   needs to render the current chat on load.
 * @property {string} key opaque key of the context this tab is bound to.
 * @property {string|null} sessionFile session file backing the chat, if any.
 * @property {string} cwd project folder of the chat.
 * @property {string[]} thinkingLevels reasoning levels the model supports.
 * @property {{provider: string, id: string}|null} current model in use.
 * @property {string|null} thinkingLevel reasoning level in use.
 * @property {{input: number, output: number, cost: number, requests: number}} totals
 *   server-wide cumulative counters, across every chat.
 * @property {ChatUsage} chat usage of this chat only.
 * @property {Record<string, ChatUsage>} chatByModel same, split per model.
 * @property {{used: number, window: number}} context context window occupancy.
 * @property {boolean} streaming whether a turn is running right now.
 * @property {Awaited<ReturnType<typeof platformCapabilities>>} platform native
 *   operations this machine can honour; the UI hides the buttons that would fail.
 * @property {boolean} chatArchiving whether the archiving feature is on.
 */

export async function handleGetState({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  /** @type {StatePayload} */
  const payload = {
    key: ctx.key,
    sessionFile: ctx.sessionFile,
    cwd: ctx.cwd,
    thinkingLevels: supportedThinkingLevels(session.model),
    current: session.model ? { provider: session.model.provider, id: session.model.id } : null,
    thinkingLevel: session.thinkingLevel,
    totals,
    chat: ctx.chat,
    chatByModel: ctx.chatByModel,
    context: ctx.context,
    streaming: ctx.running || session.isStreaming,
    // the UI hides the native buttons this machine cannot honour
    platform: await platformCapabilities(),
    // when off, the sidebar goes back to a flat list with no trace of the feature
    chatArchiving: isArchivingEnabled(),
  };
  return send(res, 200, payload);
}

export async function handleGetModels({ res, sessionKey }) {
  const { session } = await useContext(sessionKey);
  const models = await pickerModels(session);
  return send(res, 200, {
    current: session.model ? { provider: session.model.provider, id: session.model.id } : null,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: supportedThinkingLevels(session.model),
    models: models.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: Boolean(m.reasoning),
      contextWindow: m.contextWindow ?? 0,
      thinkingLevels: supportedThinkingLevels(m),
    })),
  });
}

export async function handleSetModel({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  const { provider, id } = await jsonBody(req);
  if (!isNonEmptyString(provider) || !isNonEmptyString(id)) {
    return send(res, 400, { error: "provider and id must be non-empty strings" });
  }
  const models = await availableModels();
  const model = models.find((m) => m.provider === provider && m.id === id);
  if (!model) return send(res, 404, { error: "model not found or not authenticated" });
  await session.setModel(model);
  // the context window depends on the model: recompute it right away so the
  // topbar/composer bar reflects the new model instead of staying stale
  // until the next message (which is when it used to get updated)
  ctx.context = { used: ctx.context?.used ?? 0, window: model.contextWindow ?? 0 };
  broadcastUsage(ctx);
  return send(res, 200, {
    ok: true,
    current: { provider, id },
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: supportedThinkingLevels(session.model),
    context: ctx.context,
  });
}

export async function handleSetThinkingLevel({ req, res, sessionKey }) {
  const { session } = await useContext(sessionKey);
  const { level } = await jsonBody(req);
  const levels = supportedThinkingLevels(session.model);
  if (!levels.includes(level)) {
    return send(res, 400, { error: `invalid thinking level, expected one of: ${levels.join(", ")}` });
  }
  session.setThinkingLevel(level);
  return send(res, 200, { ok: true, thinkingLevel: session.thinkingLevel, thinkingLevels: levels });
}

export async function handleSetCwd({ req, res, sessionKey }) {
  const { path: newPath } = await jsonBody(req);
  let dir;
  try {
    dir = await resolveDir(newPath);
  } catch (e) {
    return sendError(res, 400, "invalid_folder", String(e.message ?? e));
  }
  // The folder is picked BEFORE the chat starts: an empty chat is just the
  // home screen (nothing exists on disk until the first prompt), so this
  // only decides where the next chat will live. Once the chat has messages
  // the folder is part of it and cannot be moved — the UI hides the control,
  // this is the safety net.
  const cur = await useContext(sessionKey);
  if (cur.session.messages.length > 0) {
    // 409, not 400: the request is well formed, it is the state of the chat
    // that rules it out.
    return sendError(
      res,
      409,
      "chat_already_started",
      "This chat has already started: the folder cannot be changed. Open a new chat to work somewhere else.",
    );
  }
  if (path.resolve(cur.cwd) === dir) {
    await rememberCwd(cur.cwd);
    return send(res, 200, { ok: true, cwd: cur.cwd, key: cur.key });
  }
  const ctx = await createContext({ cwd: dir, mode: "new" });
  await rememberCwd(ctx.cwd);
  return send(res, 200, { ok: true, cwd: ctx.cwd, key: ctx.key });
}

// Recent folders: GET the list, DELETE one entry (?path=…) to forget it.
// Both answer with the list, so the caller never needs a second round-trip.
export async function handleGetRecentCwds({ res }) {
  return send(res, 200, { recent: recentCwdList() });
}

export async function handleForgetRecentCwd({ res, url }) {
  await forgetCwd(url.searchParams.get("path") ?? "");
  return send(res, 200, { recent: recentCwdList() });
}

export async function handleOpenExplorer({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const opened = await openFolder(ctx.cwd);
  if (!opened.ok) return send(res, 501, { error: "opening a folder is not available on this system" });
  return send(res, 200, { ok: true, cwd: ctx.cwd });
}

export async function handleOpenTerminal({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const opened = await openTerminal(ctx.cwd, "pi");
  if (!opened.ok) return send(res, 501, { error: "opening a terminal is not available on this system" });
  return send(res, 200, { ok: true, cwd: ctx.cwd });
}

export async function handleSetFavorite({ req, res }) {
  const { path: favPath, favorite } = await jsonBody(req);
  if (!favPath || typeof favPath !== "string") {
    return send(res, 400, { error: "missing path" });
  }
  await setFavorite(favPath, favorite);
  return send(res, 200, { ok: true, favorites: listFavorites() });
}

export async function handleSetSessionStatus({ req, res }) {
  const { path: chatPath, status } = await jsonBody(req);
  if (!chatPath || typeof chatPath !== "string") {
    return send(res, 400, { error: "missing path" });
  }
  if (!SESSION_STATUS_INPUTS.includes(status)) {
    return send(res, 400, { error: `invalid status, expected one of: ${SESSION_STATUS_INPUTS.join(", ")}` });
  }
  await setSessionStatus(chatPath, status);
  broadcastGlobal({ kind: "sessions" });
  return send(res, 200, { ok: true, status: sessionStatusOf(chatPath) });
}

export async function handlePickFolder({ res, sessionKey }) {
  const current = tabCwd(sessionKey);
  const picked = await pickFolder(current);
  if (!picked.ok) {
    return sendError(res, 501, "picker_unavailable", "no native folder picker on this system");
  }
  // Closing the dialog used to be a 200 with `{ cancelled: true }`, which made
  // "no folder" look like a result. 409 for the same reason as a chat already
  // started: the request is well formed, the outcome rules the answer out. The
  // page keeps it silent (no toast) — cancelling is a choice, not a fault.
  if (!picked.path) return sendError(res, 409, "cancelled", "folder choice cancelled");
  let dir;
  try {
    dir = await resolveDir(picked.path);
  } catch (e) {
    return sendError(res, 400, "invalid_folder", String(e.message ?? e));
  }
  return send(res, 200, { path: dir });
}

export async function handleGetGitStatus({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  return send(res, 200, await gitStatus(ctx.cwd));
}

export async function handleListSessions({ res, url, sessionKey }) {
  // scope=all → sessions of every project, scope=cwd (default) → current dir only
  const scope = url.searchParams.get("scope") ?? "cwd";
  const ctx = await useContext(sessionKey);
  const list =
    scope === "all" ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd);
  return send(res, 200, {
    current: ctx.sessionFile ?? null,
    cwd: ctx.cwd,
    scope,
    running: runningContextKeys(),
    open: openContextKeys(),
    sessions: await Promise.all(
      list
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        .map(async (s) => {
          // last model used in that chat, so the sidebar can show its logo
          // (scanSessionFile is mtime-cached: repeated calls are free)
          const scan = await scanSessionFile(s.path).catch(() => null);
          const last = scan?.lastModel ?? null;
          return {
            path: s.path,
            id: s.id,
            cwd: s.cwd ?? "",
            name: s.name ?? "",
            firstMessage: s.firstMessage ?? "",
            messageCount: s.messageCount ?? 0,
            modified: s.modified,
            favorite: isFavorite(s.path),
            status: sessionStatusOf(s.path),
            provider: last?.provider ?? "",
            model: last?.model ?? "",
          };
        }),
    ),
  });
}

// Every route that puts the tab on a chat answers with the same payload: the
// context key the client sends back as `?s=`, its folder, and whether a run is
// already going on in there.
function sendContext(res, ctx) {
  return send(res, 200, { ok: true, key: ctx.key, cwd: ctx.cwd, running: ctx.running });
}

export async function handleCreateSession({ res, sessionKey }) {
  return sendContext(res, await createContext({ cwd: tabCwd(sessionKey), mode: "new" }));
}

// No id in the path: "the most recent chat of this folder", whichever it is.
export async function handleActivateRecentSession({ res, sessionKey }) {
  return sendContext(res, await createContext({ cwd: tabCwd(sessionKey), mode: "continue" }));
}

// `:id` is the chat's session file, url-encoded. A saved chat may belong to
// another project, so the body may carry the working directory to follow.
export async function handleActivateSession({ req, res, sessionKey, params }) {
  const { cwd: wantedCwd } = await jsonBody(req);
  let targetCwd = tabCwd(sessionKey);
  let safePath;
  try {
    safePath = await resolveFile(params.id);
    // only files under the sessions directory may be parsed as sessions
    if (!isInsideDir(safePath, SESSIONS_DIR)) {
      return send(res, 400, { error: "path is outside the sessions directory" });
    }
    if (wantedCwd) targetCwd = await resolveDir(wantedCwd);
  } catch (e) {
    return send(res, 400, { error: String(e.message ?? e) });
  }
  return sendContext(res, await createContext({ cwd: targetCwd, mode: "open", openPath: safePath }));
}

// "Fork from here": extract the path from root to a given message entry into a
// brand new session file, then open that file like any other saved chat.
// Native SessionManager API (same one behind pi's own /fork).
//
// `:id` is validated exactly like in the activate route above: useContext falls
// back to the most recent chat of the default folder when the id does not
// resolve, and forking a chat nobody asked for is worse than a 400.
export async function handleForkSession({ req, res, params }) {
  const { entryId } = await jsonBody(req);
  if (!isNonEmptyString(entryId)) return send(res, 400, { error: "missing entryId" });
  // a draft chat (no file yet) is keyed `draft:<cwd>`: nothing to branch from
  if (typeof params.id === "string" && params.id.startsWith("draft:")) {
    return send(res, 400, { error: "cannot fork: this chat has no session file yet" });
  }
  let safePath;
  try {
    safePath = await resolveFile(params.id);
    // only files under the sessions directory may be parsed as sessions
    if (!isInsideDir(safePath, SESSIONS_DIR)) {
      return send(res, 400, { error: "path is outside the sessions directory" });
    }
  } catch (e) {
    return send(res, 400, { error: String(e.message ?? e) });
  }
  const source = await useContext(safePath);
  let newFile;
  try {
    newFile = source.session.sessionManager?.createBranchedSession?.(entryId);
  } catch (e) {
    return send(res, 400, { error: String(e.message ?? e) });
  }
  if (!newFile) return send(res, 400, { error: "cannot fork: session not persisted" });
  return sendContext(res, await createContext({ cwd: source.cwd, mode: "open", openPath: newFile }));
}

export async function handleGetCommands({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  return send(res, 200, { commands: await sessionCommands(ctx) });
}

export async function handleGetFiles({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  return send(res, 200, {
    files: [...ctx.files.values()].map((f) => ({
      path: f.path,
      changes: f.writes + f.hunks.length,
    })),
  });
}

export async function handleGetFileDiff({ res, url, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const p = url.searchParams.get("path");
  const f = p && ctx.files.get(p);
  if (!f) return send(res, 404, { error: "file not tracked" });
  // A file whose *name* looks like a secret store (.env.secret, api-key.json,
  // …) still shows up as changed, but its text is redacted like settings.json
  // is in /api/config. Normal files keep the exact same payload as before.
  const redact = (text) => redactSecrets(text ?? "", path.basename(f.path));
  return send(res, 200, {
    path: f.path,
    write: f.writes > 0 ? { content: redact(f.content) } : null,
    hunks: f.hunks.map((h) => ({ oldText: redact(h.oldText), newText: redact(h.newText) })),
  });
}

export async function handleGetHistory({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  // entry ids (for the "fork from here" button): the session's tree path from
  // root to the current leaf, filtered to message entries, lines up 1:1 with
  // the user/assistant messages below (both walk the same active branch).
  let entryIds = [];
  try {
    entryIds = (session.sessionManager?.getBranch?.() ?? [])
      .filter((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
      .map((e) => e.id);
  } catch {
    /* ids are a nice-to-have for forking: history still renders without them */
  }
  const chatMsgs = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
  // tool results live in their own messages: index them by tool call id so the
  // reconstructed history can show the output inside the matching tool card
  const toolResults = new Map();
  for (const m of session.messages) {
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, {
        output: extractToolText({ content: m.content }),
        isError: !!m.isError,
      });
    }
  }
  const idsAligned = entryIds.length === chatMsgs.length;
  const msgs = chatMsgs.map((m, i) => ({
    role: m.role,
    text: (m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(""),
    // full ordered content of the turn (text, thinking, tool calls with their
    // results): without this a refresh would drop everything but the text
    blocks: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []))
      .map((c) => {
        if (c.type === "text") return c.text ? { type: "text", text: c.text } : null;
        if (c.type === "thinking") return c.thinking ? { type: "thinking", text: c.thinking } : null;
        if (c.type === "toolCall") {
          const r = toolResults.get(c.id);
          return {
            type: "tool",
            id: c.id,
            name: c.name,
            args: sanitizeArgs(c.arguments),
            summary: summarizeTool(c.name, c.arguments),
            // no result stored → the tool never finished (aborted turn)
            status: r ? "end" : "start",
            output: r?.output ?? "",
            isError: r?.isError ?? false,
          };
        }
        return null;
      })
      .filter(Boolean),
    entryId: idsAligned ? (entryIds[i] ?? null) : null,
    // which model produced this message (assistant only): the UI labels
    // each turn with it, so a mid-chat model switch stays visible
    ...(m.role === "assistant"
      ? {
          provider: m.provider ?? null,
          model: m.model ?? null,
          // why the turn ended: an error/abort has no content blocks, so
          // this is all the UI has to explain the empty answer
          stopReason: m.stopReason ?? null,
          errorMessage: m.errorMessage ?? null,
        }
      : {}),
  }));
  return send(res, 200, {
    key: ctx.key,
    messages: msgs,
    // which model is answering right now (labels the reconstructed live turn)
    turnModel: ctx.turnModel,
    // whatever is streaming right now, so re-entering a busy chat shows it
    live: ctx.running ? ctx.live : [],
    streaming: ctx.running || session.isStreaming,
  });
}

export async function handlePrompt({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  const { text, images } = await jsonBody(req);
  const imgs = Array.isArray(images)
    ? images
        .filter((i) => i?.data && i?.mimeType)
        .map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))
    : [];
  if (!text?.trim() && imgs.length === 0) return send(res, 400, { error: "empty prompt" });
  const opts = imgs.length ? { images: imgs } : undefined;
  // writing in a done chat brings it back to life as "reopened"
  if (ctx.sessionFile && sessionStatusOf(ctx.sessionFile) === "done") {
    setSessionStatus(ctx.sessionFile, "reopened").then(() => broadcastGlobal({ kind: "sessions" }));
  }
  session
    .prompt(text ?? "", opts)
    .catch((err) => broadcast(ctx, { kind: "error", message: String(err) }));
  return send(res, 202, { ok: true, key: ctx.key });
}

export async function handleAbort({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  await ctx.session.abort();
  return send(res, 200, { ok: true });
}
