/**
 * pi-web-ui — minimal local web UI on top of the pi SDK.
 *
 * Multi-chat: the server keeps one agent *context* per open chat, keyed by its
 * session file. Every tab tells the server which chat it is on (query `?s=<key>`
 * or header `x-pi-session`); events are delivered only to the tabs attached to
 * that context. Leaving a chat never disposes it, so a run keeps going in the
 * background and you find the result when you come back.
 *
 * Endpoints (those marked [s] are scoped to the tab's chat):
 *   GET  /              → chat page
 *   GET  /api/state     → cwd, current model, usage totals, context info
 *   GET  /api/models    → models with valid auth only
 *   GET  /api/config    → pi settings, providers/auth, tools, paths (settings page)
 *   GET  /api/network   → LAN access state, detected LAN ip, one-shot access URL
 *   POST /api/network   → turn LAN access on/off, regenerate the access token
 *   GET  /api/settings  → documented pi settings schema + current values
 *   POST /api/settings  → { key, value } write one setting into ~/.pi/agent/settings.json
 *   POST /api/model     → { provider, id }  switch model
 *   POST /api/thinking  → { level }
 *   POST /api/cwd       → { path }  choose the folder of the not-yet-started chat
 *   POST /api/pick-folder → open native folder picker, returns { path }
 *   POST /api/open-explorer → reveal the chat's working folder in the system file manager
 *   POST /api/open-terminal → open a terminal in the chat's working folder and run `pi` there
 *   POST /api/favorites → { path, favorite }  pin/unpin a chat in the sidebar
 *   POST /api/status    → { path, status }    done / reopened / active
 *   GET  /api/archiving → chat archiving on/off + first-run sweep timestamp
 *   POST /api/archiving → { enabled } toggle, { archiveNow } sweep chats idle > 24h
 *   GET  /api/sessions  → list persisted sessions for current cwd
 *   POST /api/session   → { action:'new'|'open'|'continue'|'forkFrom', path?, entryId? }  switch/fork session
 *   GET  /api/history   → messages of the current session (each with an `entryId` for forking)
 *   GET  /api/commands  → slash commands available in this chat (extensions, prompt templates, skills)
 *   POST /api/prompt    → { text }  send a prompt (streams via SSE)
 *   POST /api/abort     → abort current run
 *   POST /api/shutdown  → stop the local server (graceful exit)
 *   POST /api/restart   → spawn a replacement process, then stop this one (port handoff via EADDRINUSE retry)
 *   GET  /api/events    → SSE stream of agent events
 *   GET  /api/analytics → cost/token history aggregated from ~/.pi/agent/sessions/**.jsonl
 *   GET  /api/usage     → real account usage limits scraped from claude.ai / kimi.com
 *   GET  /api/usage/config    → whether credentials are configured (no secrets)
 *   POST /api/usage/config    → { provider:'anthropic'|'kimi', ...fields } save credentials
 *   DELETE /api/usage/config  → { provider } remove credentials
 *   POST /api/usage/test      → { provider } live check of the stored credentials
 */
import http from "node:http";
import os from "node:os";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat, readdir, chmod } from "node:fs/promises";
import { openSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ACCESS_COOKIE, ACCESS_PARAM, classifyRequest, isLoopbackPeer } from "./access-control.mjs";
import { pickFolder, openFolder, openTerminal, platformCapabilities } from "./platform.mjs";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  resolveModelScopeWithDiagnostics,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  fetchAllUsage,
  usageConfigStatus,
  fetchAnthropicUsage,
  fetchKimiUsage,
  saveUsageConfig,
  clearUsageConfig,
} from "./usage-tracker.mjs";

const PORT = process.env.PORT ?? 3777;
// The address we bind to is decided further down, once the LAN access state is
// known: loopback only unless the user opted in (see HOST).
const HOST_OVERRIDE = process.env.HOST ?? null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- path helpers ----------------------------------------------------------
// Normalize + verify that a path exists and is a directory.
async function resolveDir(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("missing path");
  }
  // These characters are legal in paths but get reinterpreted by cmd.exe when
  // a terminal is opened in the directory: refuse them outright.
  if (/["&|^\n\r]/.test(input)) {
    throw new Error("path contains forbidden characters");
  }
  const resolved = path.resolve(input.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`directory not found: ${resolved}`);
  }
  if (!info.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}

// Normalize + verify that a path exists and is a file.
async function resolveFile(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("missing path");
  }
  const resolved = path.resolve(input.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`file not found: ${resolved}`);
  }
  if (!info.isFile()) throw new Error(`not a file: ${resolved}`);
  return resolved;
}

// True when filePath sits inside root (root + separator prevents a sibling
// like "sessions-evil" from matching). Windows paths compare case-insensitively.
function isInsideDir(filePath, root) {
  const prefix = root + path.sep;
  if (process.platform === "win32") {
    return filePath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return filePath.startsWith(prefix);
}


// ---- secret redaction ------------------------------------------------------
// settings.json / models.json may hold API keys, tokens or custom headers.
// Before either file is echoed back by /api/config, every string value whose
// key name looks sensitive is replaced with a placeholder. Key names stay
// visible so the settings panel can still list what is configured.
const SENSITIVE_KEY_RE = /key|token|secret|password|cookie|authorization|bearer/i;
const REDACTED_PLACEHOLDER = "\u00abredacted\u00bb";

function redactSecrets(value, keyName = "") {
  if (typeof value === "string") {
    return SENSITIVE_KEY_RE.test(keyName) ? REDACTED_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, keyName));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactSecrets(item, key);
    return out;
  }
  return value;
}

// ---- request validation ----------------------------------------------------
// Whitelists for the endpoints that drive the agent: anything outside them is a
// 400, never a silent no-op.
const CHAT_STATUSES = ["done", "reopened", "active"];
// `continue` is also the default when the client sends no action at all.
const SESSION_ACTIONS = ["continue", "new", "open", "forkFrom"];
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

// ---- thinking levels -------------------------------------------------------
// Mirrors getSupportedThinkingLevels() from @earendil-works/pi-ai (not directly
// importable: it lives in a nested node_modules of the agent package).
const EXTENDED_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

// ---- settings schema (parsed from the SDK docs, so types/defaults/descriptions
// stay in sync with the installed pi version) --------------------------------
// Overridable so tests (and sandboxed runs) never touch the real ~/.pi/agent.
const AGENT_DIR = process.env.PI_WEB_UI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

