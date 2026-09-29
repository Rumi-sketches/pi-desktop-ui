import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractiveFormBroker,
  createInteractiveFormTool,
  formStateFromBranch,
  normalizeFormRequest,
  normalizeFormResponse,
} from "../src/chat/interactive-forms.mjs";

const form = () => normalizeFormRequest({
  title: "Project details",
  fields: [
    { id: "name", label: "Name", type: "text", required: true },
    {
      id: "platform",
      label: "Platform",
      type: "radio",
      required: true,
      options: [
        { value: "web", label: "Web" },
        { value: "desktop", label: "Desktop" },
      ],
    },
    {
      id: "features",
      label: "Features",
      type: "multiselect",
      options: [
        { value: "sync", label: "Sync" },
        { value: "offline", label: "Offline" },
      ],
    },
    { id: "approved", label: "Approval", type: "checkbox", required: true },
  ],
});

test("normalizes form definitions and rejects ambiguous option fields", () => {
  assert.equal(form().submitLabel, "Submit");
  assert.throws(
    () => normalizeFormRequest({ title: "Broken", fields: [{ id: "choice", label: "Choice", type: "select" }] }),
    /at least one option/,
  );
  assert.throws(
    () => normalizeFormRequest({
      title: "Broken",
      fields: [
        { id: "same", label: "One", type: "text" },
        { id: "same", label: "Two", type: "text" },
      ],
    }),
    /duplicate form field id/,
  );
});

test("validates and canonicalizes a submitted form", () => {
  assert.deepEqual(normalizeFormResponse(form(), {
    name: "Studio",
    platform: "desktop",
    features: ["sync", "sync"],
    approved: true,
  }), {
    name: "Studio",
    platform: "desktop",
    features: ["sync"],
    approved: true,
  });
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio",
    platform: "invalid",
    features: [],
    approved: true,
  }), /invalid option/);
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio",
    platform: "web",
    features: [],
    approved: false,
  }), /approved is required/);
});

test("choice fields accept bounded custom answers without accepting unknown option values", () => {
  assert.deepEqual(normalizeFormResponse(form(), {
    name: "Studio",
    platform: { custom: "  Linux desktop  " },
    features: { selected: ["sync", "sync"], custom: "  Local export  " },
    approved: true,
  }), {
    name: "Studio",
    platform: "Linux desktop",
    features: ["sync", "Local export"],
    approved: true,
  });
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio", platform: { custom: " " }, features: [], approved: true,
  }), /platform is required/);
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio", platform: { custom: "ok", extra: true }, features: [], approved: true,
  }), /valid custom answer/);
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio", platform: "web", features: { selected: ["unknown"], custom: "Export" }, approved: true,
  }), /invalid option/);
  assert.throws(() => normalizeFormResponse(form(), {
    name: "Studio", platform: { custom: "x".repeat(4097) }, features: [], approved: true,
  }), /valid custom answer/);
  const selectForm = normalizeFormRequest({
    title: "Target",
    fields: [{ id: "target", label: "Target", type: "select", required: true,
      options: [{ value: "browser", label: "Browser" }] }],
  });
  assert.deepEqual(normalizeFormResponse(selectForm, { target: { custom: "Desktop app" } }),
    { target: "Desktop app" });
});

test("the broker resolves a tool call once and refuses late submissions", async () => {
  const broker = new InteractiveFormBroker();
  const waiting = broker.wait("call-1", form());
  const values = { name: "Studio", platform: "web", features: [], approved: true };
  assert.deepEqual(broker.submit("call-1", values), values);
  assert.equal(broker.submit("call-1", values), null);
  const result = await waiting;
  assert.deepEqual(JSON.parse(result.content[0].text), { status: "submitted", values });
});

test("aborting a turn removes its pending form", async () => {
  const broker = new InteractiveFormBroker();
  const controller = new AbortController();
  const waiting = broker.wait("call-2", form(), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /form request aborted/);
  assert.equal(broker.submit("call-2", {}), null);
});

test("broker exposes only the interval spent waiting for user input", async () => {
  const broker = new InteractiveFormBroker();
  assert.equal(broker.waiting, false);

  const waiting = broker.wait("call-waiting", form());
  assert.equal(broker.waiting, true);
  broker.submit("call-waiting", { name: "Studio", platform: "web", features: [], approved: true });
  await waiting;

  assert.equal(broker.waiting, false);
});

test("the tool advertises the native form capability to the model", () => {
  const tool = createInteractiveFormTool(new InteractiveFormBroker());
  assert.equal(tool.name, "request_form");
  assert.match(tool.promptSnippet, /fillable form/);
  assert.equal(tool.executionMode, "sequential");
});

test("an aborted form remains recoverable after shutdown, while later turns and outcomes close it", () => {
  const question = {
    type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "form-1", name: "request_form", arguments: form() },
      { type: "toolCall", id: "later", name: "read", arguments: { path: "package.json" } },
    ] },
  };
  const aborted = { type: "message", message: { role: "toolResult", toolCallId: "form-1", isError: true,
    content: [{ type: "text", text: "form request aborted" }] } };
  const trailing = { type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } };
  const pending = formStateFromBranch([question, aborted, trailing]).pending;
  assert.equal(pending?.id, "form-1");
  assert.equal(pending?.abortedResult, true);
  assert.deepEqual(pending?.followingCalls, [{ id: "later", name: "read" }]);
  assert.equal(formStateFromBranch([question, aborted, trailing,
    { type: "message", message: { role: "user", content: [{ type: "text", text: "new task" }] } }]).pending, null);
  assert.equal(formStateFromBranch([question, aborted, trailing,
    { type: "custom_message", customType: "pi-desktop-ui:form-outcome",
      details: { toolCallId: "form-1", status: "skipped" } }]).pending, null);
});

test("recovery selects the first unfinished call in a sequential batch", () => {
  const question = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "first", name: "request_form", arguments: form() },
    { type: "toolCall", id: "second", name: "request_form", arguments: form() },
  ] } };
  assert.equal(formStateFromBranch([question]).pending?.id, "first");
  const completed = { type: "message", message: { role: "toolResult", toolCallId: "first", isError: false,
    content: [{ type: "text", text: "submitted" }] } };
  assert.equal(formStateFromBranch([question, completed]).pending?.id, "second");
});
