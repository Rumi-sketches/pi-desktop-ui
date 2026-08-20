/**
 * contexts.mjs — one agent context per open chat, and everything that lives
 * with it: the SSE clients watching it, its usage counters, the files it
 * touched, the transcript of the turn in progress.
 *
 * A context is keyed by its session file (a chat with no file yet is keyed by
 * its folder), so two tabs on the same chat share one agent and stay in sync,
 * while tabs on different chats are fully independent — leaving a chat never
 * disposes it, and a run keeps going in the background.
 *
 * The map itself is private: callers reach a context through useContext() (the
 * key a tab sends) or createContext() (an explicit new/open/continue), and read
 * the rest through the small surface below.
 *
 * Four words, four different things — keep them apart:
 *   Chat        — the user-facing concept: a conversation, as seen in the UI.
 *   Session     — the SDK object plus its `.jsonl` file: the persistent
 *                 identity of a chat, and what survives a restart.
 *   Context     — the live runtime around a session (agent, SSE clients,
 *                 counters, transcript): ephemeral, dropped when idle.
 *   Session key — the opaque identifier the client sends back (`?s=`,
 *                 `x-pi-session`): a session file path, or `draft:<cwd>` for a
 *                 chat that has no file yet.
 */
import { execFile } from "node:child_process";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  resolveModelScopeWithDiagnostics,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { PRODUCT_ID } from "./product.mjs";
import { SSE_PING, SSE_PING_MS, sseSend, sseWrite } from "./http.mjs";
import { AGENT_DIR, isAgentDirPath, readSessionRecords, resolveFile } from "./session-store.mjs";

// ---- thinking levels -------------------------------------------------------
// Mirrors getSupportedThinkingLevels() from @earendil-works/pi-ai (not directly
// importable: it lives in a nested node_modules of the agent package).
const EXTENDED_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

// ---- SSE broadcast ---------------------------------------------------------
// Each browser tab attaches to exactly ONE agent context and only receives that
// context's events. A handful of events (running badges, session list) are
// global and go to every connected tab, tagged with `scope:"global"`.
// Every write goes through the SSE helpers of http.mjs: a client that vanished
// must never be written to (DECISIONS.md).
const allClients = new Set();
export function broadcast(ctx, event) {
  if (!ctx) return;
  for (const res of ctx.clients) sseSend(res, event);
}
export function broadcastGlobal(event) {
  const ev = { ...event, scope: "global" };
  for (const res of allClients) sseSend(res, ev);
}

// The counters of one chat, pushed to the tabs watching it. Sent from two
// places (the end of an assistant message and a model switch, which changes
// the context window), so the shape is defined once.
export function broadcastUsage(ctx) {
  broadcast(ctx, { kind: "usage", totals, chat: ctx.chat, chatByModel: ctx.chatByModel, context: ctx.context });
}

// A tab subscribing to a chat: it joins the context's own audience and the
// global one (running badges, session list), gets told what it attached to, and
// is kept alive by a ping — a chat can stay quiet for minutes, and without
// traffic a proxy, a NAT or an antivirus drops the connection while the tab
// silently stops updating. Returns the detach function to call on close.
export function attachEventClient(ctx, res) {
  allClients.add(res);
  ctx.clients.add(res);
  sseSend(res, { kind: "attached", key: ctx.key, cwd: ctx.cwd, running: ctx.running });
  const ping = setInterval(() => sseWrite(res, SSE_PING), SSE_PING_MS);
  ping.unref();
  return () => {
    clearInterval(ping);
    allClients.delete(res);
    ctx.clients.delete(res);
    ctx.lastActive = Date.now();
  };
}

// ---- pi sessions (multi-context) -------------------------------------------
// One context per open chat, keyed by its session file. Two tabs on the same
// chat share a context (and stay in sync, which is what you want); tabs on
// different chats are fully independent and keep running in the background.
// Created by startServer(): building it at import time would talk to the
// provider configuration just for loading this module.
let modelRuntime = null;
export const getModelRuntime = () => modelRuntime;
export async function startAgentRuntime() {
  modelRuntime = await ModelRuntime.create();
}

const DEFAULT_CWD = process.cwd();
const contexts = new Map();
// A draft chat — one with no session file yet — cannot be keyed by path: it is
// keyed by its folder instead, so that reloading a tab reuses the running agent
// rather than leaving one more context behind until CTX_IDLE_MS expires. The key
// travels to the client as an opaque string (`?s=`, `x-pi-session`), url-encoded
// there.
const draftKey = (cwd) => `draft:${cwd}`;

