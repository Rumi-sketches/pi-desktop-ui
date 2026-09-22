import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createChatCache } from '../public/chat-cache.js';
import { createDraftStorage } from '../public/draft-storage.js';
import { createUiState, projectTabId, VIEW_CHAT, VIEW_TERMINAL, VIEW_SETTINGS } from '../public/ui-state.js';
import { createNavigationController } from '../public/navigation.js';
import { createTransport } from '../public/transport.js';

const [source, indexSource, cssSource] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
]);
function appFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}\\r?$`, 'm'));
  assert.ok(match, `app function ${name} exists`);
  return match[0];
}

test('sidebar derives local drafts and accepted first prompts from the cache owner', () => {
  const chatCache = createChatCache();
  const uiState = createUiState({ chatCache });
  uiState.chatState('saved').cwd = 'project';
  const local = uiState.chatState('local');
  local.cwd = 'project';
  chatCache.setDraft('saved', 'unsent addition');
  chatCache.setDraft('local', 'Draft a release note', { metadata: {
    cwd: 'project', title: 'Draft a release note',
    modified: '2026-09-19T10:00:00.000Z', pending: false,
  } });
  const allSessions = [{ path: 'saved', title: 'Saved chat' }];
  const context = vm.createContext({ uiState, chatCache, allSessions });
  for (const name of ['draftTitle', 'localSessionEntry', 'sidebarSessions']) {
    vm.runInContext(appFunction(name), context);
  }

  let sessions = context.sidebarSessions();
  assert.deepEqual([...sessions.map((session) => session.path)], ['saved', 'local']);
  assert.equal(sessions[1].local, true);
  assert.equal(sessions[1].title, 'Draft a release note');

  local.started = true;
  chatCache.setDraft('local', '', { metadata: {
    cwd: 'project', title: 'Accepted prompt',
    modified: '2026-09-19T10:00:00.000Z', pending: true,
  } });
  sessions = context.sidebarSessions();
  assert.equal(sessions.some((session) => session.path === 'local'), true, 'accepted prompt remains optimistic');

  allSessions.push({ path: 'local', title: 'Persisted chat' });
  sessions = context.sidebarSessions();
  assert.equal(sessions.filter((session) => session.path === 'local').length, 1, 'server entry replaces local projection');
});

test('cache-owned metadata restores local chat identity without restoring attachments', () => {
  const values = new Map([
    ['piComposerDrafts', JSON.stringify({ hidden: 'keep me' })],
    ['piComposerDraftMeta', JSON.stringify({
      hidden: { cwd: 'other-project', title: 'Keep me', modified: '2026-09-19T09:00:00.000Z', pending: false },
      accepted: { cwd: 'pending-project', title: 'Accepted prompt', modified: '2026-09-19T09:30:00.000Z', pending: true },
    })],
  ]);
  const draftStorage = createDraftStorage({ storage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  const chatCache = createChatCache({ draftStorage });
  const restored = createUiState({ chatCache });

  assert.equal(restored.chatState('hidden').cwd, 'other-project');
  assert.equal(restored.chatState('accepted').started, true, 'accepted prompt survives without draft text');
  assert.deepEqual(restored.chatViewState('hidden').composer.attachments, []);
});

test('accepted first prompt keeps its pending sidebar projection when its text is cleared', () => {
  const chatCache = createChatCache();
  const uiState = createUiState({ chatCache });
  uiState.chatState('draft-key').cwd = 'project';
  const entry = chatCache.setDraft('draft-key', 'Accepted prompt', { metadata: {
    cwd: 'project', title: 'Accepted prompt',
    modified: '2026-09-19T10:00:00.000Z', pending: true,
  } });
  const context = vm.createContext({ chatCache, uiState, activeChatKey: () => null });
  vm.runInContext(appFunction('draftTitle'), context);
  vm.runInContext(appFunction('storeComposerDraft'), context);
  vm.runInContext(appFunction('clearAcceptedComposer'), context);

  context.clearAcceptedComposer(entry, 'Accepted prompt', []);

  assert.equal(entry.composer.draft, '');
  assert.equal(entry.composer.metadata.pending, true);
});

test('opening a restored local draft resolves its server context before committing navigation', async () => {
  const calls = [];
  const order = [];
  let rekeyed = null;
  let shown = null;
  let loaded = null;
  const pendingTicket = { revision: 1, selection: null };
  const context = vm.createContext({
    VIEW_CHAT,
    uiState: {
      activeTabId: 'all', selection: null,
      rekeyChat(oldKey, newKey) { order.push('rekey'); rekeyed = { oldKey, newKey }; },
    },
    navigation: {
      begin() { order.push('begin'); return pendingTicket; },
      transition() { throw new Error('a local draft must not transition before it is resolved'); },
      commit(selection, ticket) {
        assert.equal(ticket, pendingTicket);
        order.push('commit');
        return { revision: 1, selection };
      },
      isCurrent: () => true,
    },
    async post(route, body, options) {
      order.push('post');
      calls.push({ route, body, options });
      return { key: 'saved-key', cwd: body.cwd };
    },
    sessionPath: () => { throw new Error('a local draft must not use the persisted-session route'); },
    showChatResource(key) { order.push('show'); shown = key; },
    async loadOpenChat(ticket) { order.push('load'); loaded = ticket; },
  });
  vm.runInContext(appFunction('openSession'), context);

  assert.equal(await context.openSession({ path: 'draft-key', cwd: 'project', local: true }), true);

  assert.equal(calls[0].route, '/api/sessions');
  assert.equal(calls[0].body.cwd, 'project');
  assert.deepEqual(Object.keys(calls[0].body), ['cwd']);
  assert.equal(calls[0].options.key, 'draft-key');
  assert.deepEqual(rekeyed, { oldKey: 'draft-key', newKey: 'saved-key' });
  assert.equal(shown, 'saved-key');
  assert.equal(loaded.selection.resourceId, 'saved-key');
  assert.deepEqual(order, ['begin', 'post', 'rekey', 'commit', 'show', 'load']);
});

test('bootstrap resolves a restored local draft before opening any stream', async () => {
  const order = [];
  const local = { path: 'draft-key', cwd: 'project', local: true };
  const context = vm.createContext({
    renderedChatKey: 'draft-key',
    restoreChatView(key) { order.push(`restore:${key}`); },
    sessionForKey: () => local,
    async openSession(session) { order.push(`resume:${session.path}`); return true; },
    connect() { throw new Error('must not connect before the local draft is resumed'); },
    loadState() { throw new Error('must not load state through the stale key'); },
  });
  vm.runInContext(appFunction('loadInitialChat'), context);

  assert.equal(await context.loadInitialChat(), true);
  assert.deepEqual(order, ['restore:draft-key', 'resume:draft-key']);
});

test('draft sidebar metadata follows the cache rekey transition', () => {
  const chatCache = createChatCache();
  const uiState = createUiState({ chatCache });
  uiState.chatState('draft-key').cwd = 'project';
  chatCache.setDraft('draft-key', 'Local draft', { metadata: {
    cwd: 'project', title: 'Local draft', modified: '2026-09-19T10:00:00.000Z', pending: false,
  } });

  uiState.rekeyChat('draft-key', 'saved-key');

  assert.equal(uiState.chats.has('draft-key'), false);
  assert.equal(uiState.chats.has('saved-key'), true);
  assert.equal(chatCache.draftRecord('draft-key').metadata, null);
  assert.equal(chatCache.draftRecord('saved-key').metadata.title, 'Local draft');
});

test('chat rows expose a yellow marker for unsent drafts', () => {
  assert.match(source, /class="draftDot" title="Unsent draft"/);
  assert.match(cssSource, /\.sessionItem \.draftDot \{[^}]*background:\s*var\(--warn\)/s);
});

test('project tabs reorder on either side of the drop target', () => {
  const context = vm.createContext({});
  vm.runInContext(appFunction('reorderProjectTabs'), context);

  assert.deepEqual([...context.reorderProjectTabs(['a', 'b', 'c'], 'a', 'b', true)], ['b', 'a', 'c']);
  assert.deepEqual([...context.reorderProjectTabs(['a', 'b', 'c'], 'c', 'b', false)], ['a', 'c', 'b']);
  const unchanged = ['a', 'b'];
  assert.equal(context.reorderProjectTabs(unchanged, '', 'b', false), unchanged);
});

function setup() {
  const uiState = createUiState();
  for (const key of ['a', 'b']) uiState.chatState(key).cwd = key;
  uiState.registerProject('a');
  uiState.registerProject('b');
  const screen = { key: null, history: '' };
  const context = vm.createContext({
    uiState, projectTabId, VIEW_CHAT, VIEW_TERMINAL, VIEW_SETTINGS,
    allSessions: ['a', 'b'].map((key) => ({ path: key, cwd: key })),
    projState: { tabs: ['a', 'b'] }, renderedChatKey: null,
    isNavigationSelectionAvailable: () => true,
    fallbackSelectionForTab: (tabId) => ({ tabId, view: VIEW_CHAT, resourceId: 'b' }),
    saveProjTabs() {}, renderProjTabs() {},
    async loadOpenChat(ticket) { screen.history = `history:${ticket.selection.resourceId}`; },
    async newChat() { throw new Error('unexpected new chat'); },
  });
  const navigation = createNavigationController({ state: uiState, onTransition(selection) {
    if (selection.view === VIEW_CHAT) {
      screen.key = selection.resourceId;
      screen.history = '';
      context.renderedChatKey = selection.resourceId;
    }
  } });
  context.navigation = navigation;
  for (const name of ['activateProjTab', 'closeProjTab', 'showChat']) {
    vm.runInContext(appFunction(name), context);
  }
  navigation.transition({ tabId: projectTabId('a'), view: VIEW_CHAT, resourceId: 'a' });
  return { context, navigation, screen, uiState };
}

test('project tab restores cached selection then synchronizes its history', async () => {
  const { context, screen } = setup();
  await context.activateProjTab('b');
  assert.equal(screen.key, 'b');
  assert.equal(screen.history, 'history:b');
});

test('closing selected project synchronizes the landing chat', async () => {
  const { context, screen } = setup();
  await context.closeProjTab('a', { landingCwd: 'b' });
  assert.equal(screen.key, 'b');
  assert.equal(screen.history, 'history:b');
});

test('project rendering replaces a diff from the previously visible project', () => {
  const { context, uiState } = setup();
  const body = { innerHTML: 'diff from a' };
  context.$ = () => body;
  context.renderProjectFiles = () => {};
  context.renderGit = () => {};
  vm.runInContext(appFunction('renderProjectScope'), context);
  const a = uiState.projectState('a');
  const b = uiState.projectState('b');
  a.diffHtml = 'diff from a';
  context.renderProjectScope(b);
  assert.equal(body.innerHTML, '');
  context.renderProjectScope(a);
  assert.equal(body.innerHTML, 'diff from a');
});

test('non-chat views park scroll before hiding and returning to the same key restores it', () => {
  const { context, uiState } = setup();
  let visible = true;
  let restored = null;
  const cache = uiState.chatCache;
  Object.assign(context, {
    chatCache: cache,
    renderContextHeader() {}, renderSessions() {},
    terminalView: { render() {}, show() {} },
    transport: { closeDetailed() {} },
    parkChatView(key) { cache.saveView(key, { scrollTop: visible ? 173 : 0, snapshot: {} }); },
    restoreChatView(key) { restored = visible ? cache.peek(key).view.scrollTop : 0; cache.takeSnapshot(key); },
    settingsController: { hide() {} },
    renderSettingsView() { visible = false; },
    renderChatView() { visible = true; },
    navigationSync: { show(selection) { context.showChatResource(selection.resourceId); } },
    renderCachedChatState() {}, renderProjectScope() {}, projectScopeForChat() {},
    connect() {},
  });
  vm.runInContext(appFunction('renderNavigationSelection'), context);
  vm.runInContext(appFunction('showChatResource'), context);
  context.renderNavigationSelection({ tabId: 'all', view: VIEW_SETTINGS, resourceId: null });
  context.renderNavigationSelection({ tabId: 'all', view: VIEW_CHAT, resourceId: 'a' });
  assert.equal(restored, 173);
});

function deferredApiSetup() {
  const state = setup();
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  Object.assign(state.context, {
    activeChatKey: () => state.uiState.selection?.resourceId ?? null,
    transport: createTransport({ fetchImpl: () => response }),
    toast() {}, showChatResource() {},
  });
  vm.runInContext(appFunction('errorInfo'), state.context);
  vm.runInContext(appFunction('api'), state.context);
  return { ...state, resolve };
}

test('guarded action ignores a response from before an A B A navigation', async () => {
  const { context, navigation, resolve } = deferredApiSetup();
  const pending = context.api('/api/model', {}, { key: 'a', guardChat: true });
  navigation.transition({ tabId: 'all', view: VIEW_CHAT, resourceId: 'b' });
  navigation.transition({ tabId: 'all', view: VIEW_CHAT, resourceId: 'a' });
  resolve({ ok: true, json: async () => ({ thinkingLevel: 'high' }) });
  assert.equal((await pending).stale, true);
});

test('a failed persisted mutation surfaces its error instead of a success payload', async () => {
  const { context, resolve } = deferredApiSetup();
  const messages = [];
  context.toast = (message) => messages.push(message);
  const pending = context.api('/api/network', { method: 'POST' });
  resolve({ ok: false, status: 500, json: async () => ({ error: 'internal error' }) });

  const result = await pending;
  assert.equal(result.error, 'internal error');
  assert.equal(result.code, '');
  assert.deepEqual(messages, ['internal error']);
});

test('state refresh without explicit ticket cannot navigate back to an old chat', async () => {
  const { context, navigation, resolve, uiState } = deferredApiSetup();
  // The payload boundary is stubbed here; normalization has its own tests.
  uiState.applyStatePayload = (payload) => payload;
  Object.assign(context, {
    applyPlatformCapabilities() {}, applyChatArchiving() {},
    renderCachedChatState() {}, renderProjectScope() {}, projectScopeForChat() {},
  });
  vm.runInContext(appFunction('selectCurrentChatState'), context);
  vm.runInContext(appFunction('loadState'), context);
  const pending = context.loadState({ key: 'a' });
  navigation.transition({ tabId: 'all', view: VIEW_CHAT, resourceId: 'b' });
  resolve({ ok: true, json: async () => ({ key: 'a' }) });
  await pending;
  assert.equal(uiState.selection.resourceId, 'b');
});

function fileSetup() {
  const state = setup();
  const readers = [];
  class Reader {
    static LOADING = 1;
    /** @type {(() => void) | null} */
    onload = null;
    /** @type {(() => void) | null} */
    onloadend = null;
    readyState = 0;
    readAsDataURL() { this.readyState = 1; readers.push(this); }
    abort() { this.readyState = 2; }
    finish() {
      this.readyState = 2;
      this.result = 'data:image/png;base64,image';
      this.onload?.();
      this.onloadend?.();
    }
  }
  Object.assign(state.context, {
    FileReader: Reader, chatCache: state.uiState.chatCache,
    activeChatKey: () => state.uiState.selection.resourceId,
    renderAttachments() {}, toast() {}, pending: [], TEXT_EXT: /txt$/,
  });
  state.uiState.chatCache.ensure('a');
  vm.runInContext(appFunction('addFiles'), state.context);
  state.context.addFiles([{ name: 'photo.png', type: 'image/png' }], 'a');
  return { ...state, readers };
}

test('pending attachment follows the cache entry across rekey', () => {
  const { uiState, readers } = fileSetup();
  uiState.rekeyChat('a', 'saved');
  readers[0].finish();
  assert.equal(uiState.chatCache.peek('saved').composer.attachments.length, 1);
  assert.equal(uiState.chatCache.peek('a'), null);
});

test('history view refresh does not cancel composer attachment reads', () => {
  const { uiState, readers } = fileSetup();
  uiState.chatCache.clearView('a');
  readers[0].finish();
  assert.equal(uiState.chatCache.peek('a').composer.attachments.length, 1);
});

test('ninth-chat eviction aborts attachment readers and late completion cannot revive a chat', () => {
  const { uiState, readers } = fileSetup();
  for (let index = 0; index < uiState.chatCache.limit; index += 1) {
    uiState.chatCache.ensure(`later:${index}`);
  }
  assert.equal(readers[0].readyState, 2);
  readers[0].finish();
  assert.equal(uiState.chatCache.peek('a'), null);
});

test('agent task starts a fresh record after completion but keeps an active replay', () => {
  const { context, uiState } = setup();
  let now = 100;
  context.Date = { now: () => now };
  context.activeChatKey = () => uiState.selection.resourceId;
  context.taskOwner = (key) => uiState.chatState(key);
  context.syncTasks = () => {};
  vm.runInContext(appFunction('setAgentTask'), context);
  context.setAgentTask(true, { id: 'first' }, 'a');
  now = 150;
  context.setAgentTask(false, null, 'a');
  now = 200;
  context.setAgentTask(true, { id: 'second' }, 'a');
  const task = uiState.chatState('a').agentTask;
  assert.equal(task.summary, 'second');
  assert.equal(task.t0, 200);
  assert.equal(task.t1, null);
  now = 250;
  context.setAgentTask(true, { id: 'second' }, 'a');
  assert.equal(uiState.chatState('a').agentTask.t0, 200);
  assert.equal(uiState.chatState('b').agentTask, null);
});

test('changing a draft folder selects a distinct chat in a compatible tab', async () => {
  const { context, uiState, screen } = setup();
  uiState.chatCache.setDraft('a', 'keep in a');
  Object.assign(context, {
    activeChatKey: () => uiState.selection.resourceId,
    activeChatState: () => uiState.chatState(uiState.selection.resourceId),
    activeProjectCwd: () => uiState.projects.get(uiState.activeTabId).cwd,
    sameCwd: (left, right) => left === right,
    $: (id) => id === 'hero' ? null : { textContent: '' },
    cwdDd: { classList: { remove() {} } },
    toast() {}, parkChatView() {}, renderContextHeader() {}, loadRecentCwds() {},
    showChatResource: (key) => { context.renderedChatKey = key; },
    async refreshAll() { screen.history = `history:${uiState.selection.resourceId}`; },
    transport: { async request() {
      return { response: { ok: true }, payload: { key: 'new', cwd: 'new-folder' }, aborted: false, stale: false };
    } },
  });
  vm.runInContext(appFunction('api'), context);
  context.post = (url, body, options) => context.api(url, { method: 'POST', body }, options);
  vm.runInContext(appFunction('changeCwd'), context);
  await context.changeCwd('new-folder');
  assert.equal(uiState.selection.resourceId, 'new');
  assert.equal(uiState.selection.tabId, 'all');
  assert.equal(uiState.chatState('new').cwd, 'new-folder');
  assert.equal(screen.history, 'history:new');
  assert.equal(uiState.chatCache.peek('a').composer.draft, 'keep in a');
});

test('fork preserves source composer and tab memories under the original key', async () => {
  const { context, screen, uiState } = setup();
  uiState.chatCache.setDraft('a', 'source draft');
  uiState.chatCache.setAttachments('a', [{ kind: 'image', data: 'source image' }]);
  context.activeChatKey = () => uiState.selection.resourceId;
  context.activeChatState = () => uiState.chatState(uiState.selection.resourceId);
  context.sessionPath = (key, action) => `/sessions/${key}/${action}`;
  context.toast = () => {};
  context.parkChatView = () => {};
  context.showChatResource = (key) => { context.renderedChatKey = key; };
  context.transport = { async request() {
    return { response: { ok: true }, payload: { key: 'fork', cwd: 'a' }, aborted: false, stale: false };
  } };
  vm.runInContext(appFunction('api'), context);
  context.post = (url, body, options) => context.api(url, { method: 'POST', body }, options);
  vm.runInContext(appFunction('forkFrom'), context);
  await context.forkFrom('entry');
  assert.equal(uiState.selection.resourceId, 'fork');
  assert.equal(screen.history, 'history:fork');
  assert.equal(uiState.chats.get('a').key, 'a');
  assert.equal(uiState.chatCache.peek('a').composer.draft, 'source draft');
  assert.equal(uiState.chatCache.peek('a').composer.attachments[0].data, 'source image');
  assert.equal(uiState.chatCache.ensure('fork').composer.draft, '');
});

test('returning from settings refreshes messages missed by the closed stream', async () => {
  const { context, navigation, screen } = setup();
  navigation.settings();
  await context.showChat();
  assert.equal(screen.key, 'a');
  assert.equal(screen.history, 'history:a');
});

test('a chat notification opens the matching project tab', async () => {
  const { context, uiState } = setup();
  let opened = null;
  Object.assign(context, {
    allSessions: [{ path: 'notice', cwd: 'b' }],
    loadSessions: async () => {},
    toast() {},
    openSession: async (session, options) => { opened = { session, options }; },
  });
  vm.runInContext(appFunction('openChatNotification'), context);
  await context.openChatNotification('notice');
  assert.equal(opened.session.path, 'notice');
  assert.equal(opened.options.tabId, projectTabId('b'));
  assert.equal(uiState.projects.has(opened.options.tabId), true);
});

test('slash palette targets a command word after whitespace and replaces only that token', () => {
  const input = {
    value: 'Please /skill:release now',
    selectionStart: 'Please /skill:rel'.length,
    selectionEnd: 'Please /skill:rel'.length,
    focus() {},
  };
  const context = vm.createContext({
    $: () => input,
    input,
    cmdMenuItems: [{ name: 'skill:release-check' }],
    cmdMenuRange: null,
    closeCmdMenu() {},
    updateComposerDraft() {},
    activeChatKey: () => 'chat',
    autoGrow() {},
  });
  vm.runInContext(appFunction('slashToken'), context);
  vm.runInContext(appFunction('pickCmd'), context);
  const token = context.slashToken();
  assert.deepEqual({ ...token }, {
    query: 'skill:rel',
    start: 'Please '.length,
    end: 'Please /skill:release'.length,
  });
  context.cmdMenuRange = token;
  context.pickCmd(0);
  assert.equal(input.value, 'Please /skill:release-check now');
  assert.equal(input.selectionStart, 'Please /skill:release-check'.length);

  input.value = 'prefix/not-a-command';
  input.selectionStart = input.selectionEnd = input.value.length;
  assert.equal(context.slashToken(), null);
});

test('Git refresh is visible-project only, deduplicated and event-driven', async () => {
  let now = 100_000;
  let active = 'a';
  const owners = new Map([['a', { cwd: 'a' }], ['b', { cwd: 'b' }]]);
  const calls = [];
  const context = vm.createContext({
    gitRefreshes: new Map(), document: { hidden: false },
    Date: { now: () => now },
    uiState: { projectState: (cwd) => owners.get(cwd) },
    isProjectScopeActive: (cwd) => cwd === active,
    api: (url) => new Promise((resolve) => calls.push({ url, resolve })),
    renderGit() {},
  });
  vm.runInContext(appFunction('refreshGit'), context);
  const options = { key: 'chat-a', projectCwd: 'a' };
  await context.refreshGit({ key: 'chat-b', projectCwd: 'b' });
  assert.equal(calls.length, 0);
  const first = context.refreshGit(options);
  const duplicate = context.refreshGit(options);
  assert.equal(calls.length, 1);
  calls[0].resolve({ repo: true, branch: 'main' });
  await Promise.all([first, duplicate]);
  await context.refreshGit(options);
  assert.equal(calls.length, 1);
  const forced = context.refreshGit({ ...options, force: true });
  assert.equal(calls[1].url, '/api/git?force=1');
  calls[1].resolve({ repo: true, branch: 'main' });
  await forced;
  now += 30_001;
  context.document.hidden = true;
  await context.refreshGit(options);
  assert.equal(calls.length, 2);
  context.document.hidden = false;
  const focused = context.refreshGit(options);
  calls[2].resolve({ repo: true, branch: 'changed' });
  await focused;
  active = 'b';
  await context.refreshGit(options);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(source, /setInterval\([^\n]*refreshGit/);
});

test('chat hover details stay available without building a panel for every row', () => {
  const row = appFunction('sessionItemEl');
  const details = appFunction('sessionDetailsEl');
  assert.doesNotMatch(row, /class="sessionDetails"/);
  assert.match(row, /setTimeout\(openDetails, 180\)/);
  assert.match(row, /details = sessionDetailsEl\(s\)/);
  assert.match(details, /addDetail\('Project'/);
  assert.match(details, /addResources\('PR'/);
  assert.match(details, /addResources\('Issues'/);
  assert.match(details, /Chat code/);
});

test('session lists enter the live DOM in one replacement', () => {
  const fill = appFunction('fillSessionList');
  assert.match(fill, /createDocumentFragment\(\)/);
  assert.match(fill, /replaceChildren\(fragment\)/);
  assert.doesNotMatch(fill, /el\.appendChild/);
});

test('background completion updates its running dot without rebuilding the sidebar', () => {
  const handler = appFunction('handleEvent');
  const globalBranch = handler.slice(handler.indexOf("if (ev.scope === 'global')"), handler.indexOf("  // A closing EventSource"));
  assert.match(globalBranch, /updateSessionRunningState\(ev\.key, ev\.running\)/);
  assert.doesNotMatch(globalBranch, /renderSessions\(\)/);
});

test('composer layout work remains coalesced while typing', () => {
  assert.match(appFunction('scheduleComposerLayout'), /requestAnimationFrame/);
  assert.match(source, /input\.addEventListener\('input',[\s\S]{0,180}scheduleComposerLayout\(\)/);
  assert.match(source, /pagehide', \(\) => chatCache\.flushDrafts\(\)/);
});

test('active composer exposes the approved actions and pauses its persistent activity for forms', () => {
  assert.match(indexSource, /data-queue-type="steer"[^>]*>Reindirizza<\/button>/);
  assert.match(indexSource, /data-queue-type="followUp"[^>]*>Dopo<\/button>/);
  assert.match(indexSource, /id="responseSpinner"[\s\S]*id="responseActivityLabel">Thinking<\/span>/);
  assert.match(indexSource, /id="responseElapsed">00:00<\/span>/);
  assert.match(cssSource, /\.responseSpinnerRing\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(source, /const modelActive = activityRunning && !chatState\.awaitingInput/);
  assert.match(source, /responseSpinner'\)\.classList\.toggle\('hide', !modelActive\)/);
  assert.match(source, /activity timer covers the whole agent run/);
  assert.match(source, /task closes only on agent_end/);
  assert.doesNotMatch(appFunction('handleEvent'), /case 'error':[\s\S]*closeResponseSpinner/);
  assert.match(cssSource, /\.queuedPrompt\s*\{[^}]*grid-template-columns/s);
});

test('a delayed enqueue acknowledgement cannot resurrect a delivered ghost', async () => {
  const uiState = createUiState();
  const item = { id: 'delivered', type: 'steer', text: 'redirect', attachments: [], bytes: 8 };
  let acknowledge;
  const response = new Promise((resolve) => { acknowledge = resolve; });
  const context = vm.createContext({
    uiState, chatCache: uiState.chatCache, composerSubmitting: false,
    closeCmdMenu() {}, activeChatKey: () => 'a', input: { value: 'redirect' }, pending: [],
    chatView: { capturePromptAnchor: () => null, insertAcceptedUserTurn() {} },
    setComposerSubmitting() {}, clearAcceptedComposer() {},
    storeComposerDraft: (key, draft) => uiState.chatCache.setDraft(key, draft),
    post: () => response, renderSessions() {},
    applyQueueChange: (items, key) => uiState.applyQueuedPrompts(key, items),
  });
  vm.runInContext(appFunction('submitPrompt'), context);
  const request = context.submitPrompt('steer');
  // SSE enqueue and dispatch both arrive before the POST acknowledgement.
  uiState.applyQueuedPrompts('a', [item]);
  uiState.applyQueuedPrompts('a', []);
  acknowledge({ ok: true, key: 'a', queued: item });
  await request;
  assert.deepEqual(uiState.chatState('a').queuedPrompts, []);
});

test('a delayed prompt acknowledgement cannot restart an already completed response', async () => {
  const uiState = createUiState();
  let acknowledge;
  const response = new Promise((resolve) => { acknowledge = resolve; });
  const turns = [];
  const context = vm.createContext({
    uiState, chatCache: uiState.chatCache, composerSubmitting: false,
    closeCmdMenu() {}, activeChatKey: () => 'a', renderedChatKey: 'a', input: { value: 'request' }, pending: [],
    chatView: {
      capturePromptAnchor: () => null,
      insertAcceptedUserTurn: (text) => turns.push(text),
    },
    setComposerSubmitting() {}, clearAcceptedComposer() {}, renderSessions() {},
    storeComposerDraft: (key, draft) => uiState.chatCache.setDraft(key, draft),
    draftTitle: (value) => value.trim(), allSessions: [],
    post: () => response,
    setRunning: () => uiState.startResponse('a'),
  });
  vm.runInContext(appFunction('submitPrompt'), context);
  const request = context.submitPrompt();
  uiState.startResponse('a');
  uiState.markResponseText('a');
  uiState.finishResponse('a');
  acknowledge({ ok: true, key: 'a' });
  await request;
  assert.deepEqual(turns, ['request']);
  assert.equal(uiState.chatState('a').streaming, false);
  assert.equal(uiState.chatState('a').responsePhase, 'idle');
});

test('accepted composer cleanup preserves edits and attachments added while the request was pending', () => {
  const { context } = setup();
  const sent = { name: 'sent' };
  const added = { name: 'added later' };
  const entry = { key: 'saved', composer: { draft: 'edited later', attachments: [sent, added] } };
  Object.assign(context, {
    activeChatKey: () => 'other',
    chatCache: {
      setDraft(key, draft) { entry.key = key; entry.composer.draft = draft; },
    },
  });
  vm.runInContext(appFunction('clearAcceptedComposer'), context);
  context.clearAcceptedComposer(entry, 'submitted draft', [sent]);
  assert.equal(entry.composer.draft, 'edited later');
  assert.deepEqual(entry.composer.attachments, [added]);
});
