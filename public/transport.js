function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

/** Add an opaque session key without inspecting or rewriting it. */
export function withSessionKey(url, sessionKey) {
  if (!sessionKey) return url;
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  return `${base}${base.includes("?") ? "&" : "?"}s=${encodeURIComponent(sessionKey)}${hash}`;
}

/**
 * Browser transport for chat-scoped HTTP and the one detailed SSE subscription.
 * A request captures its key and navigation identity before its first await.
 * @param {{
 *   fetchImpl?: (url: string, options?: any) => Promise<any>,
 *   createEventSource?: (url: string) => any,
 * }} [dependencies]
 */
export function createTransport({
  fetchImpl = (url, options) => globalThis.fetch(url, options),
  createEventSource = (url) => new globalThis.EventSource(url),
} = {}) {
  requireFunction(fetchImpl, "fetchImpl");
  requireFunction(createEventSource, "createEventSource");

  let stream = null;
  let streamGeneration = 0;

  async function request(url, options = {}, {
    sessionKey = null,
    navigationRevision = null,
    signal = options.signal,
    isCurrent = null,
  } = {}) {
    if (isCurrent !== null) requireFunction(isCurrent, "isCurrent");
    const owner = Object.freeze({ sessionKey, navigationRevision });
    try {
      const response = await fetchImpl(withSessionKey(url, sessionKey), { ...options, signal });
      const payload = await response.json().catch(() => ({}));
      return {
        response,
        payload,
        owner,
        aborted: false,
        stale: Boolean(isCurrent && !isCurrent()),
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { response: null, payload: {}, owner, aborted: true, stale: true };
      }
      throw error;
    }
  }

  function closeDetailed() {
    if (!stream) return;
    const closing = stream;
    stream = null;
    try { closing.source.close(); } catch {}
  }

  /**
   * @param {string|null} sessionKey
   * @param {{
   *   onOpen?: (owner: {sessionKey: string, generation: number}) => void,
   *   onError?: (owner: {sessionKey: string, generation: number}) => void,
   *   onEvent?: (event: any, owner: {sessionKey: string, generation: number}) => void,
   * }} [handlers]
   */
  function followDetailed(sessionKey, { onOpen = () => {}, onError = () => {}, onEvent = () => {} } = {}) {
    if (!sessionKey) {
      closeDetailed();
      return null;
    }
    if (stream?.sessionKey === sessionKey) return stream.source;

    closeDetailed();
    const slot = {
      generation: ++streamGeneration,
      sessionKey,
      source: null,
    };
    const source = createEventSource(withSessionKey("/api/events", sessionKey));
    slot.source = source;
    stream = slot;

    source.onopen = () => {
      if (stream === slot) onOpen(Object.freeze({ sessionKey: slot.sessionKey, generation: slot.generation }));
    };
    source.onerror = () => {
      if (stream === slot) onError(Object.freeze({ sessionKey: slot.sessionKey, generation: slot.generation }));
    };
    source.onmessage = (message) => {
      if (stream !== slot) return;
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      onEvent(event, Object.freeze({ sessionKey: slot.sessionKey, generation: slot.generation }));
    };
    return source;
  }

  function rekeyDetailed(oldKey, newKey) {
    if (!stream || stream.sessionKey !== oldKey || !newKey) return false;
    stream.sessionKey = newKey;
    return true;
  }

  return {
    request,
    followDetailed,
    rekeyDetailed,
    closeDetailed,
    detailedSessionKey: () => stream?.sessionKey ?? null,
    detailedReadyState: () => stream?.source?.readyState ?? null,
  };
}
