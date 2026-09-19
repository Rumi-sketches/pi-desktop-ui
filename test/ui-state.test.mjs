import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatCache } from "../public/chat-cache.js";
import {
  ALL_TAB_ID,
  VIEW_CHAT,
  VIEW_SETTINGS,
  VIEW_TERMINAL,
  createUiState,
  RESPONSE_IDLE,
  RESPONSE_TEXT,
  RESPONSE_WAITING,
  normalizeChatMetrics,
  normalizeModelsPayload,
  normalizeQueuedPrompts,
  normalizeSearchPayload,
  normalizeSessionsPayload,
  normalizeStatePayload,
  normalizeTerminalsPayload,
  projectTabId,
} from "../public/ui-state.js";

const CHAT_A = "C:\\opaque\\sessions\\a.jsonl";
const CHAT_B = "draft:C:\\work\\beta";
const PROJECT_A = "C:\\work\\alpha";
const PROJECT_B = "C:\\work\\beta";

function statePayload(overrides = {}) {
  return {
    key: CHAT_A,
    sessionFile: CHAT_A,
    cwd: PROJECT_A,
    thinkingLevels: ["off", "high"],
    current: { provider: "openai", id: "gpt-test" },
    thinkingLevel: "high",
    totals: { input: 10, output: 5, cost: 0.02, requests: 1 },
    metrics: {
      total: { tokens: 18, input: 10, output: 5, cacheWrite: 1, cacheRead: 2, cost: 0.02, requests: 1 },
      byModel: {
        "openai/gpt-test": { tokens: 18, input: 10, output: 5, cacheWrite: 1, cacheRead: 2, cost: 0.02, requests: 1 },
      },
      sessionWork: null,
      context: { tokens: 15, contextWindow: 1000, percent: 1.5 },
    },
    streaming: false,
    awaitingInput: false,
    queuedPrompts: [],
    platform: {
      os: "win32",
      osName: "Windows",
      pickFolder: true,
      openFolder: true,
      openTerminal: true,
      typeInTerminal: true,
    },
    chatArchiving: true,
    ...overrides,
  };
}

function sessionsPayload() {
  return {
    current: CHAT_A,
    cwd: PROJECT_A,
    scope: "all",
    running: [CHAT_B],
    open: [CHAT_A, CHAT_B],
    sessions: [
      {
        path: CHAT_A,
        id: "a",
        cwd: PROJECT_A,
        name: "",
        firstMessage: "alpha",
        title: "Alpha",
        messageCount: 2,
        modified: "2026-09-07T08:00:00.000Z",
        favorite: false,
        status: "active",
        provider: "openai",
        model: "gpt-test",
        pullRequests: [{ number: 21, url: "https://github.com/Rumi-sketches/pi-desktop-ui/pull/21" }],
      },
      {
        path: CHAT_B,
        id: "b",
        cwd: PROJECT_B,
        name: "",
        firstMessage: "",
        title: "",
        messageCount: 0,
        modified: "2026-09-07T09:00:00.000Z",
        favorite: true,
        status: "reopened",
        provider: "",
        model: "",
      },
    ],
  };
}

function terminalsPayload() {
  return {
    terminals: [
      { id: "term-a", kind: "shell", cwd: PROJECT_A, createdAt: 1, chatKey: CHAT_A, exited: null },
      { id: "term-b", kind: "pi", cwd: PROJECT_B, createdAt: 2, chatKey: CHAT_B, exited: 0 },
    ],
  };
}

test("UI state keeps global, project, chat and terminal data in separate scopes", () => {
  const ui = createUiState();
  ui.applyStatePayload(statePayload());
  ui.applySessionsPayload(sessionsPayload());
  ui.applyTerminalsPayload(terminalsPayload());

  assert.deepEqual(ui.global.totals, { input: 10, output: 5, cost: 0.02, requests: 1 });
  assert.equal(ui.chatState(CHAT_A).model.id, "gpt-test");
  assert.equal(ui.chatState(CHAT_A).streaming, false);
  assert.equal(ui.terminals.get("term-a").chatKey, CHAT_A);
  assert.equal(ui.projects.get(projectTabId(PROJECT_B)).cwd, PROJECT_B);
  assert.equal(ui.chats.has("term-a"), false);
  assert.equal(ui.terminals.has(CHAT_A), false);
});

