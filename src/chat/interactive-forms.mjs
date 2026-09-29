/**
 * A session-scoped bridge between the model's `request_form` tool call and the
 * browser that answers it. Tool calls remain pending until one client submits
 * a valid response (or the agent aborts the turn).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const MAX_FIELDS = 12;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CUSTOM_CHARS = 4096;
const OPTION_TYPES = new Set(["select", "radio", "multiselect"]);
const TEXT_TYPES = new Set(["text", "email", "url", "tel", "date", "textarea"]);
const FIELD_TYPES = new Set([...TEXT_TYPES, ...OPTION_TYPES, "number", "checkbox"]);
const FIELD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const FORM_OUTCOME_TYPE = "pi-desktop-ui:form-outcome";

const formOptionSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

const formFieldSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  type: Type.Union([
    Type.Literal("text"),
    Type.Literal("textarea"),
    Type.Literal("email"),
    Type.Literal("url"),
    Type.Literal("tel"),
    Type.Literal("number"),
    Type.Literal("date"),
    Type.Literal("select"),
    Type.Literal("radio"),
    Type.Literal("multiselect"),
    Type.Literal("checkbox"),
  ]),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  placeholder: Type.Optional(Type.String({ maxLength: 300 })),
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(formOptionSchema, { minItems: 1, maxItems: 30 })),
});

const formSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  submitLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  fields: Type.Array(formFieldSchema, { minItems: 1, maxItems: MAX_FIELDS }),
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the constraints that are awkward to express in the tool schema. */
export function normalizeFormRequest(input) {
  if (!plainObject(input) || typeof input.title !== "string" || !Array.isArray(input.fields)) {
    throw new Error("invalid form definition");
  }
  if (!input.title.trim() || input.title.length > 200 || input.fields.length < 1 || input.fields.length > MAX_FIELDS) {
    throw new Error(`a form needs between 1 and ${MAX_FIELDS} fields and a title`);
  }
  const ids = new Set();
  const fields = input.fields.map((field) => {
    if (!plainObject(field) || !FIELD_ID_RE.test(field.id ?? "") || typeof field.label !== "string" || !field.label.trim()) {
      throw new Error("every form field needs a valid id and label");
    }
    if (ids.has(field.id)) throw new Error(`duplicate form field id: ${field.id}`);
    ids.add(field.id);
    if (!FIELD_TYPES.has(field.type)) throw new Error(`unsupported form field type: ${field.type}`);
    const options = Array.isArray(field.options)
      ? field.options.map((option) => ({
          value: String(option.value),
          label: String(option.label),
          ...(option.description ? { description: String(option.description) } : {}),
        }))
      : [];
    if (OPTION_TYPES.has(field.type) && options.length === 0) {
      throw new Error(`${field.id} needs at least one option`);
    }
    if (new Set(options.map((option) => option.value)).size !== options.length) {
      throw new Error(`${field.id} contains duplicate option values`);
    }
    return {
      id: field.id,
      label: field.label.trim(),
      type: field.type,
      required: !!field.required,
      ...(field.description ? { description: String(field.description) } : {}),
      ...(field.placeholder ? { placeholder: String(field.placeholder) } : {}),
      ...(options.length ? { options } : {}),
    };
  });
  return {
    title: input.title.trim(),
    ...(input.description ? { description: String(input.description) } : {}),
    submitLabel: input.submitLabel?.trim() || "Submit",
    fields,
  };
}

function responseBytes(values) {
  return Buffer.byteLength(JSON.stringify(values), "utf8");
}

function customChoice(raw, fieldId) {
  if (!plainObject(raw) || Object.keys(raw).some((key) => key !== "custom")
      || typeof raw.custom !== "string" || raw.custom.length > MAX_CUSTOM_CHARS) {
    throw new Error(`${fieldId} needs a valid custom answer`);
  }
  return raw.custom.trim();
}

/** Validate and canonicalize values before they cross back into model context. */
export function normalizeFormResponse(form, input) {
  if (!plainObject(input)) throw new Error("form values must be an object");
  const known = new Set(form.fields.map((field) => field.id));
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`unknown form field: ${key}`);
  const values = {};
  for (const field of form.fields) {
    const raw = input[field.id];
    if (field.type === "checkbox") {
      if (raw !== undefined && typeof raw !== "boolean") throw new Error(`${field.id} must be true or false`);
      values[field.id] = raw === true;
      if (field.required && values[field.id] !== true) throw new Error(`${field.id} is required`);
      continue;
    }
    if (field.type === "multiselect") {
      const selected = plainObject(raw) ? raw.selected : raw;
      if (selected !== undefined && (!Array.isArray(selected) || selected.some((value) => typeof value !== "string"))) {
        throw new Error(`${field.id} must be a list of option values`);
      }
      const custom = plainObject(raw) ? customChoice({ custom: raw.custom }, field.id) : "";
      if (plainObject(raw) && (Object.keys(raw).some((key) => key !== "selected" && key !== "custom")
          || !Array.isArray(raw.selected))) throw new Error(`${field.id} needs valid selected options`);
      const allowed = new Set(field.options.map((option) => option.value));
      if ((selected ?? []).some((value) => !allowed.has(value))) throw new Error(`${field.id} contains an invalid option`);
      values[field.id] = [...new Set([...(selected ?? []), ...(custom ? [custom] : [])])];
      if (field.required && values[field.id].length === 0) throw new Error(`${field.id} is required`);
      continue;
    }
    if (field.type === "number") {
      if (raw === "" || raw === undefined || raw === null) {
        if (field.required) throw new Error(`${field.id} is required`);
        values[field.id] = null;
      } else {
        const number = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(number)) throw new Error(`${field.id} must be a number`);
        values[field.id] = number;
      }
      continue;
    }
    if (raw !== undefined && typeof raw !== "string" && !(OPTION_TYPES.has(field.type) && plainObject(raw))) {
      throw new Error(`${field.id} must be text`);
    }
    const value = plainObject(raw) ? customChoice(raw, field.id) : raw ?? "";
    if (field.required && !value.trim()) throw new Error(`${field.id} is required`);
    if (OPTION_TYPES.has(field.type) && value && !plainObject(raw)) {
      const allowed = new Set(field.options.map((option) => option.value));
      if (!allowed.has(value)) throw new Error(`${field.id} contains an invalid option`);
    }
    values[field.id] = value;
  }
  if (responseBytes(values) > MAX_RESPONSE_BYTES) throw new Error("form response is too large");
  return values;
}

