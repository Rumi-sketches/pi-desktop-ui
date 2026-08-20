/**
 * titles.mjs — the one-line summary the sidebar shows for a chat.
 *
 * A chat has no title of its own: pi stores the first user message, and the
 * sidebar used to show a cut of it. Here that cut becomes the *fallback*: when
 * a token is available, the first message is summarized once by a small model
 * and the answer is kept forever in `web-ui-titles.json`, keyed by session file
 * path.
 *
 * Four rules shape everything below:
 *   - nothing happens unless the user asked for it. The feature is behind the
 *     `title-generation` switch (off by default) and, even on, it only covers
 *     chats created after it was switched on: the chats that already existed
 *     are summarized on an explicit click, through `queueMissingTitles`.
 *   - `/api/sessions` never waits for the model. `titleFor` answers from the
 *     cache and queues the work; the generated title shows up at the next
 *     refresh of the list.
 *   - one request at a time, one request per chat, ever. A chat already in the
 *     cache is never summarized again.
 *   - a failure is not an error the user should see: no token, no network, a
 *     rejected request, all end up as the same truncation the sidebar had
 *     before this module existed — and it is not chased forever either: three
 *     attempts per chat, ten minutes apart, then the row keeps its fallback
 *     until the process restarts.
 *
 * Auth is pi's own OAuth credential (`auth.json`, provider `anthropic`), read
 * fresh at each request so a refreshed token is picked up without a restart —
 * and never logged. No API key is read or asked for: without a subscription
 * token this module simply does nothing.
 */
import path from "node:path";
import { AGENT_DIR, agentJsonFile, jsonFile, titleGenerationEnabledAt } from "./session-store.mjs";

const API_URL = "https://api.anthropic.com/v1/messages";
// Small and cheap: this is a seven-word summary, not a conversation.
const TITLE_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 32;
// Enough of the first message to know what the chat is about. The rest is
// usually a pasted stack trace or file, and it would be paid for on every chat.
const MAX_INPUT_CHARS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TITLE_WORDS = 7;
const MAX_TITLE_CHARS = 100;
// The sidebar row is one line: past this the text is ellipsized anyway.
const FALLBACK_CHARS = 100;
// A backlog cap, not a rate limit: a first run over hundreds of chats queues
// what it can and picks up the rest at the next refresh.
const QUEUE_MAX = 100;
// A chat that fails to be summarized used to be retried at every refresh of the
// list, forever: an outage turned into a request per chat per refresh, all
// billed to the user's subscription. Three attempts, ten minutes apart, is the
// budget a failing chat gets.
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60 * 1000;

// Identity headers of pi's own Anthropic calls (see pi-ai's anthropic-messages):
// an OAuth token is only accepted with them and with the Claude Code system
// block below.
const OAUTH_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
};
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const INSTRUCTION =
  "Summarize the request below in a title of at most seven words, in the same language as the text."
  + " Answer with the title alone: no quotes, no trailing period, no explanation.";

// ---- fallback --------------------------------------------------------------
// What the sidebar showed before this module existed, and what it keeps showing
// whenever a title is missing: the first line of the first message, cut short.
export function fallbackTitle(firstMessage) {
  const text = String(firstMessage ?? "").replace(/\s+/g, " ").trim();
  return text.length > FALLBACK_CHARS ? `${text.slice(0, FALLBACK_CHARS).trimEnd()}…` : text;
}

// ---- cache -----------------------------------------------------------------
// Session file path -> title. `web-ui-titles.json` joins the other `web-ui-*`
// stores: same atomic write, same "read once, rewrite whole" pattern.
const titlesStore = jsonFile(path.join(AGENT_DIR, "web-ui-titles.json"), {
  fallback: () => /** @type {Record<string, string>} */ ({}),
  revive: (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const kept = /** @type {Record<string, string>} */ ({});
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.trim() !== "") kept[key] = value;
    }
    return kept;
  },
});
/** @type {Map<string, string>} */
let titles = new Map();
/** @type {Promise<Map<string, string>> | null} */
let titlesReady = null;