// ---- favorite chats (pinned on top of the sidebar) -------------------------
// Stored server-side so they are the same in every tab/browser of this machine.
const FAVORITES_PATH = path.join(AGENT_DIR, "web-ui-favorites.json");
let favorites = new Set();
try {
  const raw = JSON.parse(await readFile(FAVORITES_PATH, "utf8"));
  if (Array.isArray(raw)) favorites = new Set(raw.filter((p) => typeof p === "string"));
} catch {
  /* no favorites yet */
}
async function saveFavorites() {
  await mkdir(AGENT_DIR, { recursive: true }).catch(() => {});
  await writeFile(FAVORITES_PATH, JSON.stringify([...favorites], null, 1)).catch(() => {});
}

// ---- chat status: done / reopened ------------------------------------------
// A "done" chat sinks to the bottom of the sidebar and looks dimmed; writing in
// it again brings it back up as "reopened". Server-side state, like favorites.
const STATUS_PATH = path.join(AGENT_DIR, "web-ui-status.json");
let chatStatus = new Map(); // path -> "done" | "reopened"
try {
  const raw = JSON.parse(await readFile(STATUS_PATH, "utf8"));
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v === "done" || v === "reopened") chatStatus.set(k, v);
    }
  }
} catch {
  /* no statuses yet */
}
async function saveChatStatus() {
  await mkdir(AGENT_DIR, { recursive: true }).catch(() => {});
  await writeFile(STATUS_PATH, JSON.stringify(Object.fromEntries(chatStatus), null, 1)).catch(
    () => {},
  );
}

// ---- chat archiving (opt-out feature, on by default) -----------------------
// Turning it off deletes nothing: the statuses stay in web-ui-status.json and
// show up again as soon as it is turned back on. `firstRunArchivedAt` exists
// because the initial sweep must happen once, not on every restart.
const ARCHIVING_PATH = path.join(AGENT_DIR, "web-ui-archiving.json");
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
let archiving = { enabled: true, firstRunArchivedAt: null };
try {
  const raw = JSON.parse(await readFile(ARCHIVING_PATH, "utf8"));
  if (raw && typeof raw === "object") {
    archiving = {
      enabled: raw.enabled !== false,
      firstRunArchivedAt: typeof raw.firstRunArchivedAt === "string" ? raw.firstRunArchivedAt : null,
    };
  }
} catch {
  /* first install: defaults */
}
async function saveArchiving() {
  await mkdir(AGENT_DIR, { recursive: true }).catch(() => {});
  await writeFile(ARCHIVING_PATH, JSON.stringify(archiving, null, 1)).catch(() => {});
}

// Marks as done every chat idle for more than 24 hours. Age is measured on the
// session's last activity, not on its creation. Chats already done are left
// untouched.
async function archiveStaleChats(now = Date.now()) {
  const sessions = await SessionManager.listAll();
  let archived = 0;
  for (const s of sessions) {
    if (!s?.path || chatStatus.get(s.path) === "done") continue;
    const lastActivity = new Date(s.modified).getTime();
    if (!Number.isFinite(lastActivity) || now - lastActivity < ARCHIVE_AFTER_MS) continue;
    chatStatus.set(s.path, "done");
    archived += 1;
  }
  if (archived) await saveChatStatus();
  return archived;
}

// First-run sweep: the flag is written only after archiving succeeded, so a
// failure halfway through leaves the job retryable.
if (archiving.enabled && !archiving.firstRunArchivedAt) {
  try {
    await archiveStaleChats();
    archiving.firstRunArchivedAt = new Date().toISOString();
    await saveArchiving();
  } catch (e) {
    console.error("first-run chat archiving failed:", e?.message ?? e);
  }
}

// ---- recent working directories (quick picker in the cwd dropdown) ---------
// Most-recent-first, deduplicated, capped: the point is one click to go back to
// a folder you already used, not a full history.
const RECENT_CWDS_PATH = path.join(AGENT_DIR, "web-ui-recent-cwds.json");
const RECENT_CWDS_MAX = 12;
let recentCwds = [];
try {
  const raw = JSON.parse(await readFile(RECENT_CWDS_PATH, "utf8"));
  if (Array.isArray(raw)) recentCwds = raw.filter((p) => typeof p === "string").slice(0, RECENT_CWDS_MAX);
} catch {
  /* no recent folders yet */
}
async function saveRecentCwds() {
  await mkdir(AGENT_DIR, { recursive: true }).catch(() => {});
  await writeFile(RECENT_CWDS_PATH, JSON.stringify(recentCwds, null, 1)).catch(() => {});
}
async function rememberCwd(dir) {
  if (!dir) return;
  recentCwds = [dir, ...recentCwds.filter((p) => p !== dir)].slice(0, RECENT_CWDS_MAX);
  await saveRecentCwds();
}
// ---- LAN access (off by default) -------------------------------------------
// Exposing an agent that runs commands on the network is an explicit choice:
// the switch and the token that guards it live here. The token never reaches a
// log, nor stays in the query string after the handshake.
const NETWORK_PATH = path.join(AGENT_DIR, "web-ui-network.json");
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours
// The file holds the LAN access token: owner-only. No-op on Windows.
const AGENT_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
let network = { lanAccess: false, token: null };
try {
  const raw = JSON.parse(await readFile(NETWORK_PATH, "utf8"));
  if (raw && typeof raw === "object") {
    network = {
      lanAccess: raw.lanAccess === true,
      token: typeof raw.token === "string" && raw.token ? raw.token : null,
    };
  }
} catch {
  /* LAN access never enabled */
}
async function saveNetwork() {
  await mkdir(AGENT_DIR, { recursive: true, mode: AGENT_DIR_MODE }).catch(() => {});
  await writeFile(NETWORK_PATH, JSON.stringify(network, null, 1), { mode: SECRET_FILE_MODE }).catch(() => {});
  // `mode` on writeFile only applies when the file is created: tighten pre-existing ones.
  await chmod(NETWORK_PATH, SECRET_FILE_MODE).catch(() => {});
}
function newAccessToken() {
  return randomBytes(32).toString("base64url");
}
// First non-loopback IPv4 address: only used to build the URL shown in
// settings, never to decide who is allowed in.
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}
function networkStatus() {
  // Deliberately token-free: the URL that embeds the token is only handed out
  // by an explicit `reveal` POST, never by the default status response.
  return {
    lanAccess: network.lanAccess,
    ip: lanAddress(),
    port: Number(PORT),
    listening: HOST,
    restartRequired: network.lanAccess !== (HOST !== "127.0.0.1"),
  };
}
// The URL carries the token: it is the only way to get it to the other
// device, and it works once (then it becomes an HttpOnly cookie).
function accessUrl() {
  const ip = lanAddress();
  return network.lanAccess && ip && network.token
    ? `http://${ip}:${PORT}/?${ACCESS_PARAM}=${network.token}`
    : null;
}

