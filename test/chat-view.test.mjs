import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatCache } from '../public/chat-cache.js';
import { createChatView } from '../public/chat-view.js';

class FakeClassList {
  constructor(owner, value = '') {
    this.owner = owner;
    this.values = new Set(value.split(/\s+/).filter(Boolean));
  }
  sync() { this.owner._className = [...this.values].join(' '); }
  add(...names) { names.forEach((name) => this.values.add(name)); this.sync(); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); this.sync(); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.contains(name) : force;
    if (next) this.values.add(name); else this.values.delete(name);
    this.sync();
    return next;
  }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}

function dataName(attribute) {
  return attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

function matches(element, selector) {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (trimmed.includes(',')) return trimmed.split(',').some((part) => matches(element, part));
  if (trimmed === ':scope > .media') return element.classList.contains('media');
  const data = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(trimmed);
  if (data) {
    const value = data[1].startsWith('data-') ? element.dataset[dataName(data[1])] : element.attributes[data[1]];
    return data[2] === undefined ? value !== undefined : value === data[2];
  }
  const parts = trimmed.split('.');
  const tag = parts[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  return parts.slice(tag ? 1 : 1).every((name) => element.classList.contains(name));
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this._className = '';
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this._innerHTML = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.id = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.isConnected = true;
    this.top = 0;
  }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList(this, value);
  }
  get className() { return this._className; }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }
  set innerHTML(value) {
    this._innerHTML = value;
    this._textContent = '';
    this.replaceChildren();
    if (value.includes('class="toolHead"')) {
      const head = new FakeElement('button');
      head.className = 'toolHead';
      for (const name of ['nm', 'sm', 'toolResult', 'st']) {
        const part = new FakeElement('span');
        part.className = name;
        head.appendChild(part);
      }
      const body = new FakeElement('div');
      body.className = 'toolBody';
      const args = new FakeElement('pre');
      args.className = 'args';
      const output = new FakeElement('pre');
      output.className = 'out';
      body.append(args, output);
      this.append(head, body);
    } else if (value.includes('<pre')) {
      for (const match of value.matchAll(/<pre><code(?: class="([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g)) {
        const pre = new FakeElement('pre');
        const code = new FakeElement('code');
        code.className = match[1] ?? '';
        code.textContent = match[2];
        pre.appendChild(code);
        this.appendChild(pre);
      }
    } else if (value.includes('class="body"')) {
      const body = new FakeElement('div');
      body.className = 'body';
      if (value.includes('class="who"')) {
        const who = new FakeElement('div');
        who.className = 'who';
        body.appendChild(who);
      }
      this.appendChild(body);
    }
  }
  get innerHTML() { return this._innerHTML; }
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) - 1] ?? null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      for (const nested of [...child.children]) this.appendChild(nested);
      return child;
    }
    child.removeFromParent();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  prepend(...children) {
    for (const child of children.reverse()) {
      if (child.tagName === '#FRAGMENT') {
        this.prepend(...[...child.children]);
        continue;
      }
      child.removeFromParent();
      child.parentNode = this;
      this.children.unshift(child);
    }
  }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    child.removeFromParent();
    child.parentNode = this;
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  removeFromParent() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  remove() { this.removeFromParent(); this.isConnected = false; }
  after(node) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    node.removeFromParent();
    node.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, node);
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    this.removeFromParent();
    if (node.tagName === '#FRAGMENT') {
      const children = [...node.children];
      children.forEach((child) => child.removeFromParent());
      children.forEach((child, offset) => { child.parentNode = parent; parent.children.splice(index + offset, 0, child); });
    } else {
      node.removeFromParent();
      node.parentNode = parent;
      parent.children.splice(index, 0, node);
    }
    this.isConnected = false;
  }
  querySelectorAll(selector) {
    if (selector.includes(' ')) {
      const [ancestor, descendant] = selector.split(/\s+/, 2);
      return this.querySelectorAll(ancestor).flatMap((element) => element.querySelectorAll(descendant));
    }
    const result = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    const chain = selector.trim().split(/\s+/);
    for (let current = this; current; current = current.parentNode) {
      if (chain.length === 1 && matches(current, selector)) return current;
      if (chain.length === 2 && matches(current, chain[1])) {
        for (let ancestor = current.parentNode; ancestor; ancestor = ancestor.parentNode) {
          if (matches(ancestor, chain[0])) return current;
        }
      }
    }
    return null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }
  async emit(type, event = {}) {
    const payload = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const listener of this.listeners.get(type) ?? []) await listener(payload);
  }
  reportValidity() { return true; }
  setCustomValidity() {}
  getBoundingClientRect() { return { top: this.top ?? 0 }; }
}

