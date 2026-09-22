const DRAFTS_KEY = "piComposerDrafts";
const METADATA_KEY = "piComposerDraftMeta";

function requireKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("draft key must be a non-empty string");
  }
  return key;
}

function parseRecord(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.cwd !== "string" || typeof value.title !== "string" || typeof value.modified !== "string") {
    return null;
  }
  return {
    cwd: value.cwd,
    title: value.title,
    modified: value.modified,
    pending: value.pending === true,
  };
}

function cloneMetadata(value) {
  return value ? { ...value } : null;
}

/**
 * Browser persistence for composer text and sidebar metadata. Mutations update
 * the in-memory copy immediately and coalesce writes to the existing storage
 * keys. Attachment payloads are not accepted by this interface.
 * @param {{
 *   storage: Pick<Storage, "getItem"|"setItem">,
 *   delay?: number,
 *   setTimer?: (callback: () => void, delay: number) => any,
 *   clearTimer?: (id: any) => void,
 * }} options
 */
export function createDraftStorage({
  storage,
  delay = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new TypeError("draft storage must provide getItem and setItem");
  }
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError("draft storage delay must not be negative");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("draft storage timers must be functions");
  }

  const rawDrafts = parseRecord(storage, DRAFTS_KEY);
  const rawMetadata = parseRecord(storage, METADATA_KEY);
  const drafts = {};
  const metadata = {};
  for (const [key, value] of Object.entries(rawDrafts)) {
    if (key && typeof value === "string") drafts[key] = value;
  }
  for (const [key, value] of Object.entries(rawMetadata)) {
    const normalized = normalizeMetadata(value);
    if (key && normalized) metadata[key] = normalized;
  }

  let timer = null;

  function flush() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    try { storage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {}
    try { storage.setItem(METADATA_KEY, JSON.stringify(metadata)); } catch {}
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimer(flush, delay);
  }

  function get(key) {
    requireKey(key);
    return {
      draft: drafts[key] ?? "",
      metadata: cloneMetadata(metadata[key] ?? null),
    };
  }

  function entries() {
    const keys = new Set([...Object.keys(drafts), ...Object.keys(metadata)]);
    return [...keys].map((key) => ({ key, ...get(key) }));
  }

  function set(key, { draft, metadata: nextMetadata = null }) {
    requireKey(key);
    if (typeof draft !== "string") throw new TypeError("persisted draft must be a string");
    const normalized = nextMetadata === null ? null : normalizeMetadata(nextMetadata);
    if (nextMetadata !== null && !normalized) throw new TypeError("draft metadata is invalid");

    if (draft.trim()) drafts[key] = draft;
    else delete drafts[key];
    if (normalized && (draft.trim() || normalized.pending)) metadata[key] = normalized;
    else delete metadata[key];
    schedule();
    return get(key);
  }

  function removeMetadata(key) {
    requireKey(key);
    if (!(key in metadata)) return false;
    delete metadata[key];
    schedule();
    return true;
  }

  function remove(key) {
    requireKey(key);
    const changed = key in drafts || key in metadata;
    delete drafts[key];
    delete metadata[key];
    if (changed) schedule();
    return changed;
  }

  function rekey(oldKey, newKey) {
    requireKey(oldKey);
    requireKey(newKey);
    if (oldKey === newKey) return get(newKey);
    if (newKey in drafts || newKey in metadata) {
      throw new TypeError("new draft key already identifies persisted data");
    }
    if (oldKey in drafts) drafts[newKey] = drafts[oldKey];
    if (oldKey in metadata) metadata[newKey] = metadata[oldKey];
    delete drafts[oldKey];
    delete metadata[oldKey];
    schedule();
    return get(newKey);
  }

  return { get, entries, set, removeMetadata, remove, rekey, flush };
}
