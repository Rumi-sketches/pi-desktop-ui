/**
 * titles.mjs — the one-line summary the sidebar shows for a chat.
 *
 * A chat has no title of its own: pi stores the first user message, and the
 * sidebar used to show a cut of it. Here that cut becomes the *fallback*: when
 * a subscription model is available, the first message is summarized by a small model
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
 *   - one request at a time. A chat already in the cache is never summarized
 *     again. Chats without an eligible subscription model never enter the
 *     queue, while remote failures share a strict per-chat retry budget.
 *   - a failure is not an error the user should see: no subscription, no
 *     network, or a rejected request all leave the same truncation the sidebar
 *     had before this module existed. At most three remote calls are made per
 *     chat, with retries ten minutes apart, then the row keeps its fallback
 *     until the process restarts.
 *
 * Authentication stays inside pi's shared ModelRuntime. Title requests only
 * use subscription-backed providers; API keys are never selected implicitly.
 */
import path from "node:path";
import {
  AGENT_DIR,
  isLunaTitleFallbackEnabled,
  isTitleGenerationEnabled,
  jsonFile,
  lunaTitleFallbackEnabledAt,
  titleGenerationEnabledAt,
} from "./session-store.mjs";

// The process owns one ModelRuntime, created by contexts.mjs and shared with
// title generation. It is injected here rather than imported: titles never
// create a second runtime or introduce an import cycle.
let modelRuntime = null;
export function configureTitleModelRuntime(runtime) {
  modelRuntime = runtime;
}

// Small and cheap: this is a seven-word summary, not a conversation.
const HAIKU_MODEL = { provider: "anthropic", id: "claude-haiku-4-5" };
const LUNA_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" };
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

function subscriptionModel(runtime, modelRef) {
  if (!runtime) return undefined;
  const model = runtime.getModel?.(modelRef.provider, modelRef.id);
  return model && runtime.isUsingSubscription?.(modelRef.provider) === true ? model : undefined;
}

/**
 * One standalone title request through pi's public runtime. A successful model
 * response is distinguished from provider unavailability: only the latter may
 * later authorize a fallback.
 *
 * @param {string} text the chat's first message.
 * @param {any} [runtime] the process-wide ModelRuntime.
 * @param {{provider: string, id: string}} [modelRef]
 * @param {number} [timeoutMs]
 * @returns {Promise<{status: "answered" | "unavailable", attempted: boolean, title: string | null}>}
 */
export async function requestTitle(
  text,
  runtime = modelRuntime,
  modelRef = HAIKU_MODEL,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const input = String(text ?? "").slice(0, MAX_INPUT_CHARS).trim();
  if (!input) return { status: "unavailable", attempted: false, title: null };
  const model = subscriptionModel(runtime, modelRef);
  if (!model) return { status: "unavailable", attempted: false, title: null };

  try {
    const answer = await runtime.completeSimple(
      model,
      {
        systemPrompt: INSTRUCTION,
        messages: [{ role: "user", content: input, timestamp: Date.now() }],
      },
      {
        maxTokens: MAX_OUTPUT_TOKENS,
        cacheRetention: "none",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (answer.stopReason === "error" || answer.stopReason === "aborted") {
      return { status: "unavailable", attempted: true, title: null };
    }
    const raw = (answer.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join(" ");
    return { status: "answered", attempted: true, title: cleanTitle(raw) };
  } catch {
    return { status: "unavailable", attempted: true, title: null };
  }
}

// ---- queue -----------------------------------------------------------------
// One worker, one request in flight. `queued` is what keeps a chat listed twice
// in a row from being summarized twice.
/** @type {{ path: string, text: string, allowLuna: boolean, now: number }[]} */
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

function recordRemoteAttempt(sessionPath, now) {
  const previous = attempts.get(sessionPath);
  attempts.set(sessionPath, { count: (previous?.count ?? 0) + 1, at: now });
}

function forgetAttempts(sessionPath) {
  attempts.delete(sessionPath);
}

/**
 * @param {string} sessionPath
 * @param {string} text
 * @param {number} [now]
 * @param {boolean} [allowLuna]
 * @returns {boolean} whether the chat was actually queued.
 */
function enqueue(sessionPath, text, now = Date.now(), allowLuna = false) {
  if (queued.has(sessionPath) || queue.length >= QUEUE_MAX) return false;
  if (!mayAttempt(sessionPath, now)) return false;
  const primary = subscriptionModel(modelRuntime, HAIKU_MODEL);
  const fallback = allowLuna && subscriptionModel(modelRuntime, LUNA_MODEL);
  if (!primary && !fallback) return false;
  queued.add(sessionPath);
  queue.push({ path: sessionPath, text, allowLuna, now });
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
function isCoveredBySwitch(createdAt, enabledAt) {
  if (enabledAt === null) return false;
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ""));
  return Number.isFinite(created) && created >= enabledAt;
}

const isCoveredByTheSwitch = (createdAt) => isCoveredBySwitch(createdAt, titleGenerationEnabledAt());
const isCoveredByLunaSwitch = (createdAt) => isCoveredBySwitch(createdAt, lunaTitleFallbackEnabledAt());

async function requestWithinBudget(job, modelRef) {
  if (!isTitleGenerationEnabled() || (attempts.get(job.path)?.count ?? 0) >= MAX_ATTEMPTS) {
    return { status: "unavailable", attempted: false, title: null };
  }
  const outcome = await requestTitle(job.text, modelRuntime, modelRef);
  if (outcome.attempted) recordRemoteAttempt(job.path, job.now);
  return outcome;
}

async function drain() {
  while (queue.length) {
    const job = queue.shift();
    try {
      const primary = await requestWithinBudget(job, HAIKU_MODEL);
      // A valid Haiku response, even one whose wording cleans down to nothing,
      // is final. Luna is only a provider-unavailability fallback.
      let outcome = primary;
      if (primary.status === "unavailable" && job.allowLuna && isLunaTitleFallbackEnabled()) {
        outcome = await requestWithinBudget(job, LUNA_MODEL);
      }
      if (outcome.title) {
        await rememberTitle(job.path, outcome.title);
        forgetAttempts(job.path);
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
  if (fallback && isCoveredByTheSwitch(createdAt)) {
    enqueue(sessionPath, String(firstMessage), now, isCoveredByLunaSwitch(createdAt));
  }
  return fallback;
}

/**
 * The retroactive half ignores the enable timestamps but still requires the
 * primary switch. It runs only on an explicit click; Luna remains governed by
 * its separate toggle. Cached chats are skipped, so a second click costs nothing.
 *
 * @param {{path?: string, firstMessage?: string}[]} chats the chats to cover.
 * @param {number} [now] current time in ms; injectable for tests.
 * @returns {Promise<number>} how many were queued.
 */
export async function queueMissingTitles(chats, now = Date.now()) {
  if (!isTitleGenerationEnabled()) return 0;
  const cache = await loadTitles();
  let count = 0;
  for (const chat of chats ?? []) {
    const sessionPath = chat?.path;
    if (!sessionPath || cache.get(sessionPath)) continue;
    const text = String(chat.firstMessage ?? "");
    if (!fallbackTitle(text)) continue;
    if (enqueue(sessionPath, text, now, isLunaTitleFallbackEnabled())) count += 1;
  }
  return count;
}
