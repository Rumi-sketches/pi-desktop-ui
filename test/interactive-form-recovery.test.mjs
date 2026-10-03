import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

const model = {
  id: "form-recovery-test", name: "Form recovery test", provider: "test", api: "openai-completions",
  baseUrl: "http://localhost/unused", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
};

function fakeResponse(content, stopReason) {
  const message = {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return {
    async *[Symbol.asyncIterator]() { yield { type: "done" }; },
    async result() { return message; },
  };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for form recovery test state");
}

test("a form aborted by server shutdown can be answered after reopening", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-form-recovery-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { startServer } = await import("../server.mjs");
  const { createContext, useContext } = await import("../src/chat/contexts.mjs");
  let server;
  try {
    server = await startServer({ port: 0 });
    const ctx = await createContext({ mode: "new", cwd: process.cwd() });
    ctx.session.agent.state.model = model;
    let initialCalls = 0;
    ctx.session.agent.streamFunction = async () => ++initialCalls === 1
      ? fakeResponse([{
        type: "toolCall", id: "form-after-restart", name: "request_form",
        arguments: { title: "Question", fields: [{ id: "color", label: "Color", type: "text", required: true }] },
      }, {
        type: "toolCall", id: "later-form", name: "request_form",
        arguments: { title: "Later", fields: [{ id: "name", label: "Name", type: "text" }] },
      }], "toolUse")
      : fakeResponse([], "aborted");
    const firstTurn = ctx.session.sendCustomMessage({
      customType: "test-prompt", content: [{ type: "text", text: "Ask a question" }], display: false,
    }, { triggerTurn: true }).catch(() => {});
    await until(() => ctx.forms.awaitingInput);
    const file = ctx.sessionFile;
    assert.ok(file);

    await server.stop();
    server = null;
    await firstTurn;
    assert.equal(initialCalls, 1, "shutdown must not start another provider request");
    const stopped = await readFile(file, "utf8");
    assert.match(stopped, /"status":"interrupted"/);

    server = await startServer({ port: 0 });
    const reopened = await useContext(file);
    assert.equal(reopened.forms.isPending("form-after-restart"), true);
    reopened.session.agent.state.model = model;
    let received = null;
    reopened.session.agent.streamFunction = async (_model, context) => {
      received = context.messages;
      return fakeResponse([{ type: "text", text: "Thanks for answering." }], "stop");
    };
    let base = server.url.replace(/\/$/, "");
    const query = `?s=${encodeURIComponent(file)}`;
    const historyBefore = await (await fetch(`${base}/api/history${query}`)).json();
    const cardBefore = historyBefore.messages.flatMap((message) => message.blocks)
      .find((block) => block.id === "form-after-restart");
    assert.equal(historyBefore.awaitingInput, true);
    assert.equal(historyBefore.streaming, false);
    assert.equal(cardBefore?.status, "start");
    assert.equal(cardBefore?.isError, false);
    const laterCard = historyBefore.messages.flatMap((message) => message.blocks)
      .find((block) => block.id === "later-form");
    assert.equal(laterCard?.status, "end");
    assert.equal(laterCard?.isError, true);

    const invalid = await fetch(`${base}/api/forms/form-after-restart/respond${query}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ values: { unknown: "bad answer" } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "invalid_form_response");
    assert.equal(reopened.forms.isPending("form-after-restart"), true);
    const responses = await Promise.all(["blue", "red"].map((color) => fetch(`${base}/api/forms/form-after-restart/respond${query}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ values: { color } }),
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const acceptedValues = (await responses.find((response) => response.status === 200).json()).values;
    assert.equal((await responses.find((response) => response.status === 409).json()).error.code, "form_not_pending");
    await until(() => received !== null);
    assert.ok(received.at(-1).content[0].text.includes(JSON.stringify(acceptedValues)));
    assert.equal(received.filter((message) => message.role === "toolResult"
      && message.toolCallId === "form-after-restart").length, 1);
    assert.equal(received.filter((message) => message.role === "toolResult" && message.toolCallId === "later-form").length, 1);
    await reopened.session.waitForIdle();

    const historyAfter = await (await fetch(`${base}/api/history${query}`)).json();
    const cardAfter = historyAfter.messages.flatMap((message) => message.blocks)
      .find((block) => block.id === "form-after-restart");
    assert.equal(historyAfter.awaitingInput, false);
    assert.equal(cardAfter.status, "end");
    assert.equal(JSON.parse(cardAfter.output).status, "submitted");
    assert.equal(cardAfter.isError, false);
    const persisted = await readFile(file, "utf8");
    assert.match(persisted, /pi-desktop-ui:form-outcome/);

    const live = await createContext({ mode: "new", cwd: process.cwd() });
    live.session.agent.state.model = model;
    let liveCalls = 0;
    live.session.agent.streamFunction = async () => fakeResponse([{
      type: "toolCall", id: `live-form-${++liveCalls}`, name: "request_form",
      arguments: { title: "Question", fields: [{ id: "color", label: "Color", type: "text" }] },
    }], "toolUse");
    for (let turn = 1; turn <= 2; turn++) {
      const run = live.session.sendCustomMessage({
        customType: "test-prompt", content: [{ type: "text", text: `Ask question ${turn}` }], display: false,
      }, { triggerTurn: true });
      await until(() => live.forms.isPending(`live-form-${turn}`));
      for (const type of ["steer", "followUp"]) {
        const queued = await fetch(`${base}/api/prompt?s=${encodeURIComponent(live.key)}`, {
          method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ text: "This queued instruction must not run", type }),
        });
        assert.equal(queued.status, 202);
      }
      const route = turn === 1 ? `/api/forms/live-form-${turn}/skip` : "/api/abort";
      const skipped = await fetch(`${base}${route}?s=${encodeURIComponent(live.key)}`, {
        method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(skipped.status, 200);
      await run;
      assert.equal(liveCalls, turn, "skipping must not request another provider response");
      assert.deepEqual(live.promptQueue.publicItems(), []);
      const liveHistory = await (await fetch(`${base}/api/history?s=${encodeURIComponent(live.key)}`)).json();
      const card = liveHistory.messages.flatMap((message) => message.blocks)
        .find((block) => block.id === `live-form-${turn}`);
      assert.equal(JSON.parse(card.output).status, "skipped");
    }

    const deferred = await createContext({ mode: "new", cwd: process.cwd() });
    deferred.session.agent.state.model = model;
    let deferredCalls = 0;
    deferred.session.agent.streamFunction = async () => {
      deferredCalls++;
      return fakeResponse([{ type: "toolCall", id: "deferred-form", name: "request_form",
        arguments: { title: "Question", fields: [{ id: "color", label: "Color", type: "text" }] } }], "toolUse");
    };
    const deferredRun = deferred.session.sendCustomMessage({
      customType: "test-prompt", content: [{ type: "text", text: "Ask one more question" }], display: false,
    }, { triggerTurn: true });
    await until(() => deferred.forms.awaitingInput);
    const deferredFile = deferred.sessionFile;
    await server.stop();
    server = null;
    await deferredRun;
    assert.equal(deferredCalls, 1);

    server = await startServer({ port: 0 });
    base = server.url.replace(/\/$/, "");
    const deferredQuery = `?s=${encodeURIComponent(deferredFile)}`;
    const skippedAfterRestart = await fetch(`${base}/api/forms/deferred-form/skip${deferredQuery}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(skippedAfterRestart.status, 200);
    assert.equal(deferredCalls, 1, "skipping a restored form must not call a provider");
    await server.stop();
    server = null;

    server = await startServer({ port: 0 });
    base = server.url.replace(/\/$/, "");
    const skippedHistory = await (await fetch(`${base}/api/history${deferredQuery}`)).json();
    const skippedCard = skippedHistory.messages.flatMap((message) => message.blocks)
      .find((block) => block.id === "deferred-form");
    assert.equal(skippedHistory.awaitingInput, false);
    assert.equal(skippedCard.status, "end");
    assert.equal(JSON.parse(skippedCard.output).status, "skipped");

    // A crash can leave a persisted assistant call with no tool result at all.
    const missing = await createContext({ mode: "new", cwd: process.cwd() });
    missing.session.sessionManager.appendMessage(await fakeResponse([{
      type: "toolCall", id: "missing-form", name: "request_form",
      arguments: { title: "Unsaved answer", fields: [{ id: "color", label: "Color", type: "text" }] },
    }, {
      type: "toolCall", id: "unexecuted-read", name: "read", arguments: { path: "package.json" },
    }], "toolUse").result());
    const missingFile = missing.session.sessionManager.getSessionFile();
    await server.stop();
    server = null;
    server = await startServer({ port: 0 });
    base = server.url.replace(/\/$/, "");
    const restoredMissing = await useContext(missingFile);
    restoredMissing.session.agent.state.model = model;
    let missingCalls = 0;
    let restoredMessages;
    restoredMissing.session.agent.streamFunction = async (_model, context) => {
      missingCalls++;
      restoredMessages = context.messages;
      return fakeResponse([{ type: "text", text: "Recovered." }], "stop");
    };
    const answeredMissing = await fetch(`${base}/api/forms/missing-form/respond?s=${encodeURIComponent(missingFile)}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ values: { color: "green" } }),
    });
    assert.equal(answeredMissing.status, 200);
    await until(() => missingCalls === 1);
    await restoredMissing.session.waitForIdle();
    for (const id of ["missing-form", "unexecuted-read"]) {
      assert.equal(restoredMessages.filter((message) => message.role === "toolResult" && message.toolCallId === id).length, 1);
    }
    assert.equal(restoredMessages.find((message) => message.toolCallId === "unexecuted-read").isError, true);
    const missingHistory = await (await fetch(`${base}/api/history?s=${encodeURIComponent(missingFile)}`)).json();
    const missingCard = missingHistory.messages.flatMap((message) => message.blocks).find((block) => block.id === "missing-form");
    assert.equal(missingCard.status, "end");
    assert.deepEqual(JSON.parse(missingCard.output), { status: "submitted", values: { color: "green" } });
  } finally {
    await server?.stop();
    await rm(agentDir, { recursive: true, force: true });
  }
});