class FakeDocument {
  constructor() {
    this.chat = new FakeElement('main');
    this.chat.id = 'chat';
    this.chatWrap = new FakeElement('div');
    this.chatWrap.id = 'chatWrap';
    this.chatWrap.clientHeight = 100;
    this.chatWrap.scrollHeight = 100;
    this.chatWrap.appendChild(this.chat);
  }
  getElementById(id) {
    if (id === 'chat') return this.chat;
    if (id === 'chatWrap') return this.chatWrap;
    const all = [this.chatWrap, ...this.chatWrap.querySelectorAll('[id]')];
    return all.find((element) => element.id === id) ?? null;
  }
  createElement(tagName) { return new FakeElement(tagName); }
  createTextNode(value) { const node = new FakeElement('#text'); node.textContent = value; return node; }
  createDocumentFragment() { return new FakeElement('#fragment'); }
  querySelectorAll(selector) { return this.chatWrap.querySelectorAll(selector); }
}

/**
 * @param {{
 *   post?: (...args: any[]) => Promise<any>,
 *   commands?: any[],
 *   platformCaps?: any,
 *   requestHistoryPage?: (before: number, key: string) => Promise<any>,
 *   isActiveKey?: (key: string) => boolean,
 *   hljs?: any,
 * }} [options]
 */
function fixture({
  post = async (..._args) => ({}),
  commands = [],
  platformCaps = {},
  requestHistoryPage = async () => ({ messages: [], before: null, start: 0 }),
  isActiveKey = () => true,
  hljs = null,
} = {}) {
  const document = new FakeDocument();
  const cache = createChatCache();
  const key = 'chat-a';
  cache.ensure(key);
  const state = {
    model: { provider: 'openai-codex', id: 'gpt-test' },
    turnModel: null,
    pendingAssistantMeta: null,
    queuedPrompts: [],
  };
  const clipboard = [];
  const sanitizeOptions = [];
  let parseCalls = 0;
  const window = {
    sessionStorage: {
      values: new Map(),
      getItem(name) { return this.values.get(name) ?? null; },
      setItem(name, value) { this.values.set(name, value); },
    },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
    marked: {
      setOptions() {}, use() {},
      parse(value) { parseCalls += 1; return value; },
    },
    DOMPurify: {
      sanitize(value, options) { sanitizeOptions.push(options); return value; },
    },
    hljs,
  };
  const awaiting = [];
  const toolEvents = [];
  const controller = createChatView({
    documentRef: /** @type {any} */ (document),
    windowRef: /** @type {any} */ (window),
    cache,
    getKey: () => key,
    getChatState: () => state,
    getModels: () => [{ provider: 'openai-codex', id: 'gpt-test', name: 'GPT Test' }],
    getCommands: () => commands,
    getPlatformCapabilities: () => platformCaps,
    post,
    toast() {},
    setAwaitingInput(value) { awaiting.push(value); },
    setHeroMode() {},
    forkFrom() {},
    cancelQueuedPrompt() {},
    openImage() {},
    requestHistoryPage,
    isActiveKey,
    onToolEvent(event) { toolEvents.push(event); },
  });
  controller.start();
  return {
    controller, document, cache, key, state, clipboard, sanitizeOptions, awaiting, toolEvents,
    parseCalls: () => parseCalls,
  };
}

