import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentInputs } from '../public/agent-inputs.js';
import { createSettingsView } from '../public/settings-view.js';

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
  constructor(document, { id = '', tagName = 'div', attrs = '' } = {}) {
    this.ownerDocument = document;
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList(/class="([^"]*)"/.exec(attrs)?.[1] ?? '');
    this.listeners = new Map();
    this.children = [];
    this.descendants = [];
    this.textContent = '';
    this.value = /value="([^"]*)"/.exec(attrs)?.[1] ?? '';
    this.checked = /\schecked(?:\s|>|$)/.test(attrs);
    this.disabled = false;
    this.scrollTop = 0;
    this.top = 0;
    this.scrollRequest = null;
    for (const [, raw, value] of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) {
      const key = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }
  set innerHTML(value) {
    this._innerHTML = value;
    this.descendants = this.ownerDocument.capture(value);
  }
  get innerHTML() { return this._innerHTML ?? ''; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => entry !== listener));
  }
  listenerCount(type) { return (this.listeners.get(type) ?? []).length; }
  async emit(type, event = {}) {
    const payload = { target: this, preventDefault() {}, ...event };
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(payload)));
  }
  appendChild(child) { this.children.push(child); return child; }
  querySelectorAll(selector) {
    const nodes = [...this.children, ...this.descendants];
    if (selector === '.snavItem') return nodes.filter((node) => node.classList.contains('snavItem'));
    if (selector === '.sw[data-key]') return nodes.filter((node) => node.classList.contains('sw') && node.dataset.key);
    if (selector === 'select[data-key]') return nodes.filter((node) => node.tagName === 'SELECT' && node.dataset.key);
    if (selector === 'input[data-key]') return nodes.filter((node) => node.tagName === 'INPUT' && node.dataset.key);
    if (selector === '.themeCard[data-t]') return nodes.filter((node) => node.classList.contains('themeCard') && 't' in node.dataset);
    if (selector === '.accentDot[data-a]') return nodes.filter((node) => node.classList.contains('accentDot') && 'a' in node.dataset);
    if (selector === '.logoStyleCard') return nodes.filter((node) => node.classList.contains('logoStyleCard'));
    return [];
  }
  querySelector() { return null; }
  getBoundingClientRect() { return { top: this.top }; }
  scrollTo(options) { this.scrollRequest = options; }
  scrollIntoView() {}
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.documentElement = { dataset: { theme: 'paseo' } };
    for (const id of ['settingsView', 'settingsNav', 'settingsBody', 'analytics', 'agentDir']) {
      this.elements.set(id, new FakeElement(this, { id }));
    }
  }
  getElementById(id) { return this.elements.get(id) ?? null; }
  createElement(tagName) { return new FakeElement(this, { tagName }); }
  querySelectorAll() { return []; }
  capture(html) {
    const nodes = [];
    for (const match of html.matchAll(/<([a-z][\w-]*)([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const node = new FakeElement(this, { id: match[3], tagName: match[1], attrs: match[2] });
      this.elements.set(node.id, node);
      nodes.push(node);
    }
    return nodes;
  }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[char]));

function fixture({ deferNetwork = false } = {}) {
  const document = new FakeDocument();
  const calls = [];
  const networkResolvers = [];
  let saveResult = { error: 'disk full' };
  const responses = {
    '/api/settings': {
      agentDir: '/agent', path: '/agent/settings.json', extras: [], raw: { featureFlag: false },
      sections: [{ name: 'General', items: [{
        key: 'featureFlag', value: false, editable: true, type: 'boolean',
        description: 'Test setting', default: 'false', set: true,
      }] }],
    },
    '/api/config/refresh': { ok: true, aborted: false, failedProviders: [] },
    '/api/config': {
      platform: { os: 'win32', openTextFile: true }, paths: { agentDir: '/agent' },
      current: null, thinkingLevel: 'off', thinkingLevels: ['off'], cwd: '/project', sessionFile: null,
      providers: [], tools: [], models: [], options: {}, rawModels: {},
    },
    '/api/usage/config': { openai: {}, anthropic: {}, kimi: {} },
    '/api/agent-bootstrap': { files: [], tools: [], commands: [], toolsMode: 'pi-default', effectivePrompt: '' },
    '/api/analytics': { files: 0, buckets: [], models: [], projects: [] },
    '/api/network': { lanAccess: false, ip: null, restartRequired: false },
    '/api/archiving': { enabled: true },
    '/api/title-generation': { enabled: false, lunaTitleFallback: false },
    '/api/full-search': { enabled: false },
  };
  const api = async (url, options, requestOptions) => {
    calls.push({ kind: 'api', url, options, requestOptions });
    if (deferNetwork && url === '/api/network') {
      return await new Promise((resolve) => networkResolvers.push(() => resolve(structuredClone(responses[url]))));
    }
    return structuredClone(responses[url] ?? {});
  };
  const post = async (url, body, requestOptions) => {
    calls.push({ kind: 'post', url, body, requestOptions });
    if (url === '/api/settings') return structuredClone(saveResult);
    return structuredClone(responses[url] ?? {});
  };
  const sendJson = async (method, url, body, requestOptions) => {
    calls.push({ kind: 'sendJson', method, url, body, requestOptions });
    return structuredClone(responses[url] ?? {});
  };
  const agentInputs = createAgentInputs({
    escapeHtml, post, sendJson, toast() {}, getPlatformCapabilities: () => responses['/api/config'].platform,
    confirmAction: () => true,
  });
  let chatArchiving = true;
  const controller = createSettingsView({
    api, post, sendJson, escapeHtml,
    formatNumber: String, formatMoney: (value) => `$${value.toFixed(2)}`,
    applyPlatformCapabilities() {},
    applyChatArchiving(value) { chatArchiving = value; },
    getChatArchiving: () => chatArchiving,
    async loadSessions() {}, async refreshUsage() {}, async loadModels() {},
    applyTheme() {}, applyAccent() {}, applyLogoStyle() {},
    themes: [{ id: 'paseo', name: 'Paseo', cols: ['#fff'] }],
    accents: [{ id: '', name: 'Default', col: '' }],
    logoStyles: [{ id: 'brand', name: 'Provider colours' }],
    agentInputs, getRenderedChatKey: () => 'chat-key', setSidebarCollapsed() {},
    getChatNotifications: () => false, setChatNotifications() {},
  });
  return {
    document,
    calls,
    controller,
    setSaveResult(value) { saveResult = value; },
    resolveNetwork() { networkResolvers.shift()?.(); },
  };
}

async function withBrowserGlobals(run) {
  const descriptors = new Map();
  for (const [key, value] of Object.entries({
    document: null,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null },
    navigator: { clipboard: { writeText: async () => {} } },
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try { return await run((document) => { globalThis.document = document; }); }
  finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('settings view saves only confirmed values and reopens without duplicate lifecycle work', async () => {
  await withBrowserGlobals(async (installDocument) => {
    const state = fixture();
    installDocument(state.document);

    const first = state.controller.show();
    const duplicate = state.controller.show();
    await Promise.all([first, duplicate]);

    assert.equal(state.document.getElementById('settingsView').listenerCount('scroll'), 0);
    assert.equal(state.calls.filter((call) => call.url === '/api/settings' && call.kind === 'api').length, 1,
      'a concurrent show shares the in-flight load');
    assert.equal(state.calls.filter((call) => call.url === '/api/analytics').length, 1);
    const settingsView = state.document.getElementById('settingsView');
    settingsView.scrollTop = 80;
    const themeNav = state.document.getElementById('settingsNav').children
      .find((item) => item.dataset.target === 'sec-theme');
    await themeNav.emit('click');
    assert.equal(settingsView.scrollTop, 0);

    const setting = state.document.getElementById('set_featureFlag');
    const saved = state.document.getElementById('set_featureFlag_ok');
    assert.ok(setting);
    await setting.emit('click');
    assert.equal(setting.classList.contains('on'), false, 'a failed write does not publish the requested value');
    assert.equal(saved.classList.contains('show'), false, 'a failed write does not show saved');

    state.setSaveResult({ value: true, restart: false });
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = /** @type {typeof setTimeout} */ (/** @type {unknown} */ (() => 0));
    try { await setting.emit('click'); }
    finally { globalThis.setTimeout = originalSetTimeout; }
    assert.equal(setting.classList.contains('on'), true);
    assert.equal(saved.classList.contains('show'), true);

    state.controller.hide();
    assert.equal(state.document.getElementById('settingsView').listenerCount('scroll'), 0);
    await state.controller.show();
    assert.equal(state.document.getElementById('settingsView').listenerCount('scroll'), 0);
    assert.equal(state.calls.filter((call) => call.url === '/api/settings' && call.kind === 'api').length, 2);
    assert.equal(state.calls.filter((call) => call.url === '/api/analytics').length, 1,
      'cached analytics is rendered without a duplicate request');
  });
});

test('settings switches keep click and keyboard activation on their own endpoints', async () => {
  await withBrowserGlobals(async (installDocument) => {
    const state = fixture();
    installDocument(state.document);
    await state.controller.show();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = /** @type {typeof setTimeout} */ (/** @type {unknown} */ (() => 0));
    try {
      for (const [id, url, kind] of [
        ['lanAccessSw', '/api/network', 'post'],
        ['chatArchivingSw', '/api/archiving', 'sendJson'],
        ['titleGenSw', '/api/title-generation', 'sendJson'],
        ['lunaTitleFallbackSw', '/api/title-generation', 'sendJson'],
        ['fullSearchSw', '/api/full-search', 'sendJson'],
        ['openaiUsageSw', '/api/usage/config', 'post'],
        ['set_featureFlag', '/api/settings', 'post'],
      ]) {
        const switchElement = state.document.getElementById(id);
        const before = state.calls.length;
        let prevented = false;
        await switchElement.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
        assert.equal(state.calls.length, before, `${id}: other keys do nothing`);
        for (const key of ['Enter', ' ']) {
          await switchElement.emit('keydown', { key, preventDefault() { prevented = true; } });
          assert.equal(prevented, true, `${id}: ${key} prevents the browser default`);
          assert.equal(state.calls.at(-1).url, url);
          assert.equal(state.calls.at(-1).kind, kind);
          prevented = false;
        }
        await switchElement.emit('click');
        assert.equal(state.calls.at(-1).url, url);
      }
      assert.deepEqual(state.calls.filter((call) => call.url === '/api/title-generation' && call.kind === 'sendJson')
        .map((call) => call.body), [
          { enabled: true }, { enabled: true }, { enabled: true },
          { lunaTitleFallback: true }, { lunaTitleFallback: true }, { lunaTitleFallback: true },
        ]);
    } finally { globalThis.setTimeout = originalSetTimeout; }
  });
});

test('refresh requests live provider catalogs and fetches fresh configuration', async () => {
  await withBrowserGlobals(async (installDocument) => {
    const state = fixture();
    installDocument(state.document);
    await state.controller.show();
    await state.document.getElementById('refreshCatalog').emit('click');
    assert.equal(state.calls.filter((call) => call.url === '/api/config/refresh' && call.kind === 'post').length, 1);
    assert.equal(state.calls.filter((call) => call.url === '/api/config' && call.kind === 'api').length, 2);
    assert.equal(state.document.getElementById('refreshMsg').textContent, 'Providers and models updated.');
  });
});

test('a hidden settings render cannot bind controls from the next opening', async () => {
  await withBrowserGlobals(async (installDocument) => {
    const state = fixture({ deferNetwork: true });
    installDocument(state.document);

    const first = state.controller.show();
    while (state.calls.filter((call) => call.url === '/api/network').length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    state.controller.hide();
    const second = state.controller.show();
    while (state.calls.filter((call) => call.url === '/api/network').length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    state.resolveNetwork();
    await first;
    state.resolveNetwork();
    await second;

    assert.equal(state.document.getElementById('lanAccessSw').listenerCount('click'), 1);
  });
});

test('shared agent-input editor preserves scope and refreshes only after a confirmed save', async () => {
  const calls = [];
  /** @type {any} */
  let result = { error: 'disk full' };
  const controls = new Map();
  const button = new FakeElement({ capture: () => [] });
  button.dataset.bootstrapSave = 'project-context';
  const promote = new FakeElement({ capture: () => [] });
  promote.dataset.bootstrapSource = 'project-context';
  promote.dataset.bootstrapPromote = 'global-context';
  const editor = { value: 'project instructions' };
  const message = { textContent: '' };
  const root = {
    querySelectorAll: (selector) => selector === '[data-bootstrap-save]' ? [button]
      : selector === '[data-bootstrap-promote]' ? [promote] : [],
    querySelector: (selector) => controls.get(selector) ?? null,
  };
  controls.set('[data-bootstrap-editor="project-context"]', editor);
  controls.set('[data-bootstrap-message="project-context"]', message);
  let refreshes = 0;
  const inputs = createAgentInputs({
    escapeHtml,
    async post() { return {}; },
    async sendJson(method, url, body) { calls.push({ method, url, body }); return result; },
    toast() {}, getPlatformCapabilities: () => ({ os: 'win32', openTextFile: true }),
    confirmAction: () => true,
  });
  const html = inputs.fileEditor({
    id: 'project-context', label: 'CLAUDE.md', path: 'C:/project/CLAUDE.md', scope: 'project',
    kinds: ['context'], exists: true, active: true, content: 'project instructions',
  });
  assert.match(html, />project<\/span>/);
  const globalHtml = inputs.fileEditor({
    id: 'global-context', label: 'CLAUDE.md', path: 'C:/agent/CLAUDE.md', scope: 'global',
    kinds: ['context'], exists: true, active: true, content: 'global instructions',
  });
  assert.match(globalHtml, />global<\/span>/);
  assert.doesNotMatch(html, />global<\/span>/, 'project and global editors keep their own scope');
  inputs.bindFileActions(root, { key: 'chat-key', refresh: async () => { refreshes += 1; } });

  await button.emit('click');
  assert.equal(message.textContent, 'disk full');
  assert.equal(refreshes, 0);
  result = { ok: true };
  await button.emit('click');
  assert.equal(refreshes, 1);
  assert.deepEqual(calls.at(-1), {
    method: 'PUT', url: '/api/agent-bootstrap/file',
    body: { id: 'project-context', content: 'project instructions' },
  });
  result = { error: 'disk full' };
  await promote.emit('click');
  assert.equal(refreshes, 1, 'a failed promotion does not refresh the editor');
  assert.equal(promote.disabled, false);
  result = { ok: true };
  await promote.emit('click');
  assert.equal(refreshes, 2);
  assert.deepEqual(calls.at(-1), {
    method: 'PUT', url: '/api/agent-bootstrap/file',
    body: { id: 'global-context', content: 'project instructions' },
  });
});