// A draft becomes a real chat on its first message: the SDK writes the session
// file and only then does the chat have an identity. Until we move the context
// from `draft:<cwd>` to that path it stays invisible to everything keyed by
// file — the sidebar's active row, the status store, a second tab opening the
// same chat — and the next "New chat" in the same folder would reuse this
// context, messages and all. Called on every message_end; a no-op once done.
// `draft:<cwd>` a tab may still be sending -> the context that draft became.
// It covers the round-trips already in flight when the chat got its file.
const adoptedDrafts = new Map();
function adoptSessionFile(ctx) {
  if (ctx.sessionFile) return;
  const file = ctx.session.sessionManager?.getSessionFile?.() ?? null;
  if (!file) return;
  // Another context already owns that file (rare: the same chat opened
  // elsewhere): leave the map alone rather than overwrite a live context.
  if (contexts.get(file) && contexts.get(file) !== ctx) return;
  const draft = ctx.key;
  contexts.delete(draft);
  ctx.sessionFile = file;
  ctx.key = file;
  contexts.set(file, ctx);
  adoptedDrafts.set(draft, file);
  // The tab is still sending `draft:<cwd>` as `?s=`: tell it its chat has a
  // name now. Its own SSE stream is untouched (same context object), so this
  // must not be an `attached` event — the client would reset the turn state.
  broadcast(ctx, { kind: "rekey", key: ctx.key, cwd: ctx.cwd });
}

// server-wide cumulative counters (all chats)
export const totals = { input: 0, output: 0, cost: 0, requests: 0 };

// Tokens attributable to *one chat only*: fresh tokens per turn (prompt tokens
// actually sent + cache writes + output). `cacheRead` is deliberately excluded:
// it is the same context re-counted on every turn, which is what made the old
// cumulative counter explode.
const emptyChatUsage = () => ({
  tokens: 0,
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  cost: 0,
  requests: 0,
});

function accumulateChatUsage(target, u) {
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  target.input += input;
  target.output += output;
  target.cacheWrite += cacheWrite;
  target.cacheRead += u.cacheRead ?? 0;
  target.tokens += input + cacheWrite + output;
  target.cost += u.cost?.total ?? 0;
  target.requests += 1;
}

function addChatUsage(ctx, u, modelKey = "?") {
  accumulateChatUsage(ctx.chat, u);
  // same counters, broken down by the model that produced the message:
  // switching LLM mid-chat stays visible in the top-right counter toggle
  accumulateChatUsage((ctx.chatByModel[modelKey] ??= emptyChatUsage()), u);
}

// "provider/model" of an assistant message, falling back to the session's
// current model when the record doesn't carry it
function messageModelKey(ctx, msg) {
  if (msg?.provider && msg?.model) return `${msg.provider}/${msg.model}`;
  const m = ctx.session?.model;
  return m ? `${m.provider}/${m.id}` : "?";
}

// Rebuild the chat counter from a persisted session file (resume / open).
async function replayChatUsage(ctx, file) {
  ctx.chat = emptyChatUsage();
  ctx.chatByModel = {};
  if (!file) return;
  try {
    for await (const rec of readSessionRecords(file)) {
      if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
      if (rec.message.usage) addChatUsage(ctx, rec.message.usage, messageModelKey(ctx, rec.message));
    }
  } catch {
    /* unreadable session file: counter simply starts at zero */
  }
}

// cwd recorded in the session file header (a chat may belong to another project)
async function sessionCwd(file) {
  try {
    for await (const rec of readSessionRecords(file)) {
      if (rec.type === "session") return rec.cwd ?? null;
      break; // the header is the first record: don't scan the whole file
    }
  } catch (err) {
    console.warn(`${PRODUCT_ID}: could not read the cwd of ${file}: ${err?.message ?? err}`);
  }
  return null;
}


function recordFileChange(ctx, toolName, args) {
  if (!args) return;
  const p = args.path ?? args.file_path;
  if (!p) return;
  if (isAgentDirPath(p)) return;
  const entry = ctx.files.get(p) ?? { path: p, writes: 0, hunks: [] };
  if (toolName === "write") {
    entry.writes += 1;
    entry.content = typeof args.content === "string" ? args.content : entry.content;
    entry.hunks = [];
  } else if (toolName === "edit") {
    const edits = Array.isArray(args.edits)
      ? args.edits
      : (typeof args.oldText === "string" ? [{ oldText: args.oldText, newText: args.newText }] : []);
    for (const e of edits) entry.hunks.push({ oldText: e.oldText ?? "", newText: e.newText ?? "" });
  } else {
    return;
  }
  ctx.files.set(p, entry);
  broadcast(ctx, { kind: "file", path: p, count: entry.writes + entry.hunks.length });
}