// Loopback until LAN access is opened on purpose.
const HOST = HOST_OVERRIDE ?? (network.lanAccess ? "0.0.0.0" : "127.0.0.1");

// Binding beyond loopback without LAN access enabled would expose the agent
// with no token gate at all: refuse to start rather than start exposed.
if (!network.lanAccess && HOST !== "localhost" && !isLoopbackPeer(HOST)) {
  console.error(
    `pi-web-ui: refusing to listen on ${HOST} while LAN access is disabled. ` +
      "Enable LAN access from the settings panel, or unset HOST.",
  );
  process.exit(1);
}

const SETTINGS_DOC = path.join(
  __dirname,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "docs",
  "settings.md",
);

let schemaCache = null;
async function settingsSchema() {
  if (schemaCache) return schemaCache;
  let md = "";
  try {
    md = await readFile(SETTINGS_DOC, "utf8");
  } catch {
    return (schemaCache = []);
  }
  const sections = [];
  let section = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = { name: h[1], items: [] };
      sections.push(section);
      continue;
    }
    // | `key` | type | default | description |
    const row = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!row || !section) continue;
    const [, key, rawType, rawDefault, description] = row;
    if (key === "Setting") continue;
    const type = rawType.toLowerCase().trim();
    // enum values appear in the description as `"value"`
    const options = [...description.matchAll(/`"([^"`]+)"`/g)].map((m) => m[1]);
    section.items.push({
      key,
      type,
      default: rawDefault.replace(/`/g, "").trim(),
      description: description.replace(/`/g, ""),
      options: [...new Set(options)],
      editable: ["boolean", "number", "string"].includes(type),
    });
  }
  schemaCache = sections.filter((s) => s.items.length);
  return schemaCache;
}

const getPath = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  const last = parts.at(-1);
  if (value === null) {
    delete cur[last];
    // drop parent objects left empty by the removal
    for (let i = parts.length - 2; i >= 0; i--) {
      const parentKey = parts.slice(0, i + 1);
      const node = getPath(obj, parentKey.join("."));
      if (node && typeof node === "object" && !Array.isArray(node) && Object.keys(node).length === 0) {
        const owner = i === 0 ? obj : getPath(obj, parts.slice(0, i).join("."));
        delete owner[parts[i]];
      }
    }
  } else cur[last] = value;
}
async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// ---- session files: streaming reader + cost analytics ----------------------
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");

// Yield one parsed JSON record per line, without loading the file in memory.
async function* readSessionRecords(file) {
  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* skip malformed line */
      }
    }
  } finally {
    rl.close();
  }
}

// file path -> { mtimeMs, size, project, sessionId, file, buckets, lastModel, first, last }
// Only the *aggregated* buckets are kept: the per-message rows are consumed
// during the scan and thrown away, so memory no longer grows with the number
// of assistant messages. Insertion order doubles as recency: a hit re-inserts
// the entry at the end, and overflow evicts from the front (least recently used).
const ANALYTICS_CACHE_MAX = 500;
const analyticsCache = new Map();

function cacheGet(file) {
  const entry = analyticsCache.get(file);
  if (!entry) return null;
  analyticsCache.delete(file);
  analyticsCache.set(file, entry);
  return entry;
}

function cacheSet(file, entry) {
  analyticsCache.delete(file);
  analyticsCache.set(file, entry);
  while (analyticsCache.size > ANALYTICS_CACHE_MAX) {
    const lru = analyticsCache.keys().next().value;
    analyticsCache.delete(lru);
  }
}

async function listSessionFiles() {
  const out = [];
  let dirs;
  try {
    dirs = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(SESSIONS_DIR, d.name);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) out.push(path.join(dir, f));
    }
  }
  return out;
}

const emptyBucket = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  tokens: 0,
  cost: 0,
  requests: 0,
  sessions: 0,
});

// Aggregate one session file into day x model buckets. Each bucket counts the
// file as one session, exactly as the previous per-file `seen` set did.
async function scanSessionFile(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  const cached = cacheGet(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;

  let project = "";
  let sessionId = path.basename(file, ".jsonl");
  let model = "";
  let provider = "";
  let lastModel = null;
  let first = null;
  let last = null;
  const buckets = new Map();
  try {
    for await (const rec of readSessionRecords(file)) {
      if (rec.type === "session") {
        project = rec.cwd ?? project;
        sessionId = rec.id ?? sessionId;
        continue;
      }
      if (rec.type === "model_change") {
        model = rec.modelId ?? model;
        provider = rec.provider ?? provider;
        continue;
      }
      if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
      const u = rec.message.usage;
      if (!u) continue;

      const ts = rec.timestamp ?? null;
      const rowModel = rec.message.model ?? model ?? "?";
      const rowProvider = rec.message.provider ?? provider ?? "?";
      const input = u.input ?? 0;
      const output = u.output ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const day = (ts ?? "").slice(0, 10) || "?";
      const modelKey = `${rowProvider}/${rowModel}`;

      const key = `${day}\u0000${modelKey}`;
      let b = buckets.get(key);
      if (!b) {
        b = { day, model: modelKey, ...emptyBucket(), sessions: 1 };
        buckets.set(key, b);
      }
      b.input += input;
      b.output += output;
      b.cacheRead += u.cacheRead ?? 0;
      b.cacheWrite += cacheWrite;
      b.tokens += input + output + cacheWrite;
      b.cost += u.cost?.total ?? 0;
      b.requests += 1;

      lastModel = { provider: rowProvider, model: rowModel };
      if (ts) {
        if (!first || ts < first) first = ts;
        if (!last || ts > last) last = ts;
      }
    }
  } catch {
    return null;
  }
  const entry = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    project,
    sessionId,
    file,
    buckets: [...buckets.values()],
    lastModel,
    first,
    last,
  };
  cacheSet(file, entry);
  return entry;
}

