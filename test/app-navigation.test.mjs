import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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

test('chat links distinguish local files from web navigation', () => {
  const context = vm.createContext({});
  vm.runInContext(appFunction('isLocalLink'), context);
  assert.equal(context.isLocalLink('https://example.com/docs'), false);
  assert.equal(context.isLocalLink('mailto:user@example.com'), false);
  assert.equal(context.isLocalLink('#section'), false);
  assert.equal(context.isLocalLink('./public/app.js:42'), true);
  assert.equal(context.isLocalLink('/C:/work/project/app.js:42'), true);
  assert.equal(context.isLocalLink('C:%5Cwork%5Cproject%5Capp.js:42'), true);
  assert.equal(context.isLocalLink('file:///C:/work/project/app.js'), true);
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
    renderContextHeader() {}, renderSessions() {}, renderTerminals() {},
    transport: { closeDetailed() {} },
    parkChatView(key) { cache.saveView(key, { scrollTop: visible ? 173 : 0, snapshot: {} }); },
    restoreChatView(key) { restored = visible ? cache.peek(key).view.scrollTop : 0; cache.takeSnapshot(key); },
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

test('parking an already detached chat does not replace its snapshot with an empty view', () => {
  const { context, uiState } = setup();
  const cache = uiState.chatCache;
  const snapshot = { content: 'history' };
  cache.saveView('a', { scrollTop: 173, snapshot });
  context.chatCache = cache;
  context.stashComposerDraft = () => { throw new Error('detached view must not be captured again'); };
  vm.runInContext(appFunction('parkChatView'), context);
  context.parkChatView('a');
  assert.equal(cache.takeSnapshot('a'), snapshot);
  assert.equal(cache.peek('a').view.scrollTop, 173);
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

test('eviction aborts attachment readers and late completion cannot revive a chat', () => {
  const { uiState, readers } = fileSetup();
  uiState.chatCache.remove('a');
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

test('settings section navigation scrolls only its content container', () => {
  let request = null;
  const view = {
    scrollTop: 80,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: (options) => { request = options; },
  };
  const section = { getBoundingClientRect: () => ({ top: 460 }) };
  const context = vm.createContext({ $: (id) => id === 'settingsView' ? view : section });
  vm.runInContext(appFunction('scrollSettingsSection'), context);
  assert.equal(context.scrollSettingsSection('sec-theme'), true);
  assert.deepEqual({ ...request }, { top: 424, behavior: 'smooth' });
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

test('transcript stickiness is measured before every live mutation', () => {
  let atBottom = true;
  let scrolls = 0;
  const context = vm.createContext({
    atBottom: () => atBottom,
    scrollDown: () => { scrolls += 1; },
  });
  vm.runInContext(appFunction('mutateTranscript'), context);
  context.mutateTranscript(() => { atBottom = false; });
  assert.equal(scrolls, 1, 'a reader at the bottom follows growth');
  context.mutateTranscript(() => { atBottom = true; });
  assert.equal(scrolls, 1, 'a reader above the bottom is not dragged down');

  for (const name of ['bubble', 'appendMd', 'appendText', 'renderTool']) {
    assert.match(appFunction(name), /mutateTranscript\(/, `${name} uses the shared rule`);
  }
  assert.match(appFunction('handleEvent'), /case 'error':[\s\S]*bubble\('sys err'/);
});

test('live and refreshed skill invocations use the same compact mention', () => {
  const context = vm.createContext({});
  vm.runInContext(appFunction('skillInvocationFromCommand'), context);
  vm.runInContext(appFunction('skillInvocationText'), context);
  const live = context.skillInvocationFromCommand('/skill:release-check --strict package-a');
  const known = [{ source: 'skill', name: 'skill:release-check' }];
  assert.ok(context.skillInvocationFromCommand('/skill:release-check --strict package-a', known));
  assert.equal(context.skillInvocationFromCommand('/skill:unknown keep-as-text', known), null);
  const history = { type: 'skill', name: 'release-check', arguments: '--strict package-a' };
  assert.equal(context.skillInvocationText(live), context.skillInvocationText(history));
  assert.equal(context.skillInvocationText(history), '/skill:release-check --strict package-a');
  assert.match(appFunction('acceptedUserTurn'), /skillInvocationElement\(skill\)/);
  assert.match(appFunction('loadHistory'), /b\.type === 'skill'[\s\S]*skillInvocationElement\(b\)/);
  assert.match(cssSource, /\.skillInvocation\s*\{/);
});

test('copying a compact skill mention cannot fall back to hidden body text', async () => {
  let copied = null;
  const body = { children: [], appendChild(child) { this.children.push(child); } };
  const context = vm.createContext({
    document: {
      createElement() {
        return { children: [], dataset: {}, classList: { add() {} }, appendChild(child) { this.children.push(child); } };
      },
    },
    ICON_COPY: '<copy>', ICON_FORK: '<fork>',
    addChatListener(target, type, callback) { target[type] = callback; },
    copyToClipboard(text) { copied = text; },
    forkFrom() {},
  });
  vm.runInContext(appFunction('addMsgActions'), context);
  context.addMsgActions(body, {
    dataset: { raw: '/skill:release-check --strict' },
    textContent: 'SECRET_SKILL_INSTRUCTION_BODY',
  });
  await body.children[0].children[0].click();
  assert.equal(copied, '/skill:release-check --strict');
});

test('active composer exposes the approved actions and a persistent timed activity indicator', () => {
  assert.match(indexSource, /data-queue-type="steer"[^>]*>Reindirizza<\/button>/);
  assert.match(indexSource, /data-queue-type="followUp"[^>]*>Dopo<\/button>/);
  assert.match(indexSource, /id="responseSpinner"[\s\S]*id="responseActivityLabel">Thinking<\/span>/);
  assert.match(indexSource, /id="responseElapsed">00:00<\/span>/);
  assert.match(cssSource, /\.responseSpinnerRing\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(source, /classList\.toggle\('hide', !running\)/);
  assert.match(cssSource, /\.queuedPrompt\s*\{[^}]*grid-template-columns/s);
});

test('only a server dispatch fixes a queued prompt in the selected transcript', () => {
  const { context, uiState } = setup();
  const steer = { id: 'opaque-steer', type: 'steer', text: 'same', attachments: [], bytes: 4 };
  const after = { id: 'opaque-after', type: 'followUp', text: 'same', attachments: [], bytes: 4 };
  uiState.applyQueuedPrompts('a', [steer, after]);
  const section = { kind: 'queue-section' };
  const inserted = [];
  Object.assign(context, {
    activeChatKey: () => 'a',
    renderedChatKey: 'a',
    chat: {
      querySelector: (selector) => selector === '.queuedPrompts' ? section : null,
      insertBefore: (turn, before) => inserted.push({ turn, before }),
      appendChild: (turn) => inserted.push({ turn, before: null }),
    },
    $$: () => [],
    deliveredPromptElement: (item) => ({ queueId: item.id }),
    mutateTranscript: (fn) => fn(),
    applyQueueChange: (items, key) => uiState.applyQueuedPrompts(key, items),
  });
  vm.runInContext(appFunction('handleQueueEvent'), context);

  context.handleQueueEvent({ action: 'enqueue', ids: ['opaque-after'], queued: [steer, after] }, 'a');
  assert.equal(inserted.length, 0, 'enqueue never invents a delivery');
  context.handleQueueEvent({ action: 'dispatch', ids: ['opaque-steer'], queued: [after] }, 'a');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].turn.queueId, 'opaque-steer');
  assert.equal(inserted[0].before, section);
  assert.deepEqual(uiState.chatState('a').queuedPrompts.map((item) => item.id), ['opaque-after']);
});

test('steering splits the live answer and pending follow-ups stay below its continuation', () => {
  function node(className = '') {
    const element = {
      className, dataset: {}, children: [], parentNode: null, text: '',
      classList: { contains: (name) => element.className.split(' ').includes(name) },
      get lastElementChild() { return element.children.at(-1); },
      get previousElementSibling() {
        return element.parentNode?.children[element.parentNode.children.indexOf(element) - 1] ?? null;
      },
      set innerHTML(_html) { element.appendChild(node('body')); },
      appendChild(child) { element.insertBefore(child, null); },
      insertBefore(child, before) {
        child.parentNode = element;
        const index = before ? element.children.indexOf(before) : element.children.length;
        element.children.splice(index, 0, child);
      },
      querySelector(selector) { return element.children.find((child) => child.className.split(' ').includes(selector.slice(1))) ?? null; },
    };
    return element;
  }
  const uiState = createUiState();
  const steer = { id: 'steer', type: 'steer', text: 'redirect', attachments: [], bytes: 8 };
  const after = { id: 'after', type: 'followUp', text: 'later', attachments: [], bytes: 5 };
  const chat = node();
  const context = vm.createContext({
    uiState, chat, activeChatKey: () => 'a', renderedChatKey: 'a',
    activeChatState: () => uiState.chatState('a'),
    $: () => null, $$: () => [], setHeroMode() {}, modelsCache: () => [],
    currentTurn: null, currentAssistant: null, currentThinking: null,
    document: { createElement: () => node() },
    markResponseText() {}, mutateTranscript: (fn) => fn(),
    bubble(_cls, text, body) { const child = node(); child.text = text; body.appendChild(child); return child; },
    appendMd(element, delta) { element.text += delta; },
    deliveredPromptElement(item) { const turn = node('turn user'); turn.text = item.text; return turn; },
    applyQueueChange: (items, key) => uiState.applyQueuedPrompts(key, items),
  });
  for (const name of ['newTurn', 'handleQueueEvent', 'handleEvent']) vm.runInContext(appFunction(name), context);
  context.handleEvent({ kind: 'text', delta: 'before' }, 'a');
  uiState.applyQueuedPrompts('a', [steer, after]);
  const ghosts = node('queuedPrompts');
  chat.appendChild(ghosts);
  context.handleEvent({ kind: 'queue', action: 'dispatch', ids: ['steer'], queued: [after] }, 'a');
  context.handleEvent({ kind: 'text', delta: 'after' }, 'a');
  const textOf = (element) => element.text + element.children.map(textOf).join('');
  assert.deepEqual(chat.children.map(textOf), ['before', 'redirect', 'after', '']);
  assert.equal(chat.lastElementChild, ghosts);
});

test('a delayed enqueue acknowledgement cannot resurrect a delivered ghost', async () => {
  const uiState = createUiState();
  const item = { id: 'delivered', type: 'steer', text: 'redirect', attachments: [], bytes: 8 };
  let acknowledge;
  const response = new Promise((resolve) => { acknowledge = resolve; });
  const context = vm.createContext({
    uiState, chatCache: uiState.chatCache, composerSubmitting: false,
    closeCmdMenu() {}, activeChatKey: () => 'a', input: { value: 'redirect' }, pending: [],
    chat: { lastElementChild: null }, setComposerSubmitting() {}, clearAcceptedComposer() {},
    post: () => response,
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
    chat: { lastElementChild: null, prepend: (turn) => turns.push(turn) },
    setComposerSubmitting() {}, clearAcceptedComposer() {},
    post: () => response, $: () => null, setHeroMode() {}, scrollDown() {},
    acceptedUserTurn: (text) => text,
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
