import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatForms,
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

function formsFixture(branch = []) {
  const events = [];
  const activity = [];
  const persisted = [];
  const continuations = [];
  const queued = ["steer", "followUp"];
  const ctx = {
    promptStarting: false, running: false, runStartedAt: null,
    promptQueue: { clear() { queued.length = 0; } },
    session: {
      sessionManager: { appendMessage(message) { persisted.push(message); } },
      agent: { state: { messages: [] } },
      async sendCustomMessage(message, options) { continuations.push({ message, options }); },
      async waitForIdle() {},
      async abort() {},
    },
  };
  const forms = createChatForms({
    sessionManager: { getBranch: () => branch }, getContext: () => ctx,
    emit: (event) => events.push(event),
    emitActivity: (running, paused = false) => activity.push({ running, paused }),
  });
  return { forms, ctx, events, activity, persisted, continuations, queued };
}

function recoveredBranch({ interrupted = false } = {}) {
  const branch = /** @type {any[]} */ ([{ type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "recovered", name: "request_form", arguments: form() },
    { type: "toolCall", id: "later", name: "read", arguments: { path: "package.json" } },
  ] } }]);
  if (interrupted) branch.push({ type: "message", message: {
    role: "toolResult", toolCallId: "recovered", content: [{ type: "text", text: "form request aborted" }],
  } });
  return branch;
}

const validValues = () => ({ name: "Studio", platform: "web", features: [], approved: true });

test("a live form accepts one valid response and rejects invalid or late answers", async () => {
  const { forms } = formsFixture();
  const waiting = forms.tool.execute("call-1", form(), undefined, undefined, undefined);
  assert.throws(() => forms.submit("call-1", {}), { code: "invalid_form_response", status: 400 });
  assert.equal(forms.isPending("call-1"), true);
  assert.deepEqual(forms.submit("call-1", validValues()), validValues());
  assert.throws(() => forms.submit("call-1", validValues()), { code: "form_not_pending", status: 409 });
  const result = await waiting;
  const content = result.content[0];
  assert.equal(content.type, "text");
  if (content.type === "text") assert.deepEqual(JSON.parse(content.text), { status: "submitted", values: validValues() });
});

test("aborting the tool execution removes its pending form", async () => {
  const { forms } = formsFixture();
  const controller = new AbortController();
  const waiting = forms.tool.execute("call-2", form(), controller.signal, undefined, undefined);
  controller.abort();
  await assert.rejects(waiting, /form request aborted/);
  assert.equal(forms.awaitingInput, false);
  assert.throws(() => forms.submit("call-2", {}), { code: "form_not_pending" });
});

test("the form module reports input ownership only while a form awaits it", async () => {
  const { forms } = formsFixture();
  assert.equal(forms.awaitingInput, false);
  const waiting = forms.tool.execute("call-waiting", form(), undefined, undefined, undefined);
  assert.equal(forms.awaitingInput, true);
  forms.submit("call-waiting", validValues());
  await waiting;
  assert.equal(forms.awaitingInput, false);
});

test("the module provides the native sequential form tool", () => {
  const { tool } = formsFixture().forms;
  assert.equal(tool.name, "request_form");
  assert.match(tool.promptSnippet, /fillable form/);
  assert.equal(tool.executionMode, "sequential");
});

test("tool announcements own input before execute and release it at tool end", () => {
  const { forms, ctx, activity } = formsFixture();
  ctx.running = true;
  forms.onSessionEvent({ type: "tool_execution_start", toolName: "request_form", toolCallId: "announced" });
  assert.equal(forms.awaitingInput, true);
  assert.equal(forms.isPending("announced"), true);
  assert.equal(forms.paused, true);
  assert.throws(() => forms.submit("announced", validValues()), { code: "form_not_pending" });
  forms.onSessionEvent({ type: "tool_execution_end", toolName: "request_form", toolCallId: "announced",
    result: { details: { status: "submitted" } } });
  assert.equal(forms.awaitingInput, false);
  assert.equal(forms.isPending("announced"), false);
  assert.deepEqual(activity, [{ running: false, paused: true }, { running: true, paused: false }]);
  forms.onSessionEvent({ type: "tool_execution_start", toolName: "request_form", toolCallId: "next" });
  forms.onSessionEvent({ type: "agent_settled" });
  assert.equal(forms.isPending("next"), false);
  assert.equal(forms.paused, false);
});