// Pre-aggregate by day x model x project. The client applies filters on this
// (small) payload, so switching range/model never hits the disk again.
async function buildAnalytics() {
  const files = await listSessionFiles();
  const buckets = new Map();
  const models = new Set();
  const projects = new Set();
  let first = null;
  let last = null;

  for (const file of files) {
    const entry = await scanSessionFile(file);
    if (!entry || !entry.buckets.length) continue;
    projects.add(entry.project);
    for (const fb of entry.buckets) {
      const key = `${fb.day}\u0000${fb.model}\u0000${entry.project}`;
      let b = buckets.get(key);
      if (!b) {
        b = { day: fb.day, model: fb.model, project: entry.project, ...emptyBucket() };
        buckets.set(key, b);
      }
      b.input += fb.input;
      b.output += fb.output;
      b.cacheRead += fb.cacheRead;
      b.cacheWrite += fb.cacheWrite;
      b.tokens += fb.tokens;
      b.cost += fb.cost;
      b.requests += fb.requests;
      b.sessions += fb.sessions;
      models.add(b.model);
    }
    if (entry.first && (!first || entry.first < first)) first = entry.first;
    if (entry.last && (!last || entry.last > last)) last = entry.last;
  }

  return {
    generatedAt: new Date().toISOString(),
    files: files.length,
    first,
    last,
    models: [...models].sort(),
    projects: [...projects].filter(Boolean).sort(),
    buckets: [...buckets.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

// ---- SSE broadcast ---------------------------------------------------------
// Each browser tab attaches to exactly ONE agent context and only receives that
// context's events. A handful of events (running badges, session list) are
// global and go to every connected tab, tagged with `scope:"global"`.
const allClients = new Set();
// SSE comment line: ignored by EventSource, enough to keep the socket alive.
const SSE_PING = ": ping\n\n";
const SSE_PING_MS = 15_000;
function sseSend(res, event) {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* client vanished mid-write */
  }
}
function broadcast(ctx, event) {
  if (!ctx) return;
  for (const res of ctx.clients) sseSend(res, event);
}
function broadcastGlobal(event) {
  const ev = { ...event, scope: "global" };
  for (const res of allClients) sseSend(res, ev);
}

// ---- pi sessions (multi-context) -------------------------------------------
// One context per open chat, keyed by its session file. Two tabs on the same
// chat share a context (and stay in sync, which is what you want); tabs on
// different chats are fully independent and keep running in the background.
const modelRuntime = await ModelRuntime.create();

const DEFAULT_CWD = process.cwd();
const contexts = new Map();
let memCounter = 0;

// server-wide cumulative counters (all chats)
const totals = { input: 0, output: 0, cost: 0, requests: 0 };

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
    console.warn(`pi-web-ui: could not read the cwd of ${file}: ${err?.message ?? err}`);
  }
  return null;
}