function messageRaw(view, selector = '.msg.assistant') {
  return view.document.chat.querySelector(selector)?.dataset.raw ?? null;
}

test('history and equivalent live updates share one transcript presentation path', () => {
  const history = fixture();
  history.controller.renderHistory({
    key: history.key,
    messages: [{ role: 'assistant', text: 'Hello **world**' }],
    replace: true,
  });

  const live = fixture();
  live.controller.applyStreamEvent({ kind: 'text', delta: 'Hello ' }, live.state);
  live.controller.applyStreamEvent({ kind: 'text', delta: '**world**' }, live.state);
  live.controller.finalizeStreamingMarkdown();

  assert.equal(messageRaw(history), 'Hello **world**');
  assert.equal(messageRaw(live), messageRaw(history));
  assert.equal(live.parseCalls(), 2, 'the empty bubble and one batched final projection are parsed');

  live.controller.applyStreamEvent({ kind: 'error', message: 'failed safely' }, live.state);
  assert.equal(live.document.chat.querySelector('.msg.sys.err').textContent, '⚠ failed safely');
});

test('interactive form pauses and resumes one turn without duplicating the card', async () => {
  const submitted = [];
  const view = fixture({ post: async (_url, body) => { submitted.push(body); return { values: body.values }; } });
  const event = {
    kind: 'tool', id: 'form-1', name: 'request_form', status: 'start',
    args: { title: 'Details', fields: [{ id: 'name', label: 'Name', type: 'text', required: true }] },
  };
  view.controller.applyStreamEvent(event, view.state);
  const form = view.document.chat.querySelector('.modelForm');
  const input = view.document.chat.querySelector('[data-form-field]');
  input.value = 'Studio';
  await form.emit('input');
  await form.emit('submit');
  view.controller.applyStreamEvent({ ...event, status: 'end', output: JSON.stringify({ status: 'submitted', values: { name: 'Studio' } }) }, view.state);

  assert.deepEqual(submitted, [{ values: { name: 'Studio' } }]);
  assert.equal(view.document.chat.querySelectorAll('.interactiveForm').length, 1);
  assert.equal(view.document.chat.querySelector('.formStatus').textContent, 'Submitted');
  assert.equal(view.awaiting[0], true);
  assert.equal(view.awaiting.at(-1), false);
});

test('parking and restoring a chat preserves its DOM snapshot and scroll', () => {
  const view = fixture();
  view.controller.renderHistory({ key: view.key, messages: [{ role: 'user', text: 'keep me' }], replace: true });
  view.document.chatWrap.scrollTop = 77;

  view.controller.park(view.key);
  assert.equal(view.document.chat.children.length, 0);
  assert.equal(view.cache.peek(view.key).view.scrollTop, 77);

  view.controller.restore(view.key);
  assert.equal(view.document.chat.querySelector('.msg.user').textContent, 'keep me');
  assert.equal(view.document.chatWrap.scrollTop, 77);
});

test('sanitization rejects script URLs and compact skills copy only their invocation', async () => {
  const view = fixture({ commands: [{ source: 'skill', name: 'skill:release-check' }] });
  view.controller.renderHistory({
    key: view.key,
    messages: [
      { role: 'assistant', text: '[bad](javascript:alert(1))' },
      { role: 'user', entryId: 'entry-1', blocks: [{ type: 'skill', name: 'release-check', arguments: '--strict' }] },
    ],
    replace: true,
  });

  const policy = view.sanitizeOptions[0].ALLOWED_URI_REGEXP;
  assert.equal(policy.test('ms-settings:display'), true);
  assert.equal(policy.test('javascript:alert(1)'), false);
  const skill = view.document.chat.querySelector('.skillInvocation');
  skill._textContent = 'SECRET_SKILL_INSTRUCTION_BODY';
  const copy = view.document.chat.querySelectorAll('.msgActionBtn').filter((button) => button.title === 'Copy message').at(-1);
  await copy.emit('click');
  assert.deepEqual(view.clipboard, ['/skill:release-check --strict']);
});

