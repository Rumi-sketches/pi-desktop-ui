import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_TAB_ID,
  VIEW_CHAT,
  VIEW_SETTINGS,
  VIEW_TERMINAL,
  createUiState,
  projectTabId,
} from "../public/ui-state.js";
import {
  chatHeaderState,
  createNavigationController,
  createNavigationSynchronizer,
  terminalHeaderState,
} from "../public/navigation.js";
import { createTransport } from "../public/transport.js";

const PROJECT_A = "C:\\work\\alpha";
const PROJECT_B = "C:\\work\\beta";
const CHAT_A = "C:\\sessions\\alpha.jsonl";
const CHAT_ALL = "C:\\sessions\\other.jsonl";
const TERMINAL_B = "terminal-beta";

function fixture() {
  const state = createUiState();
  state.replaceProjectTabs([PROJECT_A, PROJECT_B]);
  Object.assign(state.chatState(CHAT_A), { cwd: PROJECT_A });
  Object.assign(state.chatState(CHAT_ALL), { cwd: "C:\\work\\other" });
  state.terminals.set(TERMINAL_B, {
    id: TERMINAL_B,
    kind: "shell",
    cwd: PROJECT_B,
    createdAt: 1,
    chatKey: null,
    exited: null,
  });
  const available = new Set([CHAT_A, CHAT_ALL, TERMINAL_B]);
  const snapshots = [];
  const navigation = createNavigationController({
    state,
    isAvailable: ({ view, resourceId }) => view === VIEW_SETTINGS || available.has(resourceId),
    onTransition: (selection) => {
      snapshots.push({
        tabId: selection.tabId,
        headerView: selection.view,
        activeResource: selection.resourceId,
      });
    },
  });
  const tabA = projectTabId(PROJECT_A);
  const tabB = projectTabId(PROJECT_B);
  const fallback = (tabId) => tabId === tabA
    ? { tabId, view: VIEW_CHAT, resourceId: CHAT_A }
    : tabId === tabB
      ? { tabId, view: VIEW_TERMINAL, resourceId: TERMINAL_B }
      : { tabId, view: VIEW_CHAT, resourceId: CHAT_ALL };
  return { state, navigation, available, snapshots, fallback, tabA, tabB };
}

test("chat header and folder controls come only from the selected chat", () => {
  const selection = { tabId: projectTabId(PROJECT_A), view: VIEW_CHAT, resourceId: CHAT_A };
  const chat = {
    key: CHAT_A,
    cwd: PROJECT_A,
    started: false,
    model: { provider: "openai", id: "alpha-model" },
    metrics: {
      total: { tokens: 30, input: 12, output: 8, cacheRead: 10, cacheWrite: 0, cost: 0.03, requests: 1 },
      byModel: { "openai/alpha-model": { tokens: 30, input: 12, output: 8, cacheRead: 10, cacheWrite: 0, cost: 0.03, requests: 1 } },
      sessionWork: null,
      context: { tokens: 20, contextWindow: 100, percent: 20 },
    },
    streaming: false,
  };
  const session = { path: CHAT_A, title: "Alpha chat", messageCount: 0 };

  assert.deepEqual(chatHeaderState(selection, chat, session, { canOpenFolder: true }), {
    key: CHAT_A,
    cwd: PROJECT_A,
    folder: "alpha",
    title: "Alpha chat",
    started: false,
    canChangeFolder: true,
    canOpenFolder: true,
    model: chat.model,
    metrics: chat.metrics,
    streaming: false,
  });
  assert.equal(
    chatHeaderState(selection, { ...chat, key: CHAT_ALL }, session),
    null,
    "metadata from another chat must not enter the header",
  );
  assert.equal(
    chatHeaderState(selection, { ...chat, started: true }, session).canChangeFolder,
    false,
    "started chats must hide mutable folder controls",
  );
  assert.equal(
    chatHeaderState(selection, chat, { ...session, messageCount: 1 }).canChangeFolder,
    false,
    "persisted history also freezes folder controls",
  );
  assert.equal(
    chatHeaderState({ ...selection, view: VIEW_TERMINAL }, chat, session),
    null,
  );
});

test("terminal header metadata comes only from the selected terminal", () => {
  const terminal = {
    id: TERMINAL_B,
    kind: "shell",
    cwd: PROJECT_B,
    createdAt: 1,
    chatKey: CHAT_A,
    exited: null,
  };
  const selected = { tabId: projectTabId(PROJECT_B), view: VIEW_TERMINAL, resourceId: TERMINAL_B };

  assert.deepEqual(terminalHeaderState(selected, terminal, {
    canOpenFolder: true,
    canCopyPath: true,
  }), {
    id: TERMINAL_B,
    cwd: PROJECT_B,
    folder: "beta",
    kind: "PowerShell",
    status: "Running",
    running: true,
    canOpenFolder: true,
    canCopyPath: true,
  });
  assert.equal(
    terminalHeaderState({ tabId: selected.tabId, view: VIEW_CHAT, resourceId: CHAT_A }, terminal),
    null,
    "a chat selection must not retain terminal metadata",
  );
  assert.equal(
    terminalHeaderState(selected, { ...terminal, id: "another-terminal" }),
    null,
    "metadata from another terminal must not enter the header",
  );
  assert.equal(terminalHeaderState(selected, { ...terminal, exited: 7 }).status, "Exited (7)");
});