export class InteractiveFormBroker {
  constructor() {
    this.pending = new Map();
  }

  wait(toolCallId, form, signal) {
    if (this.pending.has(toolCallId)) throw new Error("form request is already pending");
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(toolCallId);
        reject(new Error("form request aborted"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(toolCallId, {
        form,
        settle: (status, values) => {
          signal?.removeEventListener("abort", abort);
          this.pending.delete(toolCallId);
          const outcome = status === "submitted" ? { status, values } : { status };
          resolve({
            content: [{ type: "text", text: JSON.stringify(outcome) }],
            details: outcome,
            ...(status !== "submitted" ? { terminate: true } : {}),
          });
        },
      });
    });
  }

  submit(toolCallId, input) {
    const request = this.pending.get(toolCallId);
    if (!request) return null;
    const values = normalizeFormResponse(request.form, input);
    request.settle("submitted", values);
    return values;
  }

  skip(toolCallId) {
    const request = this.pending.get(toolCallId);
    if (!request) return false;
    request.settle("skipped");
    return true;
  }

  interruptAll() {
    for (const request of [...this.pending.values()]) request.settle("interrupted");
  }

  has(toolCallId) {
    return this.pending.has(toolCallId);
  }

  get waiting() {
    return this.pending.size > 0;
  }
}

// The SDK persists the assistant tool call before executing it. A process exit
// drops the waiting promise but leaves that call in the session branch. A
// clean shutdown also records an aborted tool result and assistant message.
// A later user turn or a real tool result closes the recovery window.
export function formStateFromBranch(branch) {
  const outcomes = new Map();
  let batch = [];
  for (const entry of branch) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message?.role === "user") batch = [];
      else if (message?.role === "assistant") {
        const calls = Array.isArray(message.content)
          ? message.content.filter((part) => part?.type === "toolCall") : [];
        if (calls.length) {
          batch = calls.map((call) => ({ id: call.id, name: call.name, args: call.arguments, result: null }));
        } else if (batch.length && message.stopReason !== "aborted") batch = [];
      } else if (message?.role === "toolResult") {
        const call = batch.find((item) => item.id === message.toolCallId);
        if (call) call.result = message;
      }
    } else if (entry.type === "custom_message" && entry.customType === FORM_OUTCOME_TYPE) {
      const { toolCallId, status, values } = entry.details ?? {};
      if (typeof toolCallId === "string" && (status === "submitted" || status === "skipped")) {
        outcomes.set(toolCallId, { status, ...(status === "submitted" ? { values } : {}) });
        batch = [];
      }
    } else if (entry.type === "custom_message") {
      batch = [];
    }
  }
  const interrupted = (call) => call.name === "request_form" && call.result?.content?.length === 1
    && (call.result.content[0]?.text === "form request aborted"
      || call.result.details?.status === "interrupted");
  const incomplete = (call) => !call.result || interrupted(call);
  const index = batch.findIndex(incomplete);
  const call = batch[index];
  let pending = null;
  if (call?.name === "request_form" && !outcomes.has(call.id)) {
    try {
      pending = {
        id: call.id,
        form: normalizeFormRequest(call.args),
        abortedResult: !!call.result,
        followingCalls: batch.slice(index + 1).filter((later) => !later.result)
          .map(({ id, name }) => ({ id, name })),
      };
    } catch {
      // A malformed persisted form cannot be answered in the UI.
    }
  }
  return { pending, outcomes };
}

export function createInteractiveFormTool(broker) {
  return defineTool({
    name: "request_form",
    label: "Request form",
    description: "Show the user a native fillable form and wait for their answers before continuing.",
    promptSnippet: "Request structured user input with a native fillable form and wait for the response",
    promptGuidelines: [
      "Use request_form when several related answers or constrained choices are needed; ask a short question in normal text when one free-form answer is enough.",
      "Keep forms focused, use stable descriptive field ids, and put all independent questions in one form.",
      "Choice fields always allow a custom written answer, so present options as suggestions rather than an exhaustive list.",
    ],
    parameters: formSchema,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => broker.wait(toolCallId, normalizeFormRequest(params), signal),
  });
}
