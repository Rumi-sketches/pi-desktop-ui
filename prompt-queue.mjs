import { randomUUID } from "node:crypto";

export const PROMPT_QUEUE_MAX_ITEMS = 20;
export const PROMPT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

/** @typedef {"steer" | "followUp"} QueueType */
/** @typedef {{data: string, mimeType: string, bytes: number}} QueueImage */
/** @typedef {{type: QueueType, text: string, images: QueueImage[], bytes: number}} PromptInput */
/** @typedef {PromptInput & {id: string}} QueuedPrompt */
/** @typedef {{id: string, type: QueueType, text: string, attachments: Array<{mimeType: string, bytes: number}>, bytes: number}} PublicPrompt */
/** @typedef {{action: string, ids: string[], queued: PublicPrompt[], bytes: number}} QueueChange */
/** @typedef {{name: string, source: string}} QueueCommand */
/** @typedef {{steeringMode: string, followUpMode: string, steer: (text: string, images?: Array<{type: string, data: string, mimeType: string}>) => unknown, followUp: (text: string, images?: Array<{type: string, data: string, mimeType: string}>) => unknown}} QueueSession */

export class PromptQueueError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = "PromptQueueError";
    this.status = status;
    this.code = code;
  }
}

/** @param {number} status @param {string} code @param {string} message */
const queueError = (status, code, message) => new PromptQueueError(status, code, message);

/** @param {unknown} data */
function decodedBase64Bytes(data) {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw queueError(400, "invalid_attachment", "image data must be non-empty base64");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * @param {{text?: unknown, images?: unknown, type?: unknown}} [body]
 * @returns {PromptInput}
 */
export function normalizePromptInput({ text, images, type } = {}) {
  const normalizedText = typeof text === "string" ? text : "";
  if (images !== undefined && !Array.isArray(images)) {
    throw queueError(400, "invalid_attachments", "images must be an array");
  }
  const imageList = Array.isArray(images) ? images : [];
  const normalizedImages = imageList.map((image) => {
    if (!image || typeof image.mimeType !== "string" || !image.mimeType.trim()) {
      throw queueError(400, "invalid_attachment", "every image needs a mimeType");
    }
    const bytes = decodedBase64Bytes(image.data);
    return { data: image.data, mimeType: image.mimeType, bytes };
  });
  if (!normalizedText.trim() && normalizedImages.length === 0) {
    throw queueError(400, "empty_prompt", "prompt must contain text or an image");
  }
  const normalizedType = type ?? "steer";
  if (normalizedType !== "steer" && normalizedType !== "followUp") {
    throw queueError(400, "invalid_queue_type", "type must be steer or followUp");
  }
  return {
    type: normalizedType,
    text: normalizedText,
    images: normalizedImages,
    bytes: Buffer.byteLength(normalizedText, "utf8") + normalizedImages.reduce((sum, image) => sum + image.bytes, 0),
  };
}

/** @param {QueuedPrompt} item @returns {PublicPrompt} */
function publicItem(item) {
  return {
    id: item.id,
    type: item.type,
    text: item.text,
    attachments: item.images.map((image) => ({ mimeType: image.mimeType, bytes: image.bytes })),
    bytes: item.bytes,
  };
}

/**
 * Context-owned, in-memory queue. Every mutation is synchronous: enqueue,
 * cancellation and boundary dispatch therefore form indivisible operations in
 * the Node event loop, without an await that could reorder two HTTP requests.
 */
export class PromptQueue {
  /** @type {QueuedPrompt[]} */
  #items = [];
  /** @type {Map<string, string>} */
  #terminal = new Map();
  #bytes = 0;
  #mutating = false;

  /**
   * @param {{idFactory?: () => string, maxItems?: number, maxBytes?: number,
   *   onChange?: (change: QueueChange) => void}} [options]
   */
  constructor({
    idFactory = randomUUID,
    maxItems = PROMPT_QUEUE_MAX_ITEMS,
    maxBytes = PROMPT_QUEUE_MAX_BYTES,
    onChange = () => {},
  } = {}) {
    this.idFactory = idFactory;
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.onChange = onChange;
  }

  get size() {
    return this.#items.length;
  }

  get bytes() {
    return this.#bytes;
  }

  publicItems() {
    return this.#items.map(publicItem);
  }

  /** @param {PromptInput} input @returns {PublicPrompt} */
  enqueue(input) {
    return this.#mutate(() => {
      if (this.#items.length >= this.maxItems) {
        throw queueError(409, "queue_item_limit", `prompt queue is limited to ${this.maxItems} items`);
      }
      if (input.bytes > this.maxBytes || this.#bytes + input.bytes > this.maxBytes) {
        throw queueError(413, "queue_byte_limit", `prompt queue is limited to ${this.maxBytes} bytes`);
      }
      const id = this.#newId();
      const item = { ...input, id };
      this.#items.push(item);
      this.#bytes += item.bytes;
      this.#changed("enqueue", [id]);
      return publicItem(item);
    });
  }

  /** @param {string} id @returns {PublicPrompt} */
  cancel(id) {
    return this.#mutate(() => {
      const index = this.#items.findIndex((item) => item.id === id);
      if (index === -1) {
        const outcome = this.#terminal.get(id);
        if (outcome === "delivered") {
          throw queueError(409, "queued_prompt_delivered", "the queued prompt has already been delivered");
        }
        if (outcome) {
          throw queueError(409, "queued_prompt_removed", "the queued prompt is no longer pending");
        }
        throw queueError(404, "queued_prompt_not_found", "queued prompt not found in this chat");
      }
      const [item] = this.#items.splice(index, 1);
      this.#bytes -= item.bytes;
      this.#remember(item.id, "cancelled");
      this.#changed("cancel", [item.id]);
      return publicItem(item);
    });
  }

  /** @param {QueueType} type @param {number} [count] @returns {QueuedPrompt[]} */
  take(type, count = 1) {
    return this.#mutate(() => {
      const taken = [];
      const kept = [];
      for (const item of this.#items) {
        if (item.type === type && taken.length < count) taken.push(item);
        else kept.push(item);
      }
      if (taken.length === 0) return [];
      this.#items = kept;
      for (const item of taken) {
        this.#bytes -= item.bytes;
        this.#remember(item.id, "delivered");
      }
      this.#changed("dispatch", taken.map((item) => item.id));
      return taken;
    });
  }

  /** @param {string} [reason] @returns {PublicPrompt[]} */
  clear(reason = "discarded") {
    return this.#mutate(() => {
      if (this.#items.length === 0) return [];
      const removed = this.#items;
      this.#items = [];
      this.#bytes = 0;
      for (const item of removed) this.#remember(item.id, reason);
      this.#changed(reason, removed.map((item) => item.id));
      return removed.map(publicItem);
    });
  }

  #newId() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = this.idFactory();
      if (typeof id === "string" && id && !this.#items.some((item) => item.id === id) && !this.#terminal.has(id)) return id;
    }
    throw queueError(500, "queue_id_failure", "could not allocate a queued prompt id");
  }

  /** @param {string} id @param {string} outcome */
  #remember(id, outcome) {
    this.#terminal.set(id, outcome);
    if (this.#terminal.size > 100) this.#terminal.delete(this.#terminal.keys().next().value);
  }

  /** @param {string} action @param {string[]} ids */
  #changed(action, ids) {
    this.onChange({ action, ids, queued: this.publicItems(), bytes: this.#bytes });
  }

  /** @template T @param {() => T} operation @returns {T} */
  #mutate(operation) {
    if (this.#mutating) throw new Error("nested prompt queue mutation");
    this.#mutating = true;
    try {
      return operation();
    } finally {
      this.#mutating = false;
    }
  }
}