test("chat model, usage, started state and execution records never share owners", () => {
  const ui = createUiState();
  ui.applySessionsPayload(sessionsPayload());
  const alpha = ui.chatState(CHAT_A);
  const beta = ui.chatState(CHAT_B);

  alpha.metrics = statePayload().metrics;
  alpha.tasks.set("tool-a", { name: "bash", t0: 1, t1: null });
  alpha.agentTask = { name: "Agent", t0: 1, t1: null };
  beta.model = { provider: "anthropic", id: "beta-model" };

  assert.equal(alpha.started, true, "a persisted chat with messages is started");
  assert.equal(beta.started, false, "an empty draft remains mutable");
  assert.equal(beta.metrics, null);
  assert.equal(beta.tasks.size, 0);
  assert.equal(beta.agentTask, null);
  assert.equal(alpha.model.id, "gpt-test");
  assert.equal(beta.model.id, "beta-model");
});

test("selection is one discriminated view and each resource must belong to its tab", () => {
  const ui = createUiState();
  ui.applySessionsPayload(sessionsPayload());
  ui.applyTerminalsPayload(terminalsPayload());
  ui.replaceProjectTabs([PROJECT_A, PROJECT_B]);

  const tabA = projectTabId(PROJECT_A);
  const chatSelection = ui.select({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });
  assert.deepEqual(chatSelection, { tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });

  const terminalSelection = ui.select({ tabId: tabA, view: VIEW_TERMINAL, resourceId: "term-a" });
  assert.deepEqual(terminalSelection, { tabId: tabA, view: VIEW_TERMINAL, resourceId: "term-a" });
  assert.equal(ui.projects.get(tabA).lastSelection, terminalSelection);

  const settingsSelection = ui.select({ tabId: ALL_TAB_ID, view: VIEW_SETTINGS, resourceId: null });
  assert.deepEqual(settingsSelection, { tabId: ALL_TAB_ID, view: VIEW_SETTINGS, resourceId: null });

  assert.throws(
    () => ui.select({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A, terminalId: "term-a" }),
    /must contain only tabId, view and resourceId/,
  );
  assert.throws(
    () => ui.select({ tabId: tabA, view: VIEW_TERMINAL, resourceId: "term-b" }),
    /does not belong to tab/,
  );
  assert.throws(
    () => ui.select({ tabId: tabA, view: VIEW_SETTINGS, resourceId: CHAT_A }),
    /must be null for settings/,
  );
});

test("session keys stay opaque while transitions retain independent chat state", () => {
  const ui = createUiState();
  ui.applySessionsPayload(sessionsPayload());

  ui.chatState(CHAT_A).thinking = "high";
  ui.chatState(CHAT_B).thinking = "off";
  ui.select({ tabId: ALL_TAB_ID, view: VIEW_CHAT, resourceId: CHAT_A });
  ui.select({ tabId: ALL_TAB_ID, view: VIEW_CHAT, resourceId: CHAT_B });
  ui.select({ tabId: ALL_TAB_ID, view: VIEW_CHAT, resourceId: CHAT_A });

  assert.equal(ui.selection.resourceId, CHAT_A);
  assert.equal(ui.chatState(CHAT_A).thinking, "high");
  assert.equal(ui.chatState(CHAT_B).thinking, "off");
});

test("a persisted session clears its optimistic sidebar state", () => {
  const ui = createUiState();
  ui.chatState(CHAT_A).sidebarPending = true;

  ui.applySessionsPayload(sessionsPayload());

  assert.equal(ui.chatState(CHAT_A).sidebarPending, false);
});

test("chat rekey transfers the bounded per-chat view state", () => {
  const cache = createChatCache();
  const ui = createUiState({ chatCache: cache });
  ui.applySessionsPayload(sessionsPayload());
  const view = ui.chatViewState(CHAT_B);
  view.composer.draft = "draft text";
  view.composer.attachments.push({ kind: "image", data: "memory-only" });
  view.view.scrollTop = 71;

  const nextKey = "C:\\opaque\\sessions\\beta.jsonl";
  ui.rekeyChat(CHAT_B, nextKey);

  assert.equal(ui.chatViewState(nextKey), view);
  assert.equal(cache.peek(CHAT_B), null);
  assert.equal(view.composer.draft, "draft text");
  assert.equal(view.composer.attachments.length, 1);
  assert.equal(view.view.scrollTop, 71);
});