test("project tabs and All restore independent chat, terminal and settings views", () => {
  const { state, navigation, fallback, tabA, tabB } = fixture();

  navigation.switchTab(tabA, fallback);
  navigation.switchTab(tabB, fallback);
  navigation.settings(ALL_TAB_ID);
  navigation.switchTab(tabA, fallback);
  assert.deepEqual(state.selection, { tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });

  navigation.switchTab(tabB, fallback);
  assert.deepEqual(state.selection, { tabId: tabB, view: VIEW_TERMINAL, resourceId: TERMINAL_B });

  navigation.switchTab(ALL_TAB_ID, fallback);
  assert.deepEqual(state.selection, { tabId: ALL_TAB_ID, view: VIEW_SETTINGS, resourceId: null });
});

test("cached chat renders synchronously before its scoped background synchronization", async () => {
  const { state, navigation, fallback, tabA } = fixture();
  const cached = { html: "cached alpha" };
  state.chatCache.saveView(CHAT_A, { scrollTop: 173, snapshot: cached });
  const events = [];
  const synchronizer = createNavigationSynchronizer({
    showCachedChat: (key) => {
      const entry = state.chatViewState(key);
      events.push(["visible", state.chatCache.takeSnapshot(key), entry.view.scrollTop]);
    },
    syncSessions: ({ key }) => { events.push(["sessions", key]); },
    syncChat: ({ key }) => { events.push(["chat", key]); },
    syncProject: ({ key, projectCwd }) => { events.push(["project", key, projectCwd]); },
  });

  const ticket = navigation.switchTab(tabA, fallback);
  synchronizer.show(ticket.selection);
  const syncing = synchronizer.synchronize(ticket, PROJECT_A);

  assert.deepEqual(events, [["visible", cached, 173]], "cached DOM and scroll are visible before a request starts");
  await syncing;
  assert.deepEqual(events.slice(1), [
    ["sessions", CHAT_A],
    ["chat", CHAT_A],
    ["project", CHAT_A, PROJECT_A],
  ]);
});

test("global catalogs and project refresh data remain in their owner scopes across switches", () => {
  const { state, navigation, fallback, tabA, tabB } = fixture();
  state.applyModelsPayload({
    current: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    models: [{ provider: "openai", id: "global-model" }],
  });
  state.applyCommandsPayload({
    commands: [{ name: "global-command", description: "", source: "extension" }],
  });
  state.projectState(PROJECT_A).files = [{ path: "alpha.txt", changes: 1 }];
  state.projectState(PROJECT_B).files = [{ path: "beta.txt", changes: 2 }];

  navigation.switchTab(tabA, fallback);
  navigation.switchTab(tabB, fallback);
  navigation.switchTab(tabA, fallback);

  assert.equal(state.global.models[0].id, "global-model");
  assert.equal(state.global.commands[0].name, "global-command");
  assert.equal(state.projectState(PROJECT_A).files[0].path, "alpha.txt");
  assert.equal(state.projectState(PROJECT_B).files[0].path, "beta.txt");
  assert.notEqual(state.projectState(PROJECT_A), state.projectState(PROJECT_B));
});

test("a stale asynchronous transition cannot overwrite a newer selection", () => {
  const { state, navigation, snapshots, tabA, tabB } = fixture();
  const slow = navigation.begin();
  const fast = navigation.transition({ tabId: tabB, view: VIEW_TERMINAL, resourceId: TERMINAL_B });

  assert.equal(slow.signal.aborted, true, "a newer navigation aborts the work owned by the old one");
  assert.equal(navigation.commit({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A }, slow), null);
  assert.equal(navigation.isCurrent(fast), true);
  assert.deepEqual(state.selection, { tabId: tabB, view: VIEW_TERMINAL, resourceId: TERMINAL_B });
  assert.deepEqual(snapshots.at(-1), {
    tabId: tabB,
    headerView: VIEW_TERMINAL,
    activeResource: TERMINAL_B,
  });
});

test("an unavailable remembered resource uses the deterministic tab fallback", () => {
  const { state, navigation, available, fallback, tabA } = fixture();
  navigation.transition({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });
  available.delete(CHAT_A);

  const ticket = navigation.switchTab(tabA, () => ({
    tabId: tabA,
    view: VIEW_SETTINGS,
    resourceId: null,
  }));

  assert.deepEqual(ticket.selection, { tabId: tabA, view: VIEW_SETTINGS, resourceId: null });
  assert.equal(state.projects.get(tabA).lastSelection, ticket.selection);
  assert.equal(navigation.switchTab(tabA, fallback).selection.view, VIEW_SETTINGS);
});