/** @param {unknown} text @param {QueueCommand[]} commands @returns {QueueCommand|null} */
export function queuedExtensionCommand(text, commands) {
  if (typeof text !== "string" || !text.startsWith("/")) return null;
  const name = text.slice(1).split(/\s/, 1)[0];
  return commands.find((command) => command.source === "extension" && command.name === name) ?? null;
}

/**
 * @param {{session: QueueSession, emit: (event: Record<string, unknown>) => void,
 *   idFactory?: () => string, maxItems?: number, maxBytes?: number}} options
 */
export function createPromptQueueController({ session, emit, idFactory, maxItems, maxBytes }) {
  let queue;
  queue = new PromptQueue({
    idFactory,
    maxItems,
    maxBytes,
    onChange: (change) => emit({ kind: "queue", ...change }),
  });

  /** @param {QueueType} type */
  function dispatch(type) {
    const mode = type === "steer" ? session.steeringMode : session.followUpMode;
    const items = queue.take(type, mode === "all" ? Number.POSITIVE_INFINITY : 1);
    for (const item of items) {
      const images = item.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
      Promise.resolve(session[type](item.text, images.length ? images : undefined)).catch((error) => {
        emit({ kind: "error", message: `Queued prompt delivery failed: ${String(error?.message ?? error)}` });
      });
    }
  }

  return {
    enqueue: (input) => queue.enqueue(input),
    cancel: (id) => queue.cancel(id),
    clear: (reason) => queue.clear(reason),
    publicItems: () => queue.publicItems(),
    get bytes() { return queue.bytes; },
    onSessionEvent(event) {
      if (event.type === "turn_end") {
        const stop = event.message?.stopReason;
        if (stop !== "error" && stop !== "aborted") dispatch("steer");
        return;
      }
      if (event.type !== "agent_end") return;
      const lastAssistant = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
      const stop = lastAssistant?.stopReason;
      if (stop === "aborted") queue.clear("aborted");
      else if (stop === "error" && !event.willRetry) queue.clear("error");
      else if (!event.willRetry) {
        // A request can arrive after the final turn_end but before agent_end.
        // Hand late steering off here so it starts a continuation instead of
        // becoming stranded in the app queue.
        dispatch("steer");
        dispatch("followUp");
      }
    },
  };
}
