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
import { pickFolder, openFolder, openTerminal, typeInTerminal, platformCapabilities } from "./platform.mjs";
import { terminateTerminalsForChat } from "./terminals.mjs";
import { isNonEmptyString, jsonBody, openSseStream, send, sendBytes, sendError } from "./http.mjs";
import { titleFor } from "./titles.mjs";
import {
  SESSIONS_DIR,
  SESSION_STATUS_INPUTS,
  forgetCwd,
  isArchivingEnabled,
  isFavorite,
  isFullSearchEnabled,
  isInsideDir,
  listFavorites,
  readSessionRecords,
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
  compactSkillBlock,
  extractToolText,
  filesForProject,
  diffForProjectFile,
  gitStatus,
  pickerModels,
  prepareFirstPrompt,
  refreshSessionMetrics,
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
import { PromptQueueError, normalizePromptInput, queuedExtensionCommand } from "./prompt-queue.mjs";

// ---- the event stream ------------------------------------------------------
export async function handleEvents({ req, res, sessionKey }) {
  let closed = false;
  let detach = null;
  req.once("close", () => {
    closed = true;
    detach?.();
  });
  const ctx = await useContext(sessionKey);
  if (closed || res.destroyed) return;
  openSseStream(res);
  detach = attachEventClient(ctx, res);
  // A close queued between resolving the context and attaching the listener
  // must not leave a dead response in either client set.
  if (closed || res.destroyed) detach();
}

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
 * @property {object} metrics canonical session totals, per-model attribution,
 *   optional Session work difference and nullable SDK context usage.
 * @property {boolean} streaming whether a turn is running right now.
 * @property {Array<{id: string, type: "steer"|"followUp", text: string,
 *   attachments: Array<{mimeType: string, bytes: number}>, bytes: number}>} queuedPrompts
 *   cancellable prompts pending in this context; attachment data is never exposed.
 * @property {Awaited<ReturnType<typeof platformCapabilities>>} platform native
 *   operations this machine can honour; the UI hides the buttons that would fail.
 * @property {boolean} chatArchiving whether the archiving feature is on.
 */

export async function handleGetState({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  refreshSessionMetrics(ctx);
  /** @type {StatePayload} */
  const payload = {
    key: ctx.key,
    sessionFile: ctx.sessionFile,
    cwd: ctx.cwd,
    thinkingLevels: supportedThinkingLevels(session.model),
    current: session.model ? { provider: session.model.provider, id: session.model.id } : null,
    thinkingLevel: session.thinkingLevel,
    totals,
    metrics: ctx.metrics,
    streaming: contextIsBusy(ctx),
    queuedPrompts: ctx.promptQueue.publicItems(),
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
  // getContextUsage() recomputes both window and percentage for the new model.
  refreshSessionMetrics(ctx);
  broadcastUsage(ctx);
  return send(res, 200, {
    ok: true,
    current: { provider, id },
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: supportedThinkingLevels(session.model),
    metrics: ctx.metrics,
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

// The command shown in a chat, handed to a shell *without* being run. It is
// model-authored text, so it never reaches a shell as something to execute:
// it is only typed at the prompt, and the user presses Enter (or not).
export async function handleTypeCommand({ req, res, sessionKey }) {
  const { command } = await jsonBody(req);
  if (typeof command !== "string" || !command.trim()) {
    return send(res, 400, { error: "missing command" });
  }
  // A newline would be typed as a Return, running everything before it: the
  // one thing this endpoint promises never to do.
  if (/[\r\n\u2028\u2029]/.test(command)) {
    return send(res, 400, { error: "a command spanning multiple lines cannot be typed safely" });
  }
  if (command.length > 2000) return send(res, 400, { error: "command too long" });
  const ctx = await useContext(sessionKey);
  const typed = await typeInTerminal(ctx.cwd, command);
  if (!typed.ok) return send(res, 501, { error: "typing into a terminal is not available on this system" });
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
  // Concluding a chat concludes its consoles: the processes opened from it have
  // nothing left to run. They are switched off, not dropped — the rows stay in
  // the list and the panes reopen read-only, scrollback and all. The registry
  // announces the change on its own (a global `terminals` event per exit).
  if (status === "done") terminateTerminalsForChat(chatPath);
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

function skillPresentationText(text) {
  const skill = compactSkillBlock(text);
  return skill
    ? [`/skill:${skill.name}`, skill.arguments].filter(Boolean).join(" ")
    : text;
}

// One chat as the sidebar wants it. Written once because two routes answer
// with it (`/api/sessions` and `/api/search`): a field added to a list the
// page renders the same way must never exist in one of the two only.
async function sessionEntry(s) {
  // last model used in that chat, so the sidebar can show its logo
  // (scanSessionFile is mtime-cached: repeated calls are free)
  const scan = await scanSessionFile(s.path).catch(() => null);
  const last = scan?.lastModel ?? null;
  const firstMessage = skillPresentationText(s.firstMessage ?? "");
  return {
    path: s.path,
    id: s.id,
    cwd: s.cwd ?? "",
    name: s.name ?? "",
    firstMessage,
    // Summary of the first visible message when one has been generated, the
    // truncation of it otherwise: expanded skill instructions stay server-side.
    // The creation date travels with it because listing a chat older than the
    // title switch must not summarize it.
    title: await titleFor(s.path, firstMessage, s.created),
    messageCount: s.messageCount ?? 0,
    modified: s.modified,
    favorite: isFavorite(s.path),
    status: sessionStatusOf(s.path),
    provider: last?.provider ?? "",
    model: last?.model ?? "",
  };
}

const byNewestFirst = (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime();

// scope=all → sessions of every project, scope=cwd (default) → current dir only
function sessionsOfScope(scope, cwd) {
  return scope === "all" ? SessionManager.listAll() : SessionManager.list(cwd);
}

export async function handleListSessions({ res, url, sessionKey }) {
  const scope = url.searchParams.get("scope") ?? "cwd";
  const ctx = await useContext(sessionKey);
  const list = await sessionsOfScope(scope, ctx.cwd);
  return send(res, 200, {
    current: ctx.sessionFile ?? null,
    cwd: ctx.cwd,
    scope,
    running: runningContextKeys(),
    open: openContextKeys(),
    sessions: await Promise.all(list.sort(byNewestFirst).map(sessionEntry)),
  });
}

// ---- deep search: the words inside the messages -----------------------------
// The sidebar search only sees titles. This is the other half: the text of the
// chats themselves, read from the session files.
const SEARCH_MAX_RESULTS = 50;
// The other half of the budget: results are capped, but a query nobody matches
// would still read every chat on the disk. Newest first, so what is dropped is
// always the oldest. The "full search" switch in Settings lifts it.
const SEARCH_MAX_FILES = 300;

// The visible text of a message: what the user wrote and what the assistant
// answered. Thinking blocks and tool calls are deliberately out — nobody
// searches for a chat by the arguments of a grep it ran.
function messageText(message) {
  return skillPresentationText(messageContentText(message, " "));
}

// True when every word shows up somewhere in the chat, each one possibly in a
// different message. The file is read line by line (a chat can be megabytes)
// and abandoned as soon as the last word is found; a malformed line is skipped
// by readSessionRecords, an unreadable file is simply not a match.
async function chatContainsWords(file, words) {
  const missing = new Set(words);
  try {
    for await (const rec of readSessionRecords(file)) {
      if (rec?.type !== "message") continue;
      const role = rec.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageText(rec.message).toLowerCase();
      if (!text) continue;
      for (const word of missing) {
        if (text.includes(word)) missing.delete(word);
      }
      if (missing.size === 0) return true;
    }
  } catch {
    return false;
  }
  return missing.size === 0;
}

export async function handleSearchMessages({ req, res, url, sessionKey }) {
  const words = (url.searchParams.get("q") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Without words every chat matches: that is the whole list, not a search.
  if (words.length === 0) return sendError(res, 400, "missing_query", "q must not be empty");
  const scope = url.searchParams.get("scope") ?? "cwd";
  // The page aborts the search still scanning when it starts another one: from
  // that moment the answer has no reader, so reading more files is pure waste.
  // Listener registered before the first await, so a request already gone is
  // seen even if it dies while the context is being resolved.
  let dropped = false;
  req?.once?.("close", () => { dropped = true; });
  const gone = () => dropped || res.destroyed;
  const ctx = await useContext(sessionKey);
  const list = (await sessionsOfScope(scope, ctx.cwd)).sort(byNewestFirst);
  // Newest first and one file at a time: the cap then keeps the 50 most recent
  // matches, and a query that hits everything stops after 50 files instead of
  // reading every chat on the disk.
  const fileCap = isFullSearchEnabled() ? Infinity : SEARCH_MAX_FILES;
  const hits = [];
  let scanned = 0;
  // True only when chats were left unread: reaching the cap on the very last
  // file has hidden nothing.
  let capped = false;
  for (const s of list) {
    if (gone()) return;
    if (hits.length >= SEARCH_MAX_RESULTS) break;
    if (scanned >= fileCap) {
      capped = true;
      break;
    }
    scanned += 1;
    if (await chatContainsWords(s.path, words)) hits.push(s);
  }
  // Nothing is written on a dead response (see DECISIONS.md).
  if (gone()) return;
  return send(res, 200, {
    query: words.join(" "),
    scope,
    cwd: ctx.cwd,
    scanned,
    // `capped` tells the two apart: 50 matches found, or chats left unread.
    capped,
    truncated: hits.length >= SEARCH_MAX_RESULTS || capped,
    sessions: await Promise.all(hits.map(sessionEntry)),
  });
}

// Every route that puts the tab on a chat answers with the same payload: the
// context key the client sends back as `?s=`, its folder, and whether a run is
// already going on in there.
function sendContext(res, ctx) {
  return send(res, 200, { ok: true, key: ctx.key, cwd: ctx.cwd, running: contextIsBusy(ctx) });
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
  return send(res, 200, { files: filesForProject(ctx.cwd) });
}

export async function handleGetFileDiff({ res, url, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const p = url.searchParams.get("path");
  const sourceKey = url.searchParams.get("source");
  const f = p && sourceKey && diffForProjectFile(ctx.cwd, sourceKey, p);
  if (!f) return send(res, 404, { error: "file not tracked for this project and source chat" });
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

function messageContentText(message, separator = "") {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(separator);
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
  const msgs = chatMsgs.map((m, i) => {
    const rawText = messageContentText(m);
    const skill = m.role === "user" ? compactSkillBlock(rawText) : null;
    const blocks = skill
      ? [skill]
      : (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []))
        .map((c, contentIndex) => {
          if (c.type === "text") return c.text ? { type: "text", text: c.text } : null;
          if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
            return { type: "image", mimeType: c.mimeType, contentIndex };
          }
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
        .filter(Boolean);
    return {
      role: m.role,
      // Never mirror the expanded SKILL.md body in the legacy text field.
      text: skillPresentationText(rawText),
      // Full ordered content of ordinary turns; skill invocations are reduced
      // to one semantic block before crossing the server/browser boundary.
      blocks,
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
    };
  });
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

const SAFE_IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]*$/i;

// Keep large base64 payloads out of /api/history. A thumbnail fetch resolves a
// stable message/block reference against the active branch of this chat.
export async function handleGetAttachment({ res, url, sessionKey }) {
  const entryId = url.searchParams.get("entry") ?? "";
  const contentIndex = Number(url.searchParams.get("block"));
  if (!entryId || !Number.isInteger(contentIndex) || contentIndex < 0) {
    return send(res, 400, { error: "invalid attachment reference" });
  }
  const ctx = await useContext(sessionKey);
  let entry;
  try {
    entry = (ctx.session.sessionManager?.getBranch?.() ?? []).find((item) => item.id === entryId);
  } catch {
    return send(res, 404, { error: "attachment not found" });
  }
  const block = Array.isArray(entry?.message?.content) ? entry.message.content[contentIndex] : null;
  if (entry?.type !== "message" || block?.type !== "image"
      || typeof block.data !== "string" || !SAFE_IMAGE_MIME.test(block.mimeType ?? "")) {
    return send(res, 404, { error: "attachment not found" });
  }
  const bytes = Buffer.from(block.data, "base64");
  if (!bytes.length) return send(res, 404, { error: "attachment not found" });
  return sendBytes(res, 200, bytes, block.mimeType);
}

function sendPromptQueueError(res, error) {
  if (!(error instanceof PromptQueueError)) throw error;
  return sendError(res, error.status, error.code, error.message);
}

const contextIsBusy = (ctx) => ctx.promptStarting || ctx.running || ctx.session.isStreaming;

export async function handlePrompt({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session } = ctx;
  let input;
  try {
    input = normalizePromptInput(await jsonBody(req));
  } catch (error) {
    return sendPromptQueueError(res, error);
  }

  if (contextIsBusy(ctx)) {
    // AgentSession's public steer/followUp methods preserve skill and prompt
    // template expansion, but extension commands would execute immediately.
    // Identify those before this app accepts ownership of a cancellable item.
    const commands = await sessionCommands(ctx);
    if (contextIsBusy(ctx)) {
      const command = queuedExtensionCommand(input.text, commands);
      if (command) {
        return sendError(
          res,
          409,
          "extension_command_not_queueable",
          `extension command /${command.name} cannot be queued while the agent is running`,
        );
      }
      try {
        const queued = ctx.promptQueue.enqueue(input);
        return send(res, 202, { ok: true, key: ctx.key, queued });
      } catch (error) {
        return sendPromptQueueError(res, error);
      }
    }
  }

  // Claim the run before refreshing bootstrap resources: a concurrent send is
  // queued instead of racing a second reload/first prompt into this context.
  ctx.promptStarting = true;
  try {
    await prepareFirstPrompt(ctx);
  } catch (error) {
    ctx.promptStarting = false;
    throw error;
  }

  const images = input.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  const opts = images.length ? { images } : undefined;
  // writing in a done chat brings it back to life as "reopened"
  if (ctx.sessionFile && sessionStatusOf(ctx.sessionFile) === "done") {
    setSessionStatus(ctx.sessionFile, "reopened").then(() => broadcastGlobal({ kind: "sessions" }));
  }
  // Cover the pre-agent_start window too: another POST received while model,
  // auth and extension preflight run belongs to this run's cancellable queue.
  session
    .prompt(input.text, opts)
    .catch((err) => {
      ctx.promptQueue.clear("error");
      broadcast(ctx, { kind: "error", message: String(err) });
    })
    .finally(() => { ctx.promptStarting = false; });
  return send(res, 202, { ok: true, key: ctx.key });
}

export async function handleDeleteQueuedPrompt({ res, sessionKey, params }) {
  const ctx = await useContext(sessionKey);
  try {
    const removed = ctx.promptQueue.cancel(params.id);
    return send(res, 200, { ok: true, key: ctx.key, removed });
  } catch (error) {
    return sendPromptQueueError(res, error);
  }
}

export async function handleSubmitForm({ req, res, sessionKey, params }) {
  const ctx = await useContext(sessionKey);
  const body = await jsonBody(req);
  try {
    const submitted = ctx.formBroker.submit(params.id, body?.values);
    if (!submitted) {
      return sendError(res, 409, "form_not_pending", "this form is no longer waiting for a response");
    }
    return send(res, 200, { ok: true, key: ctx.key, values: submitted });
  } catch (error) {
    return sendError(res, 400, "invalid_form_response", String(error.message ?? error));
  }
}

export async function handleAbort({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  ctx.promptQueue.clear("aborted");
  await ctx.session.abort();
  return send(res, 200, { ok: true });
}