test("closing an inactive tab preserves the active chat request ticket", () => {
  const { state, navigation, fallback, tabA, tabB } = fixture();
  const active = navigation.switchTab(tabA, fallback);
  navigation.closeTab({
    tabId: tabB, projectCwds: [PROJECT_A], landingTabId: tabA, fallback,
  });
  assert.equal(active.signal.aborted, false);
  assert.equal(navigation.isCurrent(active), true);
  assert.equal(state.selection.resourceId, CHAT_A);
  assert.equal(state.projects.has(tabB), false);
});

test("closing the active tab lands once on the chosen tab and preserves other memories", () => {
  const { state, navigation, fallback, tabA, tabB } = fixture();
  navigation.switchTab(tabA, fallback);
  navigation.switchTab(tabB, fallback);

  const ticket = navigation.closeTab({
    tabId: tabB,
    projectCwds: [PROJECT_A],
    landingTabId: tabA,
    fallback,
  });

  assert.equal(state.projects.has(tabB), false);
  assert.deepEqual(ticket.selection, { tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });
  assert.equal(state.activeTabId, tabA);
});

test("chat rekey updates every tab memory that points at the opaque key", () => {
  const { state, navigation, fallback, tabA } = fixture();
  const nextKey = "C:\\sessions\\alpha-rekeyed.jsonl";
  navigation.switchTab(tabA, fallback);
  navigation.transition({ tabId: ALL_TAB_ID, view: VIEW_CHAT, resourceId: CHAT_A });

  state.rekeyChat(CHAT_A, nextKey);

  assert.equal(state.projects.get(tabA).lastSelection.resourceId, nextKey);
  assert.equal(state.projects.get(ALL_TAB_ID).lastSelection.resourceId, nextKey);
  assert.equal(state.selection.resourceId, nextKey);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a completed response keeps its original opaque key and is stale after a rapid switch", async () => {
  const body = deferred();
  const calls = [];
  const transport = createTransport({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: () => body.promise };
    },
  });
  const { navigation, tabA, tabB } = fixture();
  const slow = navigation.transition({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });
  const pending = transport.request("/api/history", {}, {
    sessionKey: CHAT_A,
    navigationRevision: slow.revision,
    isCurrent: () => navigation.isCurrent(slow),
  });

  navigation.transition({ tabId: tabB, view: VIEW_TERMINAL, resourceId: TERMINAL_B });
  body.resolve({ messages: ["belongs to A"] });
  const result = await pending;

  assert.equal(calls[0], `/api/history?s=${encodeURIComponent(CHAT_A)}`);
  assert.equal(result.owner.sessionKey, CHAT_A);
  assert.equal(result.stale, true);
});

test("a navigation request is aborted when a newer switch begins", async () => {
  const transport = createTransport({
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const { navigation, tabA, tabB } = fixture();
  const slow = navigation.transition({ tabId: tabA, view: VIEW_CHAT, resourceId: CHAT_A });
  const pending = transport.request("/api/state", {}, {
    sessionKey: CHAT_A,
    navigationRevision: slow.revision,
    signal: slow.signal,
    isCurrent: () => navigation.isCurrent(slow),
  });

  navigation.transition({ tabId: tabB, view: VIEW_TERMINAL, resourceId: TERMINAL_B });

  assert.equal((await pending).aborted, true);
});

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(event) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

test("one detailed SSE follows the active chat and ignores replay from the closed stream", () => {
  const sources = [];
  const received = [];
  const transport = createTransport({
    fetchImpl: async () => {},
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });

  const first = transport.followDetailed(CHAT_A, { onEvent: (event, owner) => { received.push([owner.sessionKey, event.kind]); } });
  assert.equal(transport.followDetailed(CHAT_A), first, "following the same chat must not duplicate its stream");
  transport.followDetailed(CHAT_ALL, { onEvent: (event, owner) => { received.push([owner.sessionKey, event.kind]); } });
  sources[0].emit({ kind: "text", key: CHAT_A, delta: "late" });
  sources[1].emit({ kind: "attached", key: CHAT_ALL });

  assert.equal(sources.length, 2);
  assert.equal(sources[0].closed, true);
  assert.equal(sources[1].url, `/api/events?s=${encodeURIComponent(CHAT_ALL)}`);
  assert.deepEqual(received, [[CHAT_ALL, "attached"]]);
});

test("SSE rekey routes later events through the new opaque key without reconnecting", () => {
  const received = [];
  const transport = createTransport({
    fetchImpl: async () => {},
    createEventSource: (url) => new FakeEventSource(url),
  });
  const source = transport.followDetailed(CHAT_A, {
    onEvent: (event, owner) => { received.push([owner.sessionKey, event.key]); },
  });
  const nextKey = "draft:not/a/path:still-opaque";

  source.emit({ kind: "rekey", key: nextKey });
  assert.equal(transport.rekeyDetailed(CHAT_A, nextKey), true);
  source.emit({ kind: "status", key: nextKey, status: "idle" });

  assert.deepEqual(received, [[CHAT_A, nextKey], [nextKey, nextKey]]);
  assert.equal(transport.detailedSessionKey(), nextKey);
});
