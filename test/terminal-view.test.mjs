import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalView } from '../public/terminal-view.js';
import { createUiState, VIEW_TERMINAL } from '../public/ui-state.js';

class FakeClassList {
  constructor(value = '') { this.values = new Set(value.split(/\s+/).filter(Boolean)); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.contains(name) : force;
    if (next) this.add(name); else this.remove(name);
    return next;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.parts = new Map();
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.title = '';
  }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList(value);
  }
  get className() { return this._className; }
  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
    this.parts.clear();
    for (const name of ['lbl', 'killBtn', 'nm', 'pth', 'go', 'kill']) {
      if (value.includes(`class="${name}`) || value.includes(` ${name}`)) {
        this.parts.set(`.${name}`, new FakeElement(name === 'lbl' ? 'span' : 'button'));
      }
    }
  }
  get innerHTML() { return this._innerHTML ?? ''; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  querySelector(selector) { return this.parts.get(selector) ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }
  async emit(type, event = {}) {
    const payload = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
    for (const listener of this.listeners.get(type) ?? []) await listener(payload);
  }
  setAttribute() {}
  select() {}
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.removed = true;
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super('canvas');
    let fillStyle = '#000000';
    this.context = {
      get fillStyle() { return fillStyle; },
      set fillStyle(value) { fillStyle = value; },
      fillRect() {},
      getImageData: () => ({ data: [47, 224, 192, 51] }),
    };
  }
  getContext() { return this.context; }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.elements = new Map();
    for (const id of [
      'terminalHeader', 'terminalFolder', 'terminalPath', 'terminalKind', 'terminalStatus',
      'terminalOpenFolderBtn', 'terminalCopyPathBtn', 'terminalRestartBtn', 'terminalCloseBtn',
      'termHost', 'chatView', 'settingsView', 'termView', 'navChat', 'navSettings',
      'termList', 'termLabel', 'termCount', 'termsDd', 'termsMenu', 'termsCount',
    ]) this.elements.set(id, new FakeElement());
  }
  getElementById(id) { return this.elements.get(id) ?? null; }
  createElement(tagName) { return tagName === 'canvas' ? new FakeCanvas() : new FakeElement(tagName); }
  execCommand() { return true; }
}

class FakeWindow {
  constructor() { this.listeners = new Map(); }
  getComputedStyle() {
    const values = {
      '--txt': '#e9edf3', '--bg': '#0b0d11', '--teal': '#2fe0c0',
      '--teal-dim': 'color-mix(in srgb, #2fe0c0 20%, transparent)', '--font-mono': 'Consolas',
    };
    return { getPropertyValue: (name) => values[name] ?? '' };
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  setTimeout(listener) { listener(); return 1; }
}

class FakeTerminal {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.cols = 80;
    this.rows = 24;
    this.writes = [];
    this.disposeCalls = 0;
    this.subscriptionDisposals = 0;
    FakeTerminal.instances.push(this);
  }
  loadAddon(addon) { addon.terminal = this; }
  open(pane) { this.pane = pane; }
  onData(listener) {
    this.input = listener;
    return { dispose: () => { this.subscriptionDisposals += 1; } };
  }
  attachCustomKeyEventHandler(listener) { this.keyHandler = listener; }
  getSelection() { return this.selection ?? ''; }
  clearSelection() { this.selection = ''; }
  paste(text) { this.input(text); }
  write(text) { this.writes.push(text); }
  reset() { this.resetCalls = (this.resetCalls ?? 0) + 1; }
  focus() { this.focusCalls = (this.focusCalls ?? 0) + 1; }
  dispose() { this.disposeCalls += 1; }
}

class FakeFitAddon {
  fit() { this.fitCalls = (this.fitCalls ?? 0) + 1; }
}

function terminal(id, overrides = {}) {
  return {
    id, kind: 'shell', cwd: 'C:\\work', createdAt: 1, chatKey: 'chat', exited: null, ...overrides,
  };
}