for (const interrupted of [false, true]) {
  test(`recovery consumes one answer and repairs its batch (${interrupted ? "interrupted" : "missing result"})`, async () => {
    const { forms, ctx, persisted, continuations } = formsFixture(recoveredBranch({ interrupted }));
    assert.equal(forms.recoveryPending, true);
    assert.throws(() => forms.submit("recovered", {}), { code: "invalid_form_response" });
    assert.equal(forms.isPending("recovered"), true);
    forms.submit("recovered", validValues());
    assert.equal(forms.isPending("recovered"), false);
    assert.equal(ctx.promptStarting, true);
    assert.throws(() => forms.submit("recovered", validValues()), { code: "form_not_pending" });
    await assert.rejects(forms.skip("recovered"), { code: "form_not_pending" });
    assert.deepEqual(persisted.map((message) => message.toolCallId), interrupted ? ["later"] : ["recovered", "later"]);
    assert.deepEqual(ctx.session.agent.state.messages, persisted);
    assert.equal(persisted.at(-1).isError, true);
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0].options.triggerTurn, true);
    assert.deepEqual(continuations[0].message.details,
      { toolCallId: "recovered", status: "submitted", values: validValues() });
  });
}

test("a failure before restoring the first result releases the claim and permits retry", () => {
  const { forms, ctx, continuations } = formsFixture(recoveredBranch());
  const append = ctx.session.sessionManager.appendMessage;
  ctx.session.sessionManager.appendMessage = () => { throw new Error("write failed before append"); };
  assert.throws(() => forms.submit("recovered", validValues()), /write failed before append/);
  assert.equal(forms.awaitingInput, true);
  assert.equal(forms.recoveryPending, true);
  assert.equal(ctx.promptStarting, false);
  assert.equal(ctx.runStartedAt, null);
  assert.equal(continuations.length, 0);
  ctx.session.sessionManager.appendMessage = append;
  forms.submit("recovered", validValues());
  assert.equal(continuations.length, 1);
});

test("skipping a recovered form repairs the exchange without starting a model turn", async () => {
  const { forms, persisted, continuations } = formsFixture(recoveredBranch());
  await forms.skip("recovered");
  assert.equal(forms.recoveryPending, false);
  assert.deepEqual(persisted.map((message) => message.toolCallId), ["recovered", "later"]);
  assert.deepEqual(persisted[0].details, { status: "skipped" });
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].options, undefined);
  await assert.rejects(forms.skip("recovered"), { code: "form_not_pending" });
});

for (const action of ["skip", "abort"]) {
  test(`${action} clears queued prompts before the waiting tool resumes`, async () => {
    const { forms, queued, activity } = formsFixture();
    const waiting = forms.tool.execute("skip-live", form(), undefined, undefined, undefined).then((result) => {
      assert.deepEqual(queued, []);
      return result;
    });
    if (action === "skip") await forms.skip("skip-live");
    else await forms.abort();
    assert.deepEqual((await waiting).details, { status: "skipped" });
    assert.equal(forms.paused, true);
    forms.onSessionEvent({ type: "agent_settled" });
    assert.equal(forms.paused, false);
    assert.deepEqual(activity.at(-1), { running: false, paused: true });
    const next = forms.tool.execute("next", form(), undefined, undefined, undefined);
    forms.submit("next", validValues());
    assert.deepEqual((await next).details, { status: "submitted", values: validValues() });
  });
}

test("shutdown interrupts a waiting form before aborting its session", async () => {
  const { forms, ctx } = formsFixture();
  const waiting = forms.tool.execute("shutdown", form(), undefined, undefined, undefined);
  ctx.session.abort = async () => { assert.equal(forms.awaitingInput, false); };
  await forms.shutdown();
  assert.deepEqual((await waiting).details, { status: "interrupted" });
  assert.equal((await waiting).terminate, true);
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
