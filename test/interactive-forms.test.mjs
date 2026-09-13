import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractiveFormBroker,
  createInteractiveFormTool,
  normalizeFormRequest,
  normalizeFormResponse,
} from "../interactive-forms.mjs";

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

test("the tool advertises the native form capability to the model", () => {
  const tool = createInteractiveFormTool(new InteractiveFormBroker());
  assert.equal(tool.name, "request_form");
  assert.match(tool.promptSnippet, /fillable form/);
  assert.equal(tool.executionMode, "sequential");
});