// ---- tool call presentation ------------------------------------------------
const MAX_TOOL_TEXT = 20000;
function clip(text, max = MAX_TOOL_TEXT) {
  if (typeof text !== "string") return text;
  return text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length} characters total]` : text;
}

// Drop huge/binary payloads (e.g. base64 images) before sending args to the UI.
export function sanitizeArgs(args) {
  if (args === null || args === undefined) return args;
  if (typeof args === "string") return clip(args, 4000);
  if (Array.isArray(args)) return args.slice(0, 40).map(sanitizeArgs);
  if (typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? clip(v, 4000) : sanitizeArgs(v);
  }
  return out;
}

// Pull readable text out of whatever shape a tool result has.
export function extractToolText(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return clip(result);
  if (Array.isArray(result)) return clip(result.map(extractToolText).filter(Boolean).join("\n"));
  if (typeof result === "object") {
    if (typeof result.output === "string") return clip(result.output);
    if (typeof result.text === "string") return clip(result.text);
    if (Array.isArray(result.content)) {
      return clip(
        result.content
          .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
          .filter(Boolean)
          .join("\n"),
      );
    }
    try {
      return clip(JSON.stringify(result, null, 2));
    } catch {
      return "";
    }
  }
  return String(result);
}

// One-line "what is the model doing" label shown next to the tool name.
export function summarizeTool(name, args) {
  if (!args || typeof args !== "object") return typeof args === "string" ? clip(args, 160) : "";
  const first = (...keys) => {
    for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
    return "";
  };
  switch (name) {
    case "bash":
      return clip(first("command", "cmd", "script"), 300);
    case "read":
    case "write":
    case "edit":
      return first("path", "file_path");
    case "grep":
    case "find":
      return [first("pattern", "query", "regex"), first("path", "dir")].filter(Boolean).join("  •  ");
    case "ls":
      return first("path", "dir");
    default: {
      const s = first("command", "path", "file_path", "pattern", "query", "url", "prompt");
      if (s) return clip(s, 300);
      try {
        return clip(JSON.stringify(args), 160);
      } catch {
        return "";
      }
    }
  }
}

// ---- live transcript buffer ------------------------------------------------
// Everything streamed since the last completed assistant message. It is what a
// tab replays when it (re)attaches to a chat that is already running, so you can
// leave a chat, come back, and still see the turn in progress.
const LIVE_MAX_CHARS = 200_000;
function liveText(ctx, type, delta) {
  const last = ctx.live.at(-1);
  if (last && last.type === type) {
    if (last.text.length < LIVE_MAX_CHARS) last.text += delta;
  } else {
    ctx.live.push({ type, text: delta });
  }
}

function wireSession(ctx) {
  ctx.session.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") {
        liveText(ctx, "text", ev.delta);
        broadcast(ctx, { kind: "text", delta: ev.delta });
      }
      if (ev.type === "thinking_delta") {
        liveText(ctx, "thinking", ev.delta);
        broadcast(ctx, { kind: "thinking", delta: ev.delta });
      }
    } else if (event.type === "tool_execution_start") {
      recordFileChange(ctx, event.toolName, event.args);
      const ev = {
        kind: "tool",
        id: event.toolCallId,
        name: event.toolName,
        status: "start",
        args: sanitizeArgs(event.args),
        summary: summarizeTool(event.toolName, event.args),
      };
      ctx.live.push({ type: "tool", tool: { ...ev } });
      broadcast(ctx, ev);
    } else if (event.type === "tool_execution_update") {
      const output = extractToolText(event.partialResult);
      const seg = ctx.live.find((s) => s.type === "tool" && s.tool.id === event.toolCallId);
      if (seg) seg.tool.output = output;
      broadcast(ctx, {
        kind: "tool",
        id: event.toolCallId,
        name: event.toolName,
        status: "update",
        output,
      });
    } else if (event.type === "tool_execution_end") {
      const output = extractToolText(event.result);
      const seg = ctx.live.find((s) => s.type === "tool" && s.tool.id === event.toolCallId);
      if (seg) Object.assign(seg.tool, { status: "end", isError: event.isError, output });
      broadcast(ctx, {
        kind: "tool",
        id: event.toolCallId,
        name: event.toolName,
        status: "end",
        isError: event.isError,
        output,
      });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      // the message is now persisted in the session file: /api/history will
      // return it, so drop the text/thinking we buffered for it (tool cards of
      // the *current* turn are kept: they run after the message ends)
      ctx.live = ctx.live.filter((s) => s.type === "tool" && s.tool.status !== "end");
      const u = event.message.usage;
      if (u) {
        totals.input += u.input ?? 0;
        totals.output += u.output ?? 0;
        totals.cost += u.cost?.total ?? 0;
        totals.requests += 1;
        addChatUsage(ctx, u, messageModelKey(ctx, event.message));
        ctx.context = {
          used: u.totalTokens ?? 0,
          window: ctx.session.model?.contextWindow ?? 0,
        };
        broadcastUsage(ctx);
      }
      // a failed/aborted turn is *not* an event of its own: the SDK closes the
      // assistant message with stopReason error|aborted + errorMessage and
      // session.prompt() still resolves, so without this the UI would show an
      // empty turn and the reason would only exist in the terminal log
      const stop = event.message.stopReason;
      if (stop === "error" || stop === "aborted") {
        const message = event.message.errorMessage ?? (stop === "aborted" ? "Response interrupted" : "Unknown provider error");
        broadcast(ctx, { kind: "error", message, aborted: stop === "aborted" });
      }
      // a brand-new chat only becomes a persisted file on its first message:
      // adopt that file as the context's identity, then let the sidebar (this
      // tab and any other) re-list to pick it up — this also keeps
      // name/preview/modified date fresh on every turn
      adoptSessionFile(ctx);
      broadcastGlobal({ kind: "sessions" });
    } else if (event.type === "agent_start") {
      ctx.running = true;
      ctx.live = [];
      // which model is answering this turn (it can change mid-chat): the UI
      // labels the assistant turn with it instead of a generic "pi"
      const m = ctx.session.model;
      ctx.turnModel = m ? { provider: m.provider, id: m.id, name: m.name ?? m.id } : null;
      broadcast(ctx, { kind: "status", status: "running", model: ctx.turnModel });
      broadcastGlobal({ kind: "running", key: ctx.key, running: true });
    } else if (event.type === "agent_end") {
      ctx.running = false;
      ctx.lastActive = Date.now();
      broadcast(ctx, { kind: "status", status: "idle" });
      broadcastGlobal({ kind: "running", key: ctx.key, running: false, cwd: ctx.cwd });
    } else if (event.type === "auto_retry_end" && !event.success && event.finalError) {
      // the SDK swallows the failure internally after giving up (e.g. an OAuth
      // refresh that keeps failing): if we don't surface it here, the turn just
      // ends with no answer and no explanation, and session.prompt() never
      // rejects, so the /api/prompt .catch below never fires either.
      broadcast(ctx, { kind: "error", message: event.finalError });
    } else if (event.type === "compaction_end" && event.errorMessage) {
      broadcast(ctx, { kind: "error", message: event.errorMessage });
    }
  });
}

// Slash commands available for this chat: extension commands (from the
// already-loaded extensionsResult), file-based prompt templates (from the
// session itself), and skills (discovered with a throwaway resource loader
// scoped to skills only — cheap and cached for a bit since skill files rarely
// change while a chat is open).
const COMMANDS_TTL_MS = 30_000;
export async function sessionCommands(ctx) {
  const now = Date.now();
  if (ctx.commandsCache && now - ctx.commandsCache.at < COMMANDS_TTL_MS) return ctx.commandsCache.data;
  const out = [];
  for (const ext of ctx.extensionsResult?.extensions ?? []) {
    for (const cmd of ext.commands?.values?.() ?? []) {
      out.push({
        name: cmd.name,
        description: cmd.description ?? "",
        source: "extension",
        location: cmd.sourceInfo?.scope ?? null,
        path: cmd.sourceInfo?.path ?? null,
      });
    }
  }
  for (const p of ctx.session.promptTemplates ?? []) {
    out.push({
      name: p.name,
      description: p.description ?? "",
      argumentHint: p.argumentHint ?? null,
      source: "prompt",
      location: p.sourceInfo?.scope ?? null,
      path: p.sourceInfo?.path ?? p.filePath ?? null,
    });
  }
  try {
    if (!ctx.skillLoader) {
      ctx.skillLoader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: AGENT_DIR,
        noExtensions: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
      });
      await ctx.skillLoader.reload();
    }
    const { skills } = ctx.skillLoader.getSkills();
    for (const s of skills) {
      out.push({
        name: `skill:${s.name}`,
        description: s.description ?? "",
        source: "skill",
        location: s.sourceInfo?.scope ?? null,
        path: s.sourceInfo?.path ?? s.filePath ?? null,
      });
    }
  } catch {
    /* skill discovery is best-effort: extensions/prompts still show up */
  }
  ctx.commandsCache = { at: now, data: out };
  return out;
}

// mode: 'continue' (resume most recent, default) | 'new' | 'open' (needs path)
export async function createContext({ cwd = DEFAULT_CWD, mode = "continue", openPath = null } = {}) {
  if (mode === "open" && openPath) {
    const known = contexts.get(openPath);
    if (known) {
      known.lastActive = Date.now();
      return known;
    }
  }
  let sessionManager;
  if (mode === "open" && openPath) {
    sessionManager = SessionManager.open(openPath, undefined, cwd);
  } else if (mode === "new") {
    sessionManager = SessionManager.create(cwd);
  } else {
    sessionManager = SessionManager.continueRecent(cwd);
  }
  const { session, extensionsResult } = await createAgentSession({ cwd, sessionManager, modelRuntime });
  const file = session.sessionManager?.getSessionFile?.() ?? null;
  // `continueRecent` may land on a chat that is already open elsewhere, and a
  // draft chat (no file at all) belongs to its folder: either way the context is
  // already running, so reuse it instead of starting a second agent on it.
  const key = file ?? draftKey(cwd);
  const known = contexts.get(key);
  if (known) {
    try {
      session.dispose();
    } catch (err) {
      console.warn(`${PRODUCT_ID}: disposing the duplicate session for ${key} failed: ${err?.message ?? err}`);
    }
    known.lastActive = Date.now();
    return known;
  }
  const ctx = {
    key,
    session,
    extensionsResult,
    cwd,
    sessionFile: file,
    chat: emptyChatUsage(),
    chatByModel: {},
    turnModel: null,
    context: { used: 0, window: session.model?.contextWindow ?? 0 },
    files: new Map(),
    clients: new Set(),
    live: [],
    running: false,
    lastActive: Date.now(),
    commandsCache: null, // { at, data } — slash commands for /api/commands
    skillLoader: null, // DefaultResourceLoader used only to discover skills
  };
  contexts.set(ctx.key, ctx);
  wireSession(ctx);
  await replayChatUsage(ctx, file);
  broadcastGlobal({ kind: "sessions" });
  return ctx;
}

// Resolve the context a request belongs to. `key` is the session file path sent
// by the tab (query `?s=` or header `x-pi-session`); unknown keys are loaded
// lazily (server restart, chat opened in another tab), missing ones fall back to
// the most recent chat of the default folder.
export async function useContext(key) {
  if (key) {
    const known = contexts.get(key) ?? contexts.get(adoptedDrafts.get(key));
    if (known) {
      known.lastActive = Date.now();
      return known;
    }
    try {
      const file = await resolveFile(key);
      return await createContext({
        cwd: (await sessionCwd(file)) ?? DEFAULT_CWD,
        mode: "open",
        openPath: file,
      });
    } catch {
      /* stale key: fall through */
    }
  }
  return await createContext({ cwd: DEFAULT_CWD, mode: "continue" });
}

function disposeContext(ctx) {
  try {
    ctx.session.dispose();
  } catch (err) {
    console.warn(`${PRODUCT_ID}: disposing the session of ${ctx.key} failed: ${err?.message ?? err}`);
  }
  contexts.delete(ctx.key);
  for (const [draft, key] of adoptedDrafts) if (key === ctx.key) adoptedDrafts.delete(draft);
}

// Idle contexts are dropped after a while, but only if nobody is watching them
// AND nothing is running: a background run is never killed.
const CTX_IDLE_MS = 30 * 60_000;
const CTX_SWEEP_MS = 60_000;
let idleSweepTimer = null;
export function startIdleSweep() {
  idleSweepTimer = setInterval(() => {
    for (const ctx of [...contexts.values()]) {
      if (ctx.clients.size === 0 && !ctx.running && Date.now() - ctx.lastActive > CTX_IDLE_MS) {
        disposeContext(ctx);
      }
    }
  }, CTX_SWEEP_MS);
  idleSweepTimer.unref();
}

// The context opened at boot, so the first request finds an agent already up.
let bootCtx = null;
export const getBootContext = () => bootCtx;
export async function openBootContext() {
  bootCtx = await createContext();
  return bootCtx;
}

// The folder a tab is working in: the chat it has open, or the folder the
// process was started in when it has none yet.
export const tabCwd = (sessionKey) => contexts.get(sessionKey)?.cwd ?? DEFAULT_CWD;
// Keys of the chats this server has open, and of those running right now: the
// sidebar marks both. The contexts themselves stay private.
export const openContextKeys = () => [...contexts.keys()];
export const runningContextKeys = () => [...contexts.values()].filter((c) => c.running).map((c) => c.key);
// The live sessions, for the settings that can be applied without a restart.
export const liveSessions = () => [...contexts.values()].map((c) => c.session);

// Everything this process owns on the agent side: the idle sweep, one child
// process per chat, and the SSE sockets watching them. Called on shutdown, and
// idempotent — a second call finds nothing left to release.
export async function disposeAllContexts() {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  bootCtx = null;
  // Snapshot: disposeContext() mutates `contexts` while we walk it.
  for (const ctx of [...contexts.values()]) {
    try {
      await ctx.session.abort();
    } catch (err) {
      console.error(`${PRODUCT_ID}: aborting session on shutdown failed (${err?.message ?? err})`);
    }
    disposeContext(ctx);
  }
  // close SSE clients so the server can actually stop
  for (const res of allClients) {
    try {
      res.end();
    } catch (err) {
      console.error(`${PRODUCT_ID}: closing an SSE client on shutdown failed (${err?.message ?? err})`);
    }
  }
  allClients.clear();
}

async function authMapForModels(models) {
  const providers = [...new Set(models.map((m) => m.provider))];
  const authMap = {};
  await Promise.all(
    providers.map(async (p) => {
      try {
        const status = await modelRuntime.checkAuth(p);
        authMap[p] = Boolean(status?.configured ?? status);
      } catch {
        authMap[p] = false;
      }
    }),
  );
  return authMap;
}

// Only models with valid auth (used when actually switching model / sending messages)
export async function availableModels() {
  const models = (await modelRuntime.getModels?.()) ?? [];
  const authMap = await authMapForModels(models);
  return models.filter((m) => authMap[m.provider]);
}

// Models to show in the picker/list UI: authenticated AND matching the user's
// `enabledModels` allow-list (settings.json), if one is configured. Mirrors the
// same whitelist used by pi's own model cycling / "scoped-models" command.
export async function pickerModels(session) {
  const patterns = session?.settingsManager?.getEnabledModels?.() ?? [];
  if (!patterns || patterns.length === 0) return availableModels();
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
  return scopedModels.map((sm) => sm.model);
}

// ---- git status (branch + pending changes) --------------------------------
// Read-only git commands in the chat's working directory. Cached briefly: the
// UI polls it on a timer and refreshes it after every agent run.
const gitCache = new Map(); // cwd -> { at, data }
function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    // windowsHide is mandatory here: this runs on a 20s poll (plus after every
    // agent run), and without it every single call pops a console window on
    // screen for a few milliseconds.
    execFile("git", args, { cwd, timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}
export async function gitStatus(cwd) {
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.data;
  let data;
  try {
    // porcelain v1 + branch: first line is "## branch...upstream [ahead N, behind M]"
    const status = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
    const lines = status.split("\n").filter(Boolean);
    const head = lines.shift() ?? "";
    const branch = head.includes("No commits yet on ")
      ? head.split("No commits yet on ")[1].trim()
      : head.replace(/^##\s+/, "").replace(/\.\.\..*$/, "").replace(/\s*\[.*$/, "") || "HEAD";
    let ahead = 0;
    let behind = 0;
    const ab = head.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
    if (ab) {
      ahead = Number(ab[1] ?? 0);
      behind = Number(ab[2] ?? ab[3] ?? 0);
    }
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const l of lines) {
      const x = l[0];
      const y = l[1];
      if (x === "?" && y === "?") {
        untracked++;
        continue;
      }
      if (x && x !== " ") staged++;
      if (y && y !== " ") unstaged++;
    }
    data = {
      repo: true,
      branch,
      ahead,
      behind,
      staged,
      unstaged,
      untracked,
      changed: staged + unstaged + untracked,
    };
  } catch {
    data = { repo: false }; // not a repo (or git missing): the chip hides
  }
  gitCache.set(cwd, { at: Date.now(), data });
  return data;
}
