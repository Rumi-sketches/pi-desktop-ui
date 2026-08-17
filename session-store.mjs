/**
 * session-store.mjs — everything this server persists under ~/.pi/agent.
 *
 * Two kinds of file live there and they are not the same thing:
 *   - pi's own `settings.json` / `models.json`, which we only ever read (plus
 *     the one setting the settings panel writes back), and
 *   - the `web-ui-*.json` stores this UI owns: favorites, chat status, chat
 *     archiving, recent folders.
 * The session log (`sessions/**.jsonl`) is read from here too: it is the same
 * directory, and both the analytics and the chat contexts stream it.
 *
 * The mutable state is deliberately *not* exported: callers go through the
 * functions below, so a store is never half-updated in memory and unsaved on
 * disk. `AGENT_DIR` is read from the environment at import time — importing
 * this module after setting `PI_WEB_UI_AGENT_DIR` *and* `PI_WEB_UI_TEST=1` is
 * what tests rely on.
 */
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat, readdir, chmod, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRODUCT_ID } from "./product.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- path helpers ----------------------------------------------------------
// Normalize + verify that a path exists and is a directory.
export async function resolveDir(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("missing path");
  }
  // These characters are legal in paths but get reinterpreted by a shell when
  // a terminal is opened in the directory: cmd.exe expands `%VAR%`, PowerShell
  // expands `$var` and treats the backtick as its escape character, and both
  // quote characters end an argument early. Refuse them outright.
  if (/["&|^$%'`\n\r]/.test(input)) {
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
export async function resolveFile(input) {
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
export function isInsideDir(filePath, root) {
  const prefix = root + path.sep;
  if (process.platform === "win32") {
    return filePath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return filePath.startsWith(prefix);
}

// AGENT_DIR holds auth.json, web-ui-network.json and the session log: a prompt
// that talks the agent into touching one of them must not turn it into a file
// the diff API will hand back in clear. Excluded at the tracker, so such a path
// never reaches ctx.files in the first place.
export function isAgentDirPath(filePath, agentDir = AGENT_DIR) {
  if (typeof filePath !== "string" || filePath.trim() === "") return false;
  return isInsideDir(path.resolve(filePath), agentDir);
}

// ---- secret redaction ------------------------------------------------------
// settings.json / models.json may hold API keys, tokens or custom headers.
// Before either file is echoed back by /api/config, every string value whose
// key name looks sensitive is replaced with a placeholder. Key names stay
// visible so the settings panel can still list what is configured.
const SENSITIVE_KEY_RE = /key|token|secret|password|cookie|authorization|bearer/i;
const REDACTED_PLACEHOLDER = "\u00abredacted\u00bb";

export function redactSecrets(value, keyName = "") {
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
// Only these two are ever written to disk. "active" is an accepted *input*
// meaning "forget this chat's status", so it deletes the entry instead.
const PERSISTED_SESSION_STATUSES = ["done", "reopened"];
export const SESSION_STATUS_INPUTS = [...PERSISTED_SESSION_STATUSES, "active"];

// Overridable so tests (and sandboxed runs) never touch the real ~/.pi/agent.
// Honoured *only* under PI_WEB_UI_TEST=1: this directory holds tokens and
// credentials, so whoever controls the environment of a production run must not
// be able to move them somewhere they can read. The test flag is deliberate —
// a "must live under os.homedir()" rule would reject the os.tmpdir() the suite
// uses.
export const AGENT_DIR =
  (process.env.PI_WEB_UI_TEST === "1" ? process.env.PI_WEB_UI_AGENT_DIR : undefined)
  ?? path.join(os.homedir(), ".pi", "agent");
export const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

// ---- JSON state stores -----------------------------------------------------
// The `web-ui-*` filename prefix is historical and must not be renamed: it is a
// contract with existing installations, which would silently lose their state.
// Same goes for the `ACCESS_COOKIE` name and the `PI_WEB_UI_AGENT_DIR` /
// `PI_WEB_UI_TEST` env vars.
// Every JSON file this server owns is read once at startup and rewritten whole
// on each change: `jsonFile` is the single implementation of that pattern.
// Writes land on "<file>.tmp" and are renamed into place, so a crash halfway
// through can never leave a truncated JSON behind, and saves of the same store
// are queued so two concurrent ones cannot fight over the temp file.
const JSON_INDENT = 1;

/**
 * @template T the shape this store holds, inferred from `fallback`/`revive`.
 * @param {string} file absolute path of the store.
 * @param {object} [opts]
 * @param {() => T} [opts.fallback] builds the value used when the file is
 *   missing or unreadable. A factory, so no store shares a mutable default.
 * @param {(raw: any) => T | undefined} [opts.revive] validates the parsed JSON;
 *   returning `undefined` (or throwing) falls back to `fallback()`.
 * @param {number} [opts.mode] permission bits for the file, for secrets.
 * @param {number} [opts.dirMode] permission bits used if the directory has to
 *   be created.
 * @returns {{ load: () => Promise<T>, save: (value: T) => Promise<void> }}
 */
export function jsonFile(file, { fallback = () => null, revive = (raw) => raw, mode, dirMode } = {}) {
  const tmpFile = `${file}.tmp`;
  let queue = Promise.resolve();

  async function writeAtomically(value) {
    try {
      await mkdir(path.dirname(file), dirMode ? { recursive: true, mode: dirMode } : { recursive: true });
      await writeFile(tmpFile, JSON.stringify(value, null, JSON_INDENT), mode ? { mode } : undefined);
      // `mode` on writeFile only applies when the file is created: tighten pre-existing ones.
      if (mode) await chmod(tmpFile, mode);
      await rename(tmpFile, file);
    } catch (err) {
      console.error(`${PRODUCT_ID}: saving ${path.basename(file)} failed (${err?.message ?? err})`);
      await rm(tmpFile, { force: true }).catch(() => {});
    }
  }

  return {
    async load() {
      try {
        const revived = revive(JSON.parse(await readFile(file, "utf8")));
        return revived === undefined ? fallback() : revived;
      } catch {
        return fallback(); // absent on first run, or unreadable
      }
    },
    save(value) {
      queue = queue.then(() => writeAtomically(value));
      return queue;
    },
  };
}

// settings.json / models.json belong to pi itself: we only ever read them.
export const agentJsonFile = (name) => jsonFile(path.join(AGENT_DIR, name));

// ---- favorite chats (pinned on top of the sidebar) -------------------------
// Stored server-side so they are the same in every tab/browser of this machine.
const FAVORITES_PATH = path.join(AGENT_DIR, "web-ui-favorites.json");
const favoritesStore = jsonFile(FAVORITES_PATH, {
  fallback: () => [],
  revive: (raw) => (Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : undefined),
});
let favorites = new Set();
async function loadFavorites() {
  favorites = new Set(await favoritesStore.load());
}
async function saveFavorites() {
  await favoritesStore.save([...favorites]);
}
export const listFavorites = () => [...favorites];
export const isFavorite = (chatPath) => favorites.has(chatPath);
// Pin/unpin one chat. Persisted before it returns: the caller answers a request
// with it, and a favorite that survives only in memory is a lost favorite.
export async function setFavorite(chatPath, favorite) {
  if (favorite) favorites.add(chatPath);
  else favorites.delete(chatPath);
  await saveFavorites();
}

// ---- session status: done / reopened ---------------------------------------
// A "done" chat sinks to the bottom of the sidebar and looks dimmed; writing in
// it again brings it back up as "reopened". Server-side state, like favorites.
// "reopened" does not collapse into "active": the sidebar sorts on it, so a
// revived chat ranks above the never-archived ones.
// Indexed by session file path, hence the name: a draft chat has no file and so
// has no status. The file itself is a persisted name and keeps its old one.
const STATUS_PATH = path.join(AGENT_DIR, "web-ui-status.json");
const sessionStatusStore = jsonFile(STATUS_PATH, {
  fallback: () => [],
  revive: (raw) =>
    raw && typeof raw === "object"
      ? Object.entries(raw).filter(([, v]) => PERSISTED_SESSION_STATUSES.includes(v))
      : undefined,
});
let sessionStatus = new Map(); // session file path -> "done" | "reopened"
async function loadSessionStatus() {
  sessionStatus = new Map(await sessionStatusStore.load());
}
async function saveSessionStatus() {
  await sessionStatusStore.save(Object.fromEntries(sessionStatus));
}
// A chat nobody ever marked is "active": that is the absence of an entry, not
// an entry of its own (see SESSION_STATUS_INPUTS).
export const sessionStatusOf = (chatPath) => sessionStatus.get(chatPath) ?? "active";
export async function setSessionStatus(chatPath, status) {
  if (status === "active") sessionStatus.delete(chatPath);
  else sessionStatus.set(chatPath, status);
  await saveSessionStatus();
}

// ---- chat archiving (opt-out feature, on by default) -----------------------
// Turning it off deletes nothing: the statuses stay in web-ui-status.json and
// show up again as soon as it is turned back on. `firstRunArchivedAt` exists
// because the initial sweep must happen once, not on every restart.
const ARCHIVING_PATH = path.join(AGENT_DIR, "web-ui-archiving.json");
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
const defaultArchiving = () => ({ enabled: true, firstRunArchivedAt: null });
const archivingStore = jsonFile(ARCHIVING_PATH, {
  fallback: defaultArchiving,
  revive: (raw) =>
    raw && typeof raw === "object"
      ? {
          enabled: raw.enabled !== false,
          firstRunArchivedAt: typeof raw.firstRunArchivedAt === "string" ? raw.firstRunArchivedAt : null,
        }
      : undefined,
});
let archiving = defaultArchiving();
async function loadArchiving() {
  archiving = await archivingStore.load();
}
async function saveArchiving() {
  await archivingStore.save(archiving);
}
// A copy, not the state itself: the archiving settings travel to the client as
// the body of /api/archiving, and a handler must not be able to mutate them.
export const archivingState = () => ({ ...archiving });
export const isArchivingEnabled = () => archiving.enabled;
export async function setArchivingEnabled(enabled) {
  archiving.enabled = enabled;
  await saveArchiving();
}

// Marks as done every chat idle for more than 24 hours. Age is measured on the
// session's last activity, not on its creation. Chats already done are left
// untouched.
export async function archiveStaleChats(now = Date.now()) {
  const sessions = await SessionManager.listAll();
  let archived = 0;
  for (const s of sessions) {
    if (!s?.path || sessionStatus.get(s.path) === "done") continue;
    const lastActivity = new Date(s.modified).getTime();
    if (!Number.isFinite(lastActivity) || now - lastActivity < ARCHIVE_AFTER_MS) continue;
    sessionStatus.set(s.path, "done");
    archived += 1;
  }
  if (archived) await saveSessionStatus();
  return archived;
}

// First-run sweep: the flag is written only after archiving succeeded, so a
// failure halfway through leaves the job retryable.
export async function runFirstRunArchiving() {
  if (!archiving.enabled || archiving.firstRunArchivedAt) return;
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
const recentCwdsStore = jsonFile(RECENT_CWDS_PATH, {
  fallback: () => [],
  revive: (raw) =>
    Array.isArray(raw) ? raw.filter((p) => typeof p === "string").slice(0, RECENT_CWDS_MAX) : undefined,
});
let recentCwds = [];
async function loadRecentCwds() {
  recentCwds = await recentCwdsStore.load();
}
async function saveRecentCwds() {
  await recentCwdsStore.save(recentCwds);
}
export async function rememberCwd(dir) {
  if (!dir) return;
  recentCwds = [dir, ...recentCwds.filter((p) => p !== dir)].slice(0, RECENT_CWDS_MAX);
  await saveRecentCwds();
}
export const recentCwdList = () => [...recentCwds];
export async function forgetCwd(dir) {
  recentCwds = recentCwds.filter((p) => p !== dir);
  await saveRecentCwds();
}

// Every store this module owns, read once at boot. The network store loads
// separately (see network.mjs): it is the only one whose content is a secret.
export async function loadPersistedState() {
  await Promise.all([loadFavorites(), loadSessionStatus(), loadArchiving(), loadRecentCwds()]);
}

// ---- pi settings (settings.json + the schema documenting it) ---------------
// The schema is parsed from the SDK docs, so types/defaults/descriptions stay
// in sync with the installed pi version instead of being copied here.
const SETTINGS_DOC = path.join(
  __dirname,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "docs",
  "settings.md",
);

let schemaCache = null;
export async function settingsSchema() {
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

export const getPath = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
export function setPath(obj, key, value) {
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
export async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// pi reads this file itself, so it is written the way pi writes it: two-space
// indent and a trailing newline, whole file at a time.
export async function saveSettingsFile(settings) {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

// ---- session log files -----------------------------------------------------
// One .jsonl per chat, appended to by pi itself. Read-only from here: the
// analytics aggregate them and a chat context replays its own file.
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");

// Yield one parsed JSON record per line, without loading the file in memory.
export async function* readSessionRecords(file) {
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

export async function listSessionFiles() {
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
