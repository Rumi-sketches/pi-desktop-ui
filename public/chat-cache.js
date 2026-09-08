export const CHAT_CACHE_LIMIT = 8;

function requireKey(key, label = "chat key") {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return key;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

function requireLimit(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("chat cache limit must be a positive integer");
  }
  return value;
}

/**
 * Bounded owner for the transient state of visited chats. Text drafts are
 * mirrored through the supplied persistence adapter; attachments and view
 * resources never leave memory.
 * @param {{
 *   limit?: number,
 *   loadDraft?: (key: string) => string,
 *   saveDraft?: (key: string, draft: string) => void,
 *   removeDraft?: (key: string) => void,
 * }} [options]
 */
export function createChatCache({
  limit = CHAT_CACHE_LIMIT,
  loadDraft = (..._args) => "",
  saveDraft = (..._args) => {},
  removeDraft = (..._args) => {},
} = {}) {
  requireLimit(limit);
  requireFunction(loadDraft, "loadDraft");
  requireFunction(saveDraft, "saveDraft");
  requireFunction(removeDraft, "removeDraft");

  const entries = new Map();

  function newEntry(key) {
    const savedDraft = loadDraft(key);
    return {
      key,
      composer: {
        draft: typeof savedDraft === "string" ? savedDraft : "",
        attachments: [],
      },
      view: {
        scrollTop: null,
        snapshot: null,
      },
      resources: {
        listeners: new Set(),
        timers: new Set(),
        cleanups: new Set(),
        disposeSnapshot: null,
      },
    };
  }

  function disposeView(entry) {
    for (const listener of entry.resources.listeners) {
      listener.target.removeEventListener(listener.type, listener.callback, listener.options);
    }
    entry.resources.listeners.clear();
    for (const timer of entry.resources.timers) timer.clear(timer.id);
    entry.resources.timers.clear();
    if (entry.view.snapshot !== null) {
      entry.resources.disposeSnapshot?.(entry.view.snapshot);
      entry.view.snapshot = null;
    }
    entry.resources.disposeSnapshot = null;
  }

  function dispose(entry) {
    disposeView(entry);
    // Entry-lifetime work, such as attachment reads, survives a view refresh.
    for (const cleanup of entry.resources.cleanups) cleanup();
    entry.resources.cleanups.clear();
    entry.composer.attachments.length = 0;
  }

  function evictOverflow() {
    while (entries.size > limit) {
      const oldestKey = entries.keys().next().value;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      dispose(oldest);
    }
  }

  function touch(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function ensure(key) {
    requireKey(key);
    const present = touch(key);
    if (present) return present;
    const entry = newEntry(key);
    entries.set(key, entry);
    evictOverflow();
    return entry;
  }

  function peek(key) {
    requireKey(key);
    return entries.get(key) ?? null;
  }

  function setDraft(key, draft) {
    if (typeof draft !== "string") throw new TypeError("chat draft must be a string");
    const entry = ensure(key);
    entry.composer.draft = draft;
    if (draft.trim()) saveDraft(key, draft);
    else removeDraft(key);
    return entry;
  }

  function setAttachments(key, attachments) {
    if (!Array.isArray(attachments)) throw new TypeError("chat attachments must be an array");
    const entry = ensure(key);
    entry.composer.attachments = attachments;
    return entry;
  }

  /**
   * @param {string} key
   * @param {{ scrollTop?: number|null, snapshot?: any, disposeSnapshot?: (snapshot: any) => void }} [view]
   */
  function saveView(key, view = {}) {
    const { scrollTop, snapshot, disposeSnapshot } = view;
    const entry = ensure(key);
    if (scrollTop !== undefined) {
      if (scrollTop !== null && (typeof scrollTop !== "number" || !Number.isFinite(scrollTop))) {
        throw new TypeError("chat scrollTop must be null or a finite number");
      }
      entry.view.scrollTop = scrollTop;
    }
    if (snapshot !== undefined) {
      if (entry.view.snapshot !== null && entry.view.snapshot !== snapshot) {
        entry.resources.disposeSnapshot?.(entry.view.snapshot);
      }
      entry.view.snapshot = snapshot;
      entry.resources.disposeSnapshot = disposeSnapshot === undefined
        ? null
        : requireFunction(disposeSnapshot, "disposeSnapshot");
    }
    return entry;
  }

  /**
   * Reads scroll before detaching the rendered tree. Emptying a scroll
   * container resets scrollTop in browsers, so callers must not perform these
   * operations in the opposite order.
   * @param {string} key
   * @param {{
   *   readScrollTop: () => number,
   *   detachSnapshot: () => any,
   *   disposeSnapshot?: (snapshot: any) => void,
   * }} view
   */
  function captureView(key, { readScrollTop, detachSnapshot, disposeSnapshot }) {
    requireFunction(readScrollTop, "scroll reader");
    requireFunction(detachSnapshot, "snapshot detacher");
    const scrollTop = readScrollTop();
    const snapshot = detachSnapshot();
    return saveView(key, { scrollTop, snapshot, disposeSnapshot });
  }

  function takeSnapshot(key) {
    const entry = ensure(key);
    const snapshot = entry.view.snapshot;
    entry.view.snapshot = null;
    return snapshot;
  }

  function trackListener(key, target, type, callback, options) {
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("listener target must be an EventTarget");
    }
    requireKey(key);
    requireKey(type, "listener type");
    requireFunction(callback, "listener callback");
    const entry = ensure(key);
    const resource = { target, type, callback, options };
    target.addEventListener(type, callback, options);
    entry.resources.listeners.add(resource);
    return () => entry.resources.listeners.delete(resource);
  }

  function trackTimer(key, id, clear = clearTimeout) {
    requireFunction(clear, "timer clear function");
    const entry = ensure(key);
    const resource = { id, clear };
    entry.resources.timers.add(resource);
    return () => entry.resources.timers.delete(resource);
  }

  function addCleanup(key, cleanup) {
    requireFunction(cleanup, "cleanup");
    const entry = ensure(key);
    entry.resources.cleanups.add(cleanup);
    return () => entry.resources.cleanups.delete(cleanup);
  }

  function clearView(key) {
    const entry = peek(key);
    if (entry) disposeView(entry);
  }

  function remove(key) {
    const entry = peek(key);
    if (!entry) return false;
    entries.delete(key);
    dispose(entry);
    return true;
  }

  function rekey(oldKey, newKey) {
    requireKey(oldKey, "old chat key");
    requireKey(newKey, "new chat key");
    if (oldKey === newKey) return ensure(newKey);
    if (entries.has(newKey)) throw new TypeError("new chat key already identifies another cached chat");
    const entry = entries.get(oldKey) ?? newEntry(oldKey);
    entries.delete(oldKey);
    entry.key = newKey;
    entries.set(newKey, entry);
    if (entry.composer.draft.trim()) saveDraft(newKey, entry.composer.draft);
    else removeDraft(newKey);
    removeDraft(oldKey);
    evictOverflow();
    return entry;
  }

  function clear() {
    for (const entry of entries.values()) dispose(entry);
    entries.clear();
  }

  return {
    limit,
    get size() { return entries.size; },
    keys: () => [...entries.keys()],
    ensure,
    peek,
    setDraft,
    setAttachments,
    saveView,
    captureView,
    takeSnapshot,
    trackListener,
    trackTimer,
    addCleanup,
    clearView,
    remove,
    rekey,
    clear,
  };
}