/** @param {{ clipboard?: any, getSelection?: () => any }} [options] */
function fixture({ clipboard = null, getSelection: readSelection } = {}) {
  FakeTerminal.instances = [];
  const document = new FakeDocument();
  const window = new FakeWindow();
  const state = createUiState();
  let selection = { tabId: 'all', view: VIEW_TERMINAL, resourceId: 'term-1' };
  const streams = [];
  const fetchCalls = [];
  const apiCalls = [];
  let selected = null;
  const controller = createTerminalView({
    state,
    async api(url, options, requestOptions) {
      apiCalls.push({ url, options, requestOptions });
      if (url.endsWith('/restart')) return { terminal: terminal('term-3') };
      return {};
    },
    async post() { return {}; },
    async fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return { ok: true, async json() { return { terminals: [] }; } };
    },
    createEventSource(url) {
      const stream = { url, closeCalls: 0, close() { this.closeCalls += 1; } };
      streams.push(stream);
      return stream;
    },
    getTerminalConstructor: () => FakeTerminal,
    getFitAddonConstructor: () => FakeFitAddon,
    getSelection: () => readSelection ? readSelection() : selection,
    getActiveProjectCwd: () => null,
    selectTerminal(value) { selected = value; selection = { ...selection, resourceId: value.id }; },
    restoreSelection() {},
    getPlatformCapabilities: () => ({ openFolder: true }),
    toast() {},
    documentRef: /** @type {any} */ (document),
    windowRef: /** @type {any} */ (window),
    navigatorRef: /** @type {any} */ ({ clipboard }),
  });
  return {
    controller, document, window, state, streams, fetchCalls, apiCalls,
    selected: () => selected,
    setSelection(value) { selection = value; },
  };
}

test('terminal view reuses a hidden pane and disposes every acquired resource once', () => {
  const view = fixture();
  view.controller.start();
  view.controller.update({ terminals: [terminal('term-1')] });

  assert.equal(view.controller.show('term-1'), true);
  const instance = FakeTerminal.instances[0];
  assert.equal(FakeTerminal.instances.length, 1);
  assert.equal(view.streams.length, 1);
  assert.equal(instance.options.theme.selectionBackground, 'rgba(47, 224, 192, 0.2)',
    'CSS color functions are resolved before reaching xterm');

  view.streams[0].onmessage({ data: JSON.stringify({ data: 'first chunk' }) });
  view.controller.hide();
  assert.equal(view.document.getElementById('termView').classList.contains('hide'), true);
  assert.equal(view.controller.show('term-1'), true);
  assert.equal(FakeTerminal.instances.length, 1, 'reopening keeps the same xterm instance');
  assert.equal(view.streams.length, 1, 'reopening does not request scrollback through a second stream');
  assert.deepEqual(instance.writes, ['first chunk']);

  view.streams[0].onmessage({ data: JSON.stringify({ exited: 5 }) });
  view.streams[0].onmessage({ data: JSON.stringify({ exited: 5 }) });
  assert.equal(instance.writes.filter((text) => text.includes('process exited')).length, 1);
  assert.equal(instance.options.disableStdin, true);
  assert.equal(view.state.terminals.get('term-1').exited, 5);

  view.controller.dispose();
  assert.equal(view.streams[0].closeCalls, 1);
  assert.equal(instance.subscriptionDisposals, 1);
  assert.equal(instance.disposeCalls, 1);
  assert.equal(view.window.listeners.has('resize'), false);
});

test('terminal view leaves the native context menu available when clipboard is absent', async () => {
  const view = fixture();
  view.controller.start();
  view.controller.update({ terminals: [terminal('term-1')] });
  view.controller.show('term-1');
  let prevented = false;

  await FakeTerminal.instances[0].pane.emit('contextmenu', {
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, false);
  view.controller.dispose();
});

test('terminal actions use one selection snapshot per lookup', async () => {
  let reads = 0;
  const copied = [];
  const view = fixture({
    clipboard: { writeText: async (text) => copied.push(text) },
    getSelection: () => {
      reads += 1;
      return { view: VIEW_TERMINAL, resourceId: reads === 1 ? 'term-1' : 'term-2' };
    },
  });
  view.controller.start();
  view.controller.update({ terminals: [terminal('term-1'), terminal('term-2', { cwd: 'C:\\other' })] });
  reads = 0;
  await view.document.getElementById('terminalCopyPathBtn').emit('click');
  assert.deepEqual(copied, ['C:\\work']);
  assert.equal(reads, 1);
  view.controller.dispose();
});

test('terminal header actions target the selected terminal id', async () => {
  const view = fixture({ clipboard: { writeText: async () => {}, readText: async () => '' } });
  view.controller.start();
  view.controller.update({ terminals: [terminal('term-1'), terminal('term-2', { cwd: 'C:\\other' })] });
  await view.document.getElementById('terminalRestartBtn').emit('click');

  assert.equal(view.apiCalls[0].url, '/api/terminals/term-1/restart');
  assert.equal(view.selected().id, 'term-3');
  view.controller.dispose();
});