function recordFileChange(ctx, toolName, args) {
  if (!args) return;
  const p = args.path ?? args.file_path;
  if (!p) return;
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
function sanitizeArgs(args) {
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
function extractToolText(result) {
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
function summarizeTool(name, args) {
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
        broadcast(ctx, { kind: "usage", totals, chat: ctx.chat, chatByModel: ctx.chatByModel, context: ctx.context });
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
      // a brand-new chat only becomes a persisted file on its first message: the
      // sidebar (this tab and any other) needs to re-list to pick it up, plus
      // this keeps name/preview/modified date fresh on every turn
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
async function sessionCommands(ctx) {
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
async function createContext({ cwd = DEFAULT_CWD, mode = "continue", openPath = null } = {}) {
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
  // `continueRecent` may land on a chat that is already open elsewhere: reuse it
  // instead of running two agents against the same file.
  if (file && contexts.has(file)) {
    try {
      session.dispose();
    } catch (err) {
      console.warn(`pi-web-ui: disposing the duplicate session for ${file} failed: ${err?.message ?? err}`);
    }
    const known = contexts.get(file);
    known.lastActive = Date.now();
    return known;
  }
  const ctx = {
    key: file ?? `mem:${++memCounter}`,
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
async function useContext(key) {
  if (key) {
    const known = contexts.get(key);
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
    console.warn(`pi-web-ui: disposing the session of ${ctx.key} failed: ${err?.message ?? err}`);
  }
  contexts.delete(ctx.key);
}

// Idle contexts are dropped after a while, but only if nobody is watching them
// AND nothing is running: a background run is never killed.
const CTX_IDLE_MS = 30 * 60_000;
setInterval(() => {
  for (const ctx of contexts.values()) {
    if (ctx.clients.size === 0 && !ctx.running && Date.now() - ctx.lastActive > CTX_IDLE_MS) {
      disposeContext(ctx);
    }
  }
}, 60_000).unref();

const bootCtx = await createContext();

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
async function availableModels() {
  const models = (await modelRuntime.getModels?.()) ?? [];
  const authMap = await authMapForModels(models);
  return models.filter((m) => authMap[m.provider]);
}

// Models to show in the picker/list UI: authenticated AND matching the user's
// `enabledModels` allow-list (settings.json), if one is configured. Mirrors the
// same whitelist used by pi's own model cycling / "scoped-models" command.
async function pickerModels(session) {
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
async function gitStatus(cwd) {
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

// ---- HTTP helpers ----------------------------------------------------------
// A single request must never be able to exhaust the heap of the process that
// hosts every chat: the body is capped. 32 MB covers the base64 images that
// /api/prompt legitimately carries.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

// Applied to every dynamic response: the payloads carry chat content, so they
// must never be sniffed as another type nor cached by an intermediary.
// Locks the HTML page down to same-origin resources. 'unsafe-inline' on
// script-src is required for as long as the UI lives inline in index.html.
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function send(res, code, data, type = "application/json; charset=utf-8") {
  // Defensive: a handler that already sent a response (e.g. /api/restart sends
  // 200 then does risky follow-up work) must never crash the whole process by
  // trying to write headers twice if that follow-up throws.
  if (res.headersSent) {
    console.error(`pi-web-ui: tried to send twice on the same response (code ${code}), ignored`);
    return;
  }
  res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

// ---- request guard ---------------------------------------------------------
// The guard logic lives in access-control.mjs (pure and unit-tested); only the
// token check stays here, because it needs `crypto` and the `network` state.

// Constant-time comparison that also tolerates different lengths.
function secretEquals(candidate, secret) {
  if (typeof candidate !== "string" || typeof secret !== "string" || !secret) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const hasAccessToken = (value) => secretEquals(value, network.token ?? "");

// Move the token out of the URL and into an HttpOnly cookie, so it never stays
// in the address bar, in history or in a Referer header.
function completeAccessHandshake(res, url) {
  const clean = new URL(url);
  clean.searchParams.delete(ACCESS_PARAM);
  res.writeHead(302, {
    Location: clean.pathname + clean.search,
    "Set-Cookie": `${ACCESS_COOKIE}=${network.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ACCESS_COOKIE_MAX_AGE}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

// ---- vendored browser libraries --------------------------------------------
// marked, highlight.js and DOMPurify are served from node_modules instead of a CDN, so the
// UI works offline and no third party sees the traffic of a page that drives an
// agent. Only the sub-trees listed here are reachable.
const VENDOR_PREFIX = "/vendor/";
const VENDOR_ROOT = path.join(__dirname, "node_modules");
const VENDOR_ALLOWED = ["marked/lib/", "highlight.js/es/", "highlight.js/styles/", "dompurify/dist/"];
const VENDOR_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function vendorFilePath(pathname) {
  const rel = decodeURIComponent(pathname.slice(VENDOR_PREFIX.length));
  if (!VENDOR_ALLOWED.some((prefix) => rel.startsWith(prefix))) return null;
  if (!Object.hasOwn(VENDOR_TYPES, path.extname(rel))) return null;
  const file = path.resolve(VENDOR_ROOT, rel);
  // Defence in depth: a crafted ".." must never escape node_modules.
  if (file !== VENDOR_ROOT && !file.startsWith(VENDOR_ROOT + path.sep)) return null;
  return file;
}

async function serveVendor(res, pathname) {
  const file = vendorFilePath(pathname);
  if (!file) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": VENDOR_TYPES[path.extname(file)],
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

// ---- server ----------------------------------------------------------------
// A denied remote peer is worth a log line (it may be a probe), but a port
// scan must not flood the terminal: at most one line per window, with a
// count of what was suppressed in between.
const REMOTE_DENY_LOG_MS = 5000;
let remoteDenyLogAt = 0;
let remoteDenySuppressed = 0;
function warnRemoteDeny(req) {
  const now = Date.now();
  if (now - remoteDenyLogAt < REMOTE_DENY_LOG_MS) {
    remoteDenySuppressed++;
    return;
  }
  const suppressed = remoteDenySuppressed ? ` (+${remoteDenySuppressed} more suppressed)` : "";
  remoteDenyLogAt = now;
  remoteDenySuppressed = 0;
  console.warn(
    `pi-web-ui: denied remote request from ${req.socket.remoteAddress} — ${req.method} ${req.url}${suppressed}`,
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const verdict = classifyRequest(
    {
      method: req.method,
      headers: req.headers,
      searchParams: url.searchParams,
      remoteAddress: req.socket.remoteAddress,
    },
    { port: PORT, lanAccess: network.lanAccess, matchesToken: hasAccessToken },
  );
  if (verdict === "handshake") return completeAccessHandshake(res, url);
  if (verdict !== "allow") {
    if (!isLoopbackPeer(req.socket.remoteAddress)) warnRemoteDeny(req);
    return send(res, 403, { error: "forbidden origin" });
  }
  // which chat this tab is talking about (null → most recent one)
  const sessionKey = url.searchParams.get("s") || req.headers["x-pi-session"] || null;
  try {
    if (url.pathname === "/") {
      const html = await readFile(path.join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": HTML_CSP,
        ...SECURITY_HEADERS,
      });
      return res.end(html);
    }

    if (url.pathname.startsWith(VENDOR_PREFIX)) return serveVendor(res, url.pathname);

    if (url.pathname === "/api/events") {
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
      allClients.add(res);
      ctx.clients.add(res);
      sseSend(res, { kind: "attached", key: ctx.key, cwd: ctx.cwd, running: ctx.running });
      // a chat can stay quiet for minutes: without traffic a proxy, a NAT or an
      // antivirus drops the connection and the tab silently stops updating
      const ping = setInterval(() => res.write(SSE_PING), SSE_PING_MS);
      ping.unref();
      req.on("close", () => {
        clearInterval(ping);
        allClients.delete(res);
        ctx.clients.delete(res);
        ctx.lastActive = Date.now();
      });
      return;
    }

    if (url.pathname === "/api/state") {
      const ctx = await useContext(sessionKey);
      const { session } = ctx;
      return send(res, 200, {
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
        chatArchiving: archiving.enabled,
      });
    }

    if (url.pathname === "/api/models") {
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

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const [schema, current] = await Promise.all([settingsSchema(), readSettingsFile()]);
      // real runtime choices beat the examples parsed from the docs
      const authed = await availableModels();
      const providerOptions = [...new Set(authed.map((m) => m.provider))].sort();
      const allModels = (await modelRuntime.getModels?.()) ?? [];
      const prov = getPath(current, "defaultProvider");
      const modelOptions = [
        ...new Set((prov ? allModels.filter((m) => m.provider === prov) : authed).map((m) => m.id)),
      ].sort();
      const runtimeOptions = {
        defaultProvider: providerOptions,
        defaultModel: modelOptions,
        theme: ["dark", "light"],
      };
      const sections = schema.map((s) => ({
        name: s.name,
        items: s.items.map((it) => {
          const value = getPath(current, it.key);
          const options = runtimeOptions[it.key]?.length ? runtimeOptions[it.key] : it.options;
          return {
            ...it,
            options,
            value: value === undefined ? null : value,
            set: value !== undefined,
          };
        }),
      }));
      // anything present in settings.json but not documented
      const known = new Set(schema.flatMap((s) => s.items.map((i) => i.key)));
      const extras = Object.keys(current).filter((k) => !known.has(k) && !known.has(k + ".enabled"));
      return send(res, 200, {
        path: SETTINGS_PATH,
        agentDir: AGENT_DIR,
        sections,
        raw: current,
        extras,
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      });
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const { key, value } = await jsonBody(req);
      if (typeof key !== "string" || !key) return send(res, 400, { error: "missing key" });
      const schema = await settingsSchema();
      const item = schema.flatMap((s) => s.items).find((i) => i.key === key);
      if (!item) return send(res, 400, { error: `unknown setting: ${key}` });
      let v = value;
      if (v === null || v === "") v = null;
      else if (item.type === "boolean") v = Boolean(v);
      else if (item.type === "number") {
        v = Number(v);
        if (!Number.isFinite(v)) return send(res, 400, { error: "invalid numeric value" });
      } else if (item.type === "string") {
        v = String(v);
      } else if (item.type.endsWith("[]")) {
        // list settings (e.g. `enabledModels`): keep them as clean string arrays.
        // An empty array is meaningful — for `enabledModels` it means "all models".
        if (!Array.isArray(v)) return send(res, 400, { error: `${key} expects an array` });
        v = v.map((entry) => String(entry).trim()).filter(Boolean);
      }
      const current = await readSettingsFile();
      setPath(current, key, v);
      await mkdir(AGENT_DIR, { recursive: true });
      await writeFile(SETTINGS_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");
      // apply live where the running sessions support it
      let applied = false;
      try {
        if (key === "defaultThinkingLevel" && v) {
          for (const ctx of contexts.values()) ctx.session.setThinkingLevel(v);
          applied = true;
        }
        // the model picker reads the allow-list from the live settings manager,
        // so pushing it there makes the change visible without a restart
        if (key === "enabledModels") {
          for (const ctx of contexts.values()) {
            ctx.session.settingsManager?.setEnabledModels?.(v ?? []);
          }
          applied = true;
        }
      } catch (err) {
        console.warn(`pi-web-ui: applying the setting "${key}" to the live sessions failed: ${err?.message ?? err}`);
      }
      return send(res, 200, {
        ok: true,
        key,
        value: v,
        // most settings are read by pi at startup, so the CLI/session must restart
        restart: !applied,
      });
    }

    if (url.pathname === "/api/config") {
      const ctx = await useContext(sessionKey);
      const { session, cwd } = ctx;
      const readJson = async (f) => {
        try {
          return JSON.parse(await readFile(path.join(AGENT_DIR, f), "utf8"));
        } catch {
          return null;
        }
      };
      const settings = await readJson("settings.json");
      const modelsJson = await readJson("models.json");
      const allModels = (await modelRuntime.getModels?.()) ?? [];
      const providerIds = [...new Set(allModels.map((m) => m.provider))];
      const providers = await Promise.all(
        providerIds.map(async (id) => {
          let configured = false;
          let detail = "";
          try {
            const status = await modelRuntime.checkAuth(id);
            configured = Boolean(status?.configured ?? status);
            detail = status?.method ?? status?.source ?? "";
          } catch (e) {
            detail = String(e?.message ?? e);
          }
          return {
            id,
            configured,
            detail,
            oauth: modelRuntime.isUsingOAuth?.(id) ?? false,
            models: allModels.filter((m) => m.provider === id).length,
          };
        }),
      );
      const sm = session.settingsManager;
      return send(res, 200, {
        platform: await platformCapabilities(),
        cwd,
        sessionFile: session.sessionManager?.getSessionFile?.() ?? null,
        sessionId: session.sessionManager?.getSessionId?.() ?? null,
        current: session.model
          ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
          : null,
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: supportedThinkingLevels(session.model),
        providers,
        models: allModels.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
          reasoning: Boolean(m.reasoning),
          contextWindow: m.contextWindow ?? 0,
          maxTokens: m.maxTokens ?? 0,
          input: m.cost?.input ?? null,
          output: m.cost?.output ?? null,
          thinkingLevels: supportedThinkingLevels(m),
          authed: providers.find((p) => p.id === m.provider)?.configured ?? false,
        })),
        tools: (session.getAllTools?.() ?? []).map((t) => ({
          name: t.name,
          description: (t.description ?? "").split("\n")[0].slice(0, 160),
          active: (session.getActiveToolNames?.() ?? []).includes(t.name),
        })),
        options: sm
          ? {
              defaultProvider: sm.getDefaultProvider?.() ?? null,
              defaultModel: sm.getDefaultModel?.() ?? null,
              defaultThinkingLevel: sm.getDefaultThinkingLevel?.() ?? null,
              enabledModels: sm.getEnabledModels?.() ?? [],
              theme: sm.getTheme?.() ?? null,
              steeringMode: sm.getSteeringMode?.() ?? null,
              followUpMode: sm.getFollowUpMode?.() ?? null,
              compactionEnabled: sm.getCompactionEnabled?.() ?? null,
              compactionReserveTokens: sm.getCompactionReserveTokens?.() ?? null,
              retryEnabled: sm.getRetryEnabled?.() ?? null,
              hideThinkingBlock: sm.getHideThinkingBlock?.() ?? null,
              sessionDir: sm.getSessionDir?.() ?? null,
              packages: sm.getPackages?.() ?? [],
              extensionPaths: sm.getExtensionPaths?.() ?? [],
              skillPaths: sm.getSkillPaths?.() ?? [],
            }
          : null,
        paths: {
          agentDir: AGENT_DIR,
          settings: path.join(AGENT_DIR, "settings.json"),
          models: path.join(AGENT_DIR, "models.json"),
          auth: path.join(AGENT_DIR, "auth.json"),
        },
        rawSettings: redactSecrets(settings),
        rawModels: redactSecrets(modelsJson),
        node: process.version,
      });
    }

    if (url.pathname === "/api/archiving" && req.method === "GET") {
      return send(res, 200, { ...archiving });
    }

    if (url.pathname === "/api/archiving" && req.method === "POST") {
      const { enabled, archiveNow } = await jsonBody(req);
      if (typeof enabled === "boolean") {
        archiving.enabled = enabled;
        await saveArchiving();
        broadcastGlobal({ kind: "sessions" });
        return send(res, 200, { ...archiving });
      }
      if (archiveNow === true) {
        const archived = await archiveStaleChats();
        broadcastGlobal({ kind: "sessions" });
        return send(res, 200, { ...archiving, archived });
      }
      return send(res, 400, { error: "nothing to change" });
    }

    if (url.pathname === "/api/network" && req.method === "GET") {
      return send(res, 200, networkStatus());
    }

    if (url.pathname === "/api/network" && req.method === "POST") {
      const { lanAccess, regenerate, reveal } = await jsonBody(req);
      if (reveal === true) {
        const url = accessUrl();
        if (!url) return send(res, 400, { error: "LAN access is off" });
        console.log("pi-web-ui: LAN access URL revealed from settings");
        return send(res, 200, { url });
      }
      if (typeof lanAccess === "boolean") {
        network.lanAccess = lanAccess;
        // Every activation starts from a fresh token: turning access off
        // invalidates the URLs already handed out.
        network.token = lanAccess ? newAccessToken() : null;
      } else if (regenerate === true) {
        if (!network.lanAccess) return send(res, 400, { error: "LAN access is off" });
        network.token = newAccessToken();
      } else {
        return send(res, 400, { error: "nothing to change" });
      }
      await saveNetwork();
      return send(res, 200, networkStatus());
    }

    if (url.pathname === "/api/usage") {
      const force = url.searchParams.get("force") === "1";
      return send(res, 200, await fetchAllUsage({ force }));
    }

    if (url.pathname === "/api/usage/config" && req.method === "GET") {
      return send(res, 200, await usageConfigStatus());
    }

    if (url.pathname === "/api/usage/config" && req.method === "POST") {
      const { provider, ...values } = await jsonBody(req);
      try {
        await saveUsageConfig(provider, values);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      return send(res, 200, { ok: true, status: await usageConfigStatus() });
    }

    if (url.pathname === "/api/usage/test" && req.method === "POST") {
      const { provider } = await jsonBody(req);
      if (!["anthropic", "kimi"].includes(provider)) return send(res, 400, { error: "unknown provider" });
      const data = provider === "anthropic"
        ? await fetchAnthropicUsage({ force: true })
        : await fetchKimiUsage({ force: true });
      // `reason`, not `error`: the client's api() helper treats `error` as a
      // transport failure and toasts it; here the failure is the answer.
      if (!data.configured) return send(res, 200, { ok: false, reason: "credentials not saved" });
      if (data.error) return send(res, 200, { ok: false, reason: data.error });
      return send(res, 200, { ok: true, data });
    }

    if (url.pathname === "/api/usage/config" && req.method === "DELETE") {
      const { provider } = await jsonBody(req);
      try {
        await clearUsageConfig(provider);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      return send(res, 200, { ok: true, status: await usageConfigStatus() });
    }

    if (url.pathname === "/api/model" && req.method === "POST") {
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
      broadcast(ctx, { kind: "usage", totals, chat: ctx.chat, chatByModel: ctx.chatByModel, context: ctx.context });
      return send(res, 200, {
        ok: true,
        current: { provider, id },
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: supportedThinkingLevels(session.model),
        context: ctx.context,
      });
    }

    if (url.pathname === "/api/thinking" && req.method === "POST") {
      const { session } = await useContext(sessionKey);
      const { level } = await jsonBody(req);
      const levels = supportedThinkingLevels(session.model);
      if (!levels.includes(level)) {
        return send(res, 400, { error: `invalid thinking level, expected one of: ${levels.join(", ")}` });
      }
      session.setThinkingLevel(level);
      return send(res, 200, { ok: true, thinkingLevel: session.thinkingLevel });
    }

    if (url.pathname === "/api/cwd" && req.method === "POST") {
      const { path: newPath } = await jsonBody(req);
      let dir;
      try {
        dir = await resolveDir(newPath);
      } catch (e) {
        return send(res, 400, { error: String(e.message ?? e) });
      }
      // The folder is picked BEFORE the chat starts: an empty chat is just the
      // home screen (nothing exists on disk until the first prompt), so this
      // only decides where the next chat will live. Once the chat has messages
      // the folder is part of it and cannot be moved — the UI hides the control,
      // this is the safety net.
      const cur = await useContext(sessionKey);
      if (cur.session.messages.length > 0) {
        return send(res, 400, {
          error:
            "This chat has already started: the folder cannot be changed. Open a new chat to work somewhere else.",
        });
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
    if (url.pathname === "/api/recent-cwds") {
      if (req.method === "DELETE") {
        const gone = url.searchParams.get("path") ?? "";
        recentCwds = recentCwds.filter((p) => p !== gone);
        await saveRecentCwds();
      }
      return send(res, 200, { recent: recentCwds });
    }

    if (url.pathname === "/api/open-explorer" && req.method === "POST") {
      const ctx = await useContext(sessionKey);
      const opened = await openFolder(ctx.cwd);
      if (!opened.ok) return send(res, 501, { error: "opening a folder is not available on this system" });
      return send(res, 200, { ok: true, cwd: ctx.cwd });
    }

    if (url.pathname === "/api/open-terminal" && req.method === "POST") {
      const ctx = await useContext(sessionKey);
      const opened = await openTerminal(ctx.cwd, "pi");
      if (!opened.ok) return send(res, 501, { error: "opening a terminal is not available on this system" });
      return send(res, 200, { ok: true, cwd: ctx.cwd });
    }

    if (url.pathname === "/api/favorites" && req.method === "POST") {
      const { path: favPath, favorite } = await jsonBody(req);
      if (!favPath || typeof favPath !== "string") {
        return send(res, 400, { error: "missing path" });
      }
      if (favorite) favorites.add(favPath);
      else favorites.delete(favPath);
      await saveFavorites();
      return send(res, 200, { ok: true, favorites: [...favorites] });
    }

    if (url.pathname === "/api/status" && req.method === "POST") {
      const { path: chatPath, status } = await jsonBody(req);
      if (!chatPath || typeof chatPath !== "string") {
        return send(res, 400, { error: "missing path" });
      }
      if (!CHAT_STATUSES.includes(status)) {
        return send(res, 400, { error: `invalid status, expected one of: ${CHAT_STATUSES.join(", ")}` });
      }
      if (status === "active") chatStatus.delete(chatPath); // "active": no state worth remembering
      else chatStatus.set(chatPath, status);
      await saveChatStatus();
      broadcastGlobal({ kind: "sessions" });
      return send(res, 200, { ok: true, status: chatStatus.get(chatPath) ?? "active" });
    }

    if (url.pathname === "/api/pick-folder" && req.method === "POST") {
      const current = contexts.get(sessionKey)?.cwd ?? DEFAULT_CWD;
      const picked = await pickFolder(current);
      if (!picked.ok) return send(res, 501, { error: "no native folder picker on this system" });
      if (!picked.path) return send(res, 200, { cancelled: true });
      let dir;
      try {
        dir = await resolveDir(picked.path);
      } catch (e) {
        return send(res, 400, { error: String(e.message ?? e) });
      }
      return send(res, 200, { path: dir });
    }

    if (url.pathname === "/api/git") {
      const ctx = await useContext(sessionKey);
      return send(res, 200, await gitStatus(ctx.cwd));
    }

    if (url.pathname === "/api/analytics") {
      const data = await buildAnalytics();
      return send(res, 200, data);
    }

    if (url.pathname === "/api/sessions") {
      // scope=all → sessions of every project, scope=cwd (default) → current dir only
      const scope = url.searchParams.get("scope") ?? "cwd";
      const ctx = await useContext(sessionKey);
      const list =
        scope === "all" ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd);
      const running = [...contexts.values()].filter((c) => c.running).map((c) => c.key);
      const open = [...contexts.keys()];
      return send(res, 200, {
        current: ctx.sessionFile ?? null,
        cwd: ctx.cwd,
        scope,
        running,
        open,
        sessions: await Promise.all(
          list
            .sort((a, b) => new Date(b.modified) - new Date(a.modified))
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
                favorite: favorites.has(s.path),
                status: chatStatus.get(s.path) ?? "active",
                provider: last?.provider ?? "",
                model: last?.model ?? "",
              };
            }),
        ),
      });
    }

    if (url.pathname === "/api/session" && req.method === "POST") {
      const { action = "continue", path: openPath, cwd: wantedCwd, entryId } = await jsonBody(req);
      if (!SESSION_ACTIONS.includes(action)) {
        return send(res, 400, { error: `invalid action, expected one of: ${SESSION_ACTIONS.join(", ")}` });
      }
      // "Fork from here": extract the path from root to a given message entry
      // into a brand new session file, then open that file like any other saved
      // chat. Native SessionManager API (same one behind pi's own /fork).
      if (action === "forkFrom") {
        const cur = await useContext(sessionKey);
        if (!entryId || typeof entryId !== "string") {
          return send(res, 400, { error: "missing entryId" });
        }
        let newFile;
        try {
          newFile = cur.session.sessionManager?.createBranchedSession?.(entryId);
        } catch (e) {
          return send(res, 400, { error: String(e.message ?? e) });
        }
        if (!newFile) return send(res, 400, { error: "cannot fork: session not persisted" });
        const ctx = await createContext({ cwd: cur.cwd, mode: "open", openPath: newFile });
        return send(res, 200, { ok: true, key: ctx.key, cwd: ctx.cwd, running: ctx.running });
      }
      let safePath = null;
      // a new chat inherits the folder of the tab's current chat
      let targetCwd = contexts.get(sessionKey)?.cwd ?? DEFAULT_CWD;
      if (action === "open") {
        try {
          safePath = await resolveFile(openPath);
          // only files under the sessions directory may be parsed as sessions
          if (!isInsideDir(safePath, SESSIONS_DIR)) {
            return send(res, 400, { error: "path is outside the sessions directory" });
          }
          // a session may belong to another project: follow its working directory
          if (wantedCwd) targetCwd = await resolveDir(wantedCwd);
        } catch (e) {
          return send(res, 400, { error: String(e.message ?? e) });
        }
      }
      const ctx = await createContext({
        cwd: targetCwd,
        mode: action,
        openPath: safePath,
      });
      return send(res, 200, { ok: true, key: ctx.key, cwd: ctx.cwd, running: ctx.running });
    }

    if (url.pathname === "/api/commands") {
      const ctx = await useContext(sessionKey);
      return send(res, 200, { commands: await sessionCommands(ctx) });
    }

    if (url.pathname === "/api/files") {
      const ctx = await useContext(sessionKey);
      return send(res, 200, {
        files: [...ctx.files.values()].map((f) => ({
          path: f.path,
          changes: f.writes + f.hunks.length,
        })),
      });
    }

    if (url.pathname === "/api/files/diff") {
      const ctx = await useContext(sessionKey);
      const p = url.searchParams.get("path");
      const f = p && ctx.files.get(p);
      if (!f) return send(res, 404, { error: "file not tracked" });
      return send(res, 200, {
        path: f.path,
        write: f.writes > 0 ? { content: f.content ?? "" } : null,
        hunks: f.hunks,
      });
    }

    if (url.pathname === "/api/history") {
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

    if (url.pathname === "/api/prompt" && req.method === "POST") {
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
      if (ctx.sessionFile && chatStatus.get(ctx.sessionFile) === "done") {
        chatStatus.set(ctx.sessionFile, "reopened");
        saveChatStatus().then(() => broadcastGlobal({ kind: "sessions" }));
      }
      session
        .prompt(text ?? "", opts)
        .catch((err) => broadcast(ctx, { kind: "error", message: String(err) }));
      return send(res, 202, { ok: true, key: ctx.key });
    }

    if (url.pathname === "/api/abort" && req.method === "POST") {
      const ctx = await useContext(sessionKey);
      await ctx.session.abort();
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      send(res, 200, { ok: true, stopping: true });
      return shutdown("api");
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      send(res, 200, { ok: true, restarting: true });
      // Spawn the replacement directly (node + this same file, no shell string to
      // quote/chain through cmd.exe: that turned out unreliable to detach
      // properly). It races this process for the port and loses at first — the
      // EADDRINUSE retry loop around server.listen() below is what actually makes
      // the handoff work, not timing.
      // The response above is already sent: nothing from here on may throw
      // uncaught, or the whole process goes down without a replacement running
      // (that's exactly what happened when the log file — held open by cmd.exe's
      // own `>` redirection when launched from run.vbs — couldn't be reopened
      // here and the resulting error had nowhere safe to go).
      try {
        let stdio = "ignore";
        try {
          const logFd = openSync(path.join(__dirname, "server.log"), "a");
          stdio = ["ignore", logFd, logFd];
        } catch (e) {
          console.error(`pi-web-ui: could not open server.log for the restarted process (${e.message}); its output will be discarded`);
        }
        const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
          cwd: __dirname,
          detached: true,
          stdio,
          windowsHide: true,
          env: process.env,
        });
        child.unref();
      } catch (e) {
        console.error(`pi-web-ui: failed to spawn the replacement process (${e.message}); shutting down anyway — restart it manually`);
      }
      return shutdown("restart");
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    // Full error (stack, absolute paths, username) goes to the console only.
    console.error("pi-web-ui: request error:", err);
    const status = err?.status ?? 500;
    // Internal messages leak local paths and the username: never echo them back.
    const payload = status < 500 ? { error: String(err?.message ?? err) } : { error: "internal error" };
    if (!res.headersSent) send(res, status, payload);
  }
});

// ---- graceful shutdown -----------------------------------------------------
// how long to wait for a clean close before killing the process anyway
const FORCED_EXIT_MS = 1500;
let stopping = false;
async function shutdown(reason = "signal") {
  if (stopping) return;
  stopping = true;
  console.log(`pi-web-ui: shutting down (${reason})…`);
  for (const ctx of contexts.values()) {
    try {
      await ctx.session.abort();
    } catch {}
  }
  // close SSE clients so the server can actually stop
  for (const res of allClients) {
    try {
      res.end();
    } catch {}
  }
  allClients.clear();
  server.close(() => process.exit(0));
  // hard exit if something keeps the loop alive
  setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => shutdown(sig));
}

// Safety net: this process holds every open chat (each one a background agent
// run that keeps going while you're on another tab). One unhandled exception
// anywhere — Node's default behavior — used to take the whole thing down,
// killing every chat at once for a bug in a single request. Log and keep going
// instead; individual request handlers already guard their own res writes.
process.on("uncaughtException", (err) => {
  console.error(`pi-web-ui: uncaught exception (server stays up): ${err?.stack ?? err}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`pi-web-ui: unhandled rejection (server stays up): ${err?.stack ?? err}`);
});

// On /api/restart the replacement process is spawned before the old one has
// released the port: retry EADDRINUSE for a few seconds instead of racing it
// with a delay guess (which is exactly what made the previous cmd/ping-based
// approach flaky).
const LISTEN_RETRY_MAX = 20;
const LISTEN_RETRY_MS = 300;
let listenAttempts = 0;
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE" || listenAttempts >= LISTEN_RETRY_MAX) {
    console.error(`pi-web-ui: listen failed (${err.code ?? err.message})`);
    process.exit(1);
  }
  listenAttempts++;
  setTimeout(() => server.listen(PORT, HOST), LISTEN_RETRY_MS);
});
server.listen(PORT, HOST, () => {
  const bootModel = bootCtx.session.model;
  console.log(`pi-web-ui ready → http://${HOST}:${PORT}`);
  console.log(`cwd: ${bootCtx.cwd}`);
  console.log(`model: ${bootModel ? `${bootModel.provider}/${bootModel.id}` : "none configured"}`);
});