test('a dispatched steering prompt splits the live answer before its continuation', () => {
  const view = fixture({ commands: [] });
  const steer = { id: 'steer', type: 'steer', text: 'redirect', attachments: [] };
  const after = { id: 'after', type: 'followUp', text: 'later', attachments: [] };
  view.controller.applyStreamEvent({ kind: 'text', delta: 'before' }, view.state);
  view.controller.finalizeStreamingMarkdown();
  view.controller.renderQueuedPrompts([steer, after]);
  view.controller.dispatchQueuedPrompts(['steer'], [steer, after], view.state);
  view.controller.applyStreamEvent({ kind: 'text', delta: 'after' }, view.state);
  view.controller.finalizeStreamingMarkdown();

  const turns = view.document.chat.querySelectorAll('.turn');
  assert.equal(turns.length, 3);
  assert.equal(turns[0].querySelector('.msg.assistant').dataset.raw, 'before');
  assert.equal(turns[1].querySelector('.msg.user').textContent, 'redirect');
  assert.equal(turns[2].querySelector('.msg.assistant').dataset.raw, 'after');
});

test('message metadata keeps short runs compact and shows long run duration', () => {
  const view = fixture();
  view.controller.renderHistory({
    key: view.key,
    messages: [
      { role: 'assistant', text: 'short', timestamp: 1, durationMs: 59_999 },
      { role: 'user', text: 'break' },
      { role: 'assistant', text: 'long', timestamp: 2, durationMs: 65_000 },
    ],
    replace: true,
  });

  const metadata = view.document.chat.querySelectorAll('.msgMeta');
  assert.equal(metadata[0].querySelector('.runDuration'), null);
  assert.equal(metadata.at(-1).querySelector('.runDuration').textContent, '(1m 05s)');
});

test('tool cards summarize output and expose one expandable timeline entry', async () => {
  const view = fixture();
  view.controller.applyStreamEvent({ kind: 'tool', id: 'tool-1', name: 'bash', status: 'start', args: { command: 'npm test' } }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'tool-1', name: 'bash', status: 'update', output: 'first line\nsecond line' }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'tool-1', name: 'bash', status: 'end', output: 'first line\nsecond line' }, view.state);

  assert.equal(view.document.chat.querySelectorAll('.toolCard').length, 1);
  assert.equal(view.document.chat.querySelector('.toolResult').textContent, '2 lines · first line');
  const head = view.document.chat.querySelector('.toolHead');
  assert.equal(head.getAttribute('aria-expanded'), null);
  await head.emit('click');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
});

test('live mutations follow the reader only when already at the bottom', () => {
  const view = fixture();
  view.document.chatWrap.scrollHeight = 100;
  view.document.chatWrap.clientHeight = 100;
  view.document.chatWrap.scrollTop = 0;
  view.controller.applyStreamEvent({ kind: 'text', delta: 'first' }, view.state);
  assert.equal(view.document.chatWrap.scrollTop, 100);

  view.controller.finalizeStreamingMarkdown();
  view.document.chatWrap.scrollHeight = 300;
  view.document.chatWrap.clientHeight = 100;
  view.document.chatWrap.scrollTop = 0;
  view.controller.applyStreamEvent({ kind: 'thinking', delta: 'second' }, view.state);
  assert.equal(view.document.chatWrap.scrollTop, 0);
});

test('history is built off-screen without measuring layout per message', () => {
  const view = fixture();
  let layoutReads = 0;
  Object.defineProperty(view.document.chatWrap, 'scrollHeight', {
    configurable: true,
    get() { layoutReads += 1; return 100; },
  });
  view.controller.renderHistory({
    key: view.key,
    messages: Array.from({ length: 400 }, () => ({ role: 'assistant', text: 'hello' })),
    replace: true,
    preserveScroll: true,
  });
  assert.equal(layoutReads, 0);
  assert.equal(view.document.chat.querySelectorAll('.msg.assistant').length, 400);
});