test("queue and response phase remain owned by one opaque chat key", () => {
  const ui = createUiState();
  ui.applyStatePayload(statePayload({
    key: CHAT_A,
    streaming: true,
    queuedPrompts: [{
      id: "opaque-a",
      type: "steer",
      text: "same",
      attachments: [{ mimeType: "image/png", bytes: 3 }],
      bytes: 7,
    }],
  }));
  ui.applyStatePayload(statePayload({
    key: CHAT_B,
    cwd: PROJECT_B,
    sessionFile: null,
    streaming: false,
    queuedPrompts: [{
      id: "opaque-b",
      type: "followUp",
      text: "same",
      attachments: [],
      bytes: 4,
    }],
  }));

  assert.equal(ui.chatState(CHAT_A).responsePhase, RESPONSE_WAITING);
  assert.deepEqual(ui.chatState(CHAT_A).queuedPrompts.map(({ id }) => id), ["opaque-a"]);
  assert.deepEqual(ui.chatState(CHAT_B).queuedPrompts.map(({ id }) => id), ["opaque-b"]);

  ui.markResponseText(CHAT_A);
  assert.equal(ui.chatState(CHAT_A).responsePhase, RESPONSE_TEXT);
  assert.equal(ui.chatState(CHAT_B).responsePhase, RESPONSE_IDLE);
  ui.finishResponse(CHAT_A);
  assert.equal(ui.chatState(CHAT_A).responsePhase, RESPONSE_IDLE);
});

test("state refresh preserves a known first-text phase but starts unknown active responses waiting", () => {
  const ui = createUiState();
  ui.applyStatePayload(statePayload({ streaming: true }));
  ui.markResponseText(CHAT_A);
  ui.applyStatePayload(statePayload({ streaming: true }));
  assert.equal(ui.chatState(CHAT_A).responsePhase, RESPONSE_TEXT);

  ui.finishResponse(CHAT_A);
  ui.applyStatePayload(statePayload({ streaming: true }));
  assert.equal(ui.chatState(CHAT_A).responsePhase, RESPONSE_WAITING);
});

test("state keeps an open turn distinct from a model waiting on a form", () => {
  const ui = createUiState();
  const payload = ui.applyStatePayload(statePayload({ streaming: true, awaitingInput: true }));

  assert.equal(payload.streaming, true);
  assert.equal(payload.awaitingInput, true);
  assert.equal(ui.chatState(CHAT_A).streaming, true);
  assert.equal(ui.chatState(CHAT_A).awaitingInput, true);

  ui.startResponse(CHAT_A);
  assert.equal(ui.chatState(CHAT_A).awaitingInput, false);
  ui.chatState(CHAT_A).awaitingInput = true;
  ui.finishResponse(CHAT_A);
  assert.equal(ui.chatState(CHAT_A).awaitingInput, false);
});

test("each response starts a fresh elapsed timer", () => {
  const ui = createUiState();
  const state = ui.chatState(CHAT_A);
  state.responseStartedAt = 1;
  state.responseActivityLabel = "Working";
  state.pendingAssistantMeta = { timestamp: "stale" };

  ui.startResponse(CHAT_A);

  assert.ok(state.responseStartedAt > 1);
  assert.equal(state.responseActivityLabel, null);
  assert.equal(state.pendingAssistantMeta, null);
});

test("queued prompt normalizer rejects invalid identity fields and strips attachment data", () => {
  const item = { id: "opaque", type: "steer", text: "x", attachments: [], bytes: 1 };
  assert.throws(() => normalizeQueuedPrompts([item, item]), /must be unique/);
  assert.throws(() => normalizeQueuedPrompts([{ ...item, type: "later" }]), /must be steer or followUp/);
  assert.deepEqual(normalizeQueuedPrompts([{ ...item, attachments: [{ mimeType: "image/png", bytes: 2, data: "hidden" }] }]), [{
    id: "opaque",
    type: "steer",
    text: "x",
    attachments: [{ mimeType: "image/png", bytes: 2 }],
    bytes: 1,
  }]);
});

