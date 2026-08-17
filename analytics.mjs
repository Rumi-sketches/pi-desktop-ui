/**
 * analytics.mjs — cost and token history, aggregated from the session log.
 *
 * Reads every `~/.pi/agent/sessions/**.jsonl` and pre-aggregates it by
 * day x model x project, so `GET /api/analytics` hands the page a small payload
 * it can filter client-side without ever hitting the disk again. A file is
 * scanned once and cached on (mtime, size): a chat that hasn't changed since
 * the last request costs nothing.
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { listSessionFiles, readSessionRecords } from "./session-store.mjs";


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
export async function scanSessionFile(file) {
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

/**
 * @typedef {object} AnalyticsBucket usage of one model, on one day, in one project.
 * @property {string} day ISO date, `YYYY-MM-DD`.
 * @property {string} model
 * @property {string} project
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} tokens
 * @property {number} cost
 * @property {number} requests
 * @property {number} sessions
 */

/**
 * @typedef {object} AnalyticsPayload body of `GET /api/analytics`.
 * @property {string} generatedAt ISO timestamp of this aggregation.
 * @property {number} files session files scanned.
 * @property {string|null} first earliest day seen, `YYYY-MM-DD`.
 * @property {string|null} last latest day seen, `YYYY-MM-DD`.
 * @property {string[]} models every model that appears in the buckets, sorted.
 * @property {string[]} projects every project that appears, sorted.
 * @property {AnalyticsBucket[]} buckets sorted by day, ascending.
 */

// Pre-aggregate by day x model x project. The client applies filters on this
// (small) payload, so switching range/model never hits the disk again.
/** @returns {Promise<AnalyticsPayload>} */
export async function buildAnalytics() {
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