test('older history preserves its anchor and ignores a detached response', async () => {
  const requests = [];
  const view = fixture({
    requestHistoryPage: () => new Promise((resolve) => requests.push(resolve)),
    isActiveKey: () => true,
  });
  view.controller.renderHistory({ key: view.key, messages: [{ role: 'user', text: 'recent' }], before: 80, replace: true });
  const button = view.document.chat.querySelector('.historyMore');
  const anchor = button.nextElementSibling;
  let top = 200;
  anchor.getBoundingClientRect = () => ({ top });
  const originalReplace = button.replaceWith.bind(button);
  button.replaceWith = (fragment) => { originalReplace(fragment); top += 350; };
  view.document.chatWrap.scrollTop = 100;
  const loading = button.emit('click');
  requests.shift()({ messages: [{ role: 'user', text: 'older' }], before: null, start: 40 });
  await loading;
  assert.equal(view.document.chatWrap.scrollTop, 450);

  view.controller.renderHistory({ key: view.key, messages: [{ role: 'user', text: 'recent' }], before: 40, replace: true });
  const staleButton = view.document.chat.querySelector('.historyMore');
  const stale = staleButton.emit('click');
  staleButton.isConnected = false;
  requests.shift()({ messages: [{ role: 'user', text: 'must not render' }], before: null, start: 0 });
  await stale;
  assert.equal(view.document.chat.querySelectorAll('.msg.user').some((message) => message.textContent === 'must not render'), false);
});

test('markdown decoration highlights only supported code within budget and marks shell commands', () => {
  const highlighted = [];
  const view = fixture({
    platformCaps: { typeInTerminal: true },
    hljs: {
      getLanguage: (name) => name === 'js' || name === 'bash',
      highlightElement: (element) => highlighted.push(element),
    },
  });
  const huge = 'x'.repeat(50_001);
  view.controller.renderHistory({
    key: view.key,
    messages: [{
      role: 'assistant',
      text: `<pre><code class="language-unknown">skip</code></pre>`
        + `<pre><code class="language-js">${huge}</code></pre>`
        + '<pre><code class="language-js">const ok = true;</code></pre>'
        + '<pre><code class="language-bash">npm test</code></pre>'
        + '<pre><code>echo ok</code></pre>',
    }],
    replace: true,
  });

  assert.deepEqual(highlighted.map((element) => element.textContent), ['const ok = true;', 'npm test']);
  assert.equal(view.document.chat.querySelectorAll('.codeCopyBtn').length, 5);
  assert.equal(view.document.chat.querySelectorAll('.codeRunBtn').length, 2,
    'only one-line supported shell-like blocks receive run controls');
});

test('local links use the guarded endpoint while external links stay with the browser', async () => {
  const calls = [];
  const view = fixture({ post: async (...args) => { calls.push(args); return { path: 'opened' }; } });
  const message = new FakeElement('div');
  message.className = 'md';
  const local = new FakeElement('a');
  local.setAttribute('href', './public/app.js:42');
  message.appendChild(local);
  view.document.chat.appendChild(message);
  await view.document.chat.emit('click', { target: local });
  assert.equal(calls[0][0], '/api/open-local-path');
  assert.deepEqual(calls[0][1], { href: './public/app.js:42' });

  const external = new FakeElement('a');
  external.setAttribute('href', 'https://example.com/docs');
  message.appendChild(external);
  await view.document.chat.emit('click', { target: external });
  assert.equal(calls.length, 1);
});

test('the module starts and disposes its root listener explicitly', () => {
  const view = fixture();
  assert.equal(view.document.chat.listeners.get('click').length, 1);
  view.controller.start();
  assert.equal(view.document.chat.listeners.get('click').length, 1);
  view.controller.dispose();
  assert.equal(view.document.chat.listeners.get('click').length, 0);
});