test("chat metrics preserve nullable SDK context and validate the whole payload", () => {
  const unknown = normalizeChatMetrics({
    ...statePayload().metrics,
    context: { tokens: null, contextWindow: 200000, percent: null },
  });
  assert.deepEqual(unknown.context, { tokens: null, contextWindow: 200000, percent: null });
  assert.equal(unknown.total.tokens, 18, "cache buckets remain part of the SDK total");
  assert.throws(
    () => normalizeChatMetrics({ ...statePayload().metrics, context: { tokens: null, contextWindow: 1000, percent: 0 } }),
    /tokens and percent must both be known or both be null/,
  );
  assert.throws(
    () => normalizeChatMetrics({ ...statePayload().metrics, total: { ...statePayload().metrics.total, cacheRead: -1 } }),
    /must not be negative/,
  );
});

test("rapid state changes keep canonical metrics with their owning chat", () => {
  const ui = createUiState();
  const alphaMetrics = statePayload().metrics;
  const betaMetrics = {
    ...alphaMetrics,
    total: { ...alphaMetrics.total, tokens: 99 },
    context: null,
  };
  ui.applyStatePayload(statePayload({ key: CHAT_A, metrics: alphaMetrics }));
  ui.applyStatePayload(statePayload({ key: CHAT_B, cwd: PROJECT_B, sessionFile: null, metrics: betaMetrics }));

  assert.equal(ui.chatState(CHAT_A).metrics.total.tokens, 18);
  assert.equal(ui.chatState(CHAT_A).metrics.context.percent, 1.5);
  assert.equal(ui.chatState(CHAT_B).metrics.total.tokens, 99);
  assert.equal(ui.chatState(CHAT_B).metrics.context, null);
});

test("session and search payloads normalize pull request metadata at the boundary", () => {
  const normalized = normalizeSessionsPayload(sessionsPayload());
  assert.deepEqual(normalized.sessions[0].pullRequests, [
    { number: 21, url: "https://github.com/Rumi-sketches/pi-desktop-ui/pull/21" },
  ]);
  assert.deepEqual(normalized.sessions[1].pullRequests, []);

  const search = normalizeSearchPayload({
    query: "draft",
    cwd: PROJECT_A,
    scope: "all",
    scanned: 2,
    capped: false,
    truncated: false,
    sessions: sessionsPayload().sessions,
  });
  assert.equal(search.sessions[0].pullRequests[0].number, 21);
  assert.deepEqual(search.sessions[1].pullRequests, []);
});

test("API normalizers reject malformed state before it reaches a scope", () => {
  assert.throws(
    () => normalizeStatePayload(statePayload({ key: "" })),
    /state payload.key must be a non-empty string/,
  );
  assert.throws(
    () => normalizeStatePayload(statePayload({ thinkingLevel: "medium" })),
    /must occur in thinkingLevels/,
  );
  assert.throws(
    () => normalizeSessionsPayload({ ...sessionsPayload(), running: [null] }),
    /sessions payload.running\[0\] must be a non-empty string/,
  );
  assert.throws(
    () => normalizeSessionsPayload({
      ...sessionsPayload(),
      sessions: [{ ...sessionsPayload().sessions[0], status: "archived" }],
    }),
    /must be active, done or reopened/,
  );
  assert.throws(
    () => normalizeSessionsPayload({
      ...sessionsPayload(),
      sessions: [{ ...sessionsPayload().sessions[0], pullRequests: "#21" }],
    }),
    /pullRequests must be an array/,
  );
  assert.throws(
    () => normalizeSessionsPayload({
      ...sessionsPayload(),
      sessions: [{
        ...sessionsPayload().sessions[0],
        pullRequests: [{ number: 21, url: "javascript:alert(1)" }],
      }],
    }),
    /must identify the matching GitHub pull request/,
  );
  assert.throws(
    () => normalizeTerminalsPayload({ terminals: [{ ...terminalsPayload().terminals[0], kind: "bash" }] }),
    /must be pi or shell/,
  );
  assert.throws(
    () => normalizeModelsPayload({ current: null, thinkingLevel: "off", thinkingLevels: ["off"], models: [{ id: "missing-provider" }] }),
    /provider must be a non-empty string/,
  );
});