// Loaded on first use and memoized: this module has no boot hook of its own,
// and the first caller is a list request that can afford one file read.
function loadTitles() {
  titlesReady ??= titlesStore.load().then((stored) => {
    titles = new Map(Object.entries(stored));
    return titles;
  });
  return titlesReady;
}

async function rememberTitle(sessionPath, title) {
  (await loadTitles()).set(sessionPath, title);
  await titlesStore.save(Object.fromEntries(titles));
}

// ---- auth ------------------------------------------------------------------
/**
 * pi's stored subscription token, or null when there is none to use. Read from
 * disk at every call: pi refreshes it in place, and a cached copy would go
 * stale exactly when it matters.
 *
 * @returns {Promise<string | null>}
 */
async function oauthAccessToken() {
  const auth = await agentJsonFile("auth.json").load();
  const credential = auth?.anthropic;
  if (!credential || credential.type !== "oauth") return null;
  const { access, expires } = credential;
  if (typeof access !== "string" || access === "") return null;
  // `expires` is a timestamp in ms, already shifted back by pi's own margin.
  if (typeof expires === "number" && expires <= Date.now()) return null;
  return access;
}

// ---- generation ------------------------------------------------------------
// The model answers with a line of prose, and prose is not a title: quotes,
// trailing punctuation and a stray second sentence all have to go before the
// text is cached forever.
function cleanTitle(raw) {
  const line = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'«»]+|["'«».]+$/g, "").trim();
  if (!line) return null;
  const clipped = line.split(" ").slice(0, MAX_TITLE_WORDS).join(" ");
  return clipped.slice(0, MAX_TITLE_CHARS).trim() || null;
}

/**
 * One summarization request. Returns null on anything unexpected — a non-2xx
 * answer, a body in an unknown shape, a timeout — so the caller can fall back
 * without telling the two cases apart.
 *
 * @param {string} text the chat's first message.
 * @param {string} token OAuth access token; never logged.
 * @returns {Promise<string | null>}
 */
export async function requestTitle(text, token) {
  const input = String(text ?? "").slice(0, MAX_INPUT_CHARS).trim();
  if (!input || !token) return null;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { ...OAUTH_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: TITLE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The identity block is what makes an OAuth token acceptable, and it must
      // come first; the instruction is a second block, like pi does.
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        { type: "text", text: INSTRUCTION },
      ],
      messages: [{ role: "user", content: input }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const parts = Array.isArray(body?.content) ? body.content : [];
  const answer = parts.filter((p) => p?.type === "text").map((p) => p.text).join(" ");
  return cleanTitle(answer);
}

// ---- queue -----------------------------------------------------------------
// One worker, one request in flight. `queued` is what keeps a chat listed twice
// in a row from being summarized twice.
/** @type {{ path: string, text: string }[]} */
const queue = [];
const queued = new Set();
/** @type {Promise<void> | null} */
let worker = null;
// How many times each path was already sent, and when the last one left. In
// memory on purpose: a negative cache on disk would outlive the outage that
// created it, and a restart is the cheapest way to ask for another try.
/** @type {Map<string, { count: number, at: number }>} */
const attempts = new Map();

/**
 * Whether this path may be sent again now: it has attempts left and the last
 * one is old enough. Applies to the explicit backfill too — the click is
 * consent to spend requests, not permission to hammer a failing endpoint.
 */
function mayAttempt(sessionPath, now) {
  const tried = attempts.get(sessionPath);
  if (!tried) return true;
  return tried.count < MAX_ATTEMPTS && now - tried.at >= RETRY_AFTER_MS;
}

/** An attempt that never reached the network does not count as one. */
function forgetAttempt(sessionPath) {
  attempts.delete(sessionPath);
}

/**
 * @param {string} sessionPath
 * @param {string} text
 * @param {number} [now]
 * @returns {boolean} whether the chat was actually queued.
 */
function enqueue(sessionPath, text, now = Date.now()) {
  if (queued.has(sessionPath) || queue.length >= QUEUE_MAX) return false;
  if (!mayAttempt(sessionPath, now)) return false;
  attempts.set(sessionPath, { count: (attempts.get(sessionPath)?.count ?? 0) + 1, at: now });
  queued.add(sessionPath);
  queue.push({ path: sessionPath, text });
  if (!worker) worker = drain().finally(() => (worker = null));
  return true;
}

/**
 * Whether listing this chat may spend a request on it: the switch is on and the
 * chat was created after it was switched on. A missing or unreadable creation
 * date counts as "older" — the silent choice is always the one that sends
 * nothing.
 *
 * @param {Date | string | number | undefined} createdAt
 */
function isCoveredByTheSwitch(createdAt) {
  const since = titleGenerationEnabledAt();
  if (since === null) return false;
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ""));
  return Number.isFinite(created) && created >= since;
}

async function drain() {
  while (queue.length) {
    const job = queue.shift();
    try {
      const token = await oauthAccessToken();
      // No usable credential: the whole backlog is pointless, not just this job.
      // Nothing was sent, so no chat pays for it with one of its three attempts.
      if (!token) {
        forgetAttempt(job.path);
        for (const pending of queue) forgetAttempt(pending.path);
        queue.length = 0;
        queued.clear();
        return;
      }
      const title = await requestTitle(job.text, token);
      if (title) {
        await rememberTitle(job.path, title);
        forgetAttempt(job.path);
      }
    } catch {
      // Offline, refused, malformed: the fallback already covers the row.
    } finally {
      queued.delete(job.path);
    }
  }
}

/** Resolves when the queue is idle. The list endpoint never awaits it: it is
 *  there for tests and for anything that wants to observe the work. */
export function flushTitleQueue() {
  return worker ?? Promise.resolve();
}

// ---- public entry point ----------------------------------------------------
/**
 * The title to show for a chat, right now. Cached when there is one, the old
 * truncation otherwise — and in that case the chat is queued for a summary that
 * a later refresh will pick up.
 *
 * @param {string} sessionPath session file path, the cache key.
 * @param {string} firstMessage what the user opened the chat with.
 * @param {Date | string | number} [createdAt] when the chat was created; a chat
 *   older than the switch is never queued from here.
 * @param {number} [now] current time in ms; injectable for tests, which is the
 *   only way to observe the ten minutes between two attempts.
 * @returns {Promise<string>}
 */
export async function titleFor(sessionPath, firstMessage, createdAt, now = Date.now()) {
  const fallback = fallbackTitle(firstMessage);
  if (!sessionPath) return fallback;
  const cached = (await loadTitles()).get(sessionPath);
  if (cached) return cached;
  if (fallback && isCoveredByTheSwitch(createdAt)) enqueue(sessionPath, String(firstMessage), now);
  return fallback;
}

/**
 * The retroactive half, and the only one that ignores the switch: it runs on an
 * explicit click, which is the consent the switch stands for everywhere else.
 * Chats already in the cache are skipped, so a second click costs nothing.
 *
 * @param {{path?: string, firstMessage?: string}[]} chats the chats to cover.
 * @param {number} [now] current time in ms; injectable for tests.
 * @returns {Promise<number>} how many were queued.
 */
export async function queueMissingTitles(chats, now = Date.now()) {
  const cache = await loadTitles();
  let count = 0;
  for (const chat of chats ?? []) {
    const sessionPath = chat?.path;
    if (!sessionPath || cache.get(sessionPath)) continue;
    const text = String(chat.firstMessage ?? "");
    if (!fallbackTitle(text)) continue;
    if (enqueue(sessionPath, text, now)) count += 1;
  }
  return count;
}
