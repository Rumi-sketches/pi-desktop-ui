import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatCache } from '../public/chat-cache.js';
import { createChatView, decorateMarkdownAlert } from '../public/chat-view.js';

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
      for (const name of ['toolIcon', 'nm', 'sm', 'toolResult']) {
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
    this.root = new FakeElement('div');
    this.chat = new FakeElement('main');
    this.chat.id = 'chat';
    this.chatWrap = new FakeElement('div');
    this.chatWrap.id = 'chatWrap';
    this.chatWrap.clientHeight = 100;
    this.chatWrap.scrollHeight = 100;
    this.chatWrap.appendChild(this.chat);
    this.formDock = new FakeElement('div');
    this.formDock.id = 'formDock';
    this.root.append(this.chatWrap, this.formDock);
  }
  getElementById(id) {
    if (id === 'chat') return this.chat;
    if (id === 'chatWrap') return this.chatWrap;
    if (id === 'formDock') return this.formDock;
    const all = [this.root, ...this.root.querySelectorAll('[id]')];
    return all.find((element) => element.id === id) ?? null;
  }
  createElement(tagName) { return new FakeElement(tagName); }
  createTextNode(value) { const node = new FakeElement('#text'); node.textContent = value; return node; }
  createDocumentFragment() { return new FakeElement('#fragment'); }
  querySelectorAll(selector) { return this.root.querySelectorAll(selector); }
}

/**
 * @param {{
 *   post?: (...args: any[]) => Promise<any>,
 *   commands?: any[],
 *   platformCaps?: any,
 *   requestHistoryPage?: (before: number, key: string) => Promise<any>,
 *   isActiveKey?: (key: string) => boolean,
 *   hljs?: any,
 *   localStorage?: any,
 *   workStyle?: string,
 * }} [options]
 */
function fixture({
  post = async (..._args) => ({}),
  commands = [],
  platformCaps = {},
  requestHistoryPage = async () => ({ messages: [], before: null, start: 0 }),
  isActiveKey = () => true,
  hljs = null,
  localStorage = null,
  workStyle = 'block',
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
    ...(localStorage ? { localStorage } : {}),
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
    getWorkStyle: () => workStyle,
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
  const form = view.document.formDock.querySelector('.modelForm');
  const input = view.document.formDock.querySelector('[data-form-field]');
  input.value = 'Studio';
  await form.emit('input');
  await form.emit('submit');
  view.controller.applyStreamEvent({ ...event, status: 'end', output: JSON.stringify({ status: 'submitted', values: { name: 'Studio' } }) }, view.state);

  assert.deepEqual(submitted, [{ values: { name: 'Studio' } }]);
  assert.equal(view.document.chat.querySelectorAll('.interactiveForm').length, 1);
  assert.equal(view.document.formDock.children.length, 0);
  assert.equal(view.document.chat.querySelector('.formStatus').textContent, 'Submitted');
  assert.equal(view.awaiting[0], true);
  assert.equal(view.awaiting.at(-1), false);
});

test('a pending form can be skipped without answers and releases its dock', async () => {
  const requests = [];
  const view = fixture({ post: async (url, body) => {
    requests.push({ url, body });
    return { ok: true };
  } });
  const tool = {
    id: 'form-skip', name: 'request_form',
    args: { title: 'Optional question', fields: [{ id: 'answer', label: 'Answer', type: 'text', required: true }] },
  };
  // An interrupted form reconstructed from history is still actionable.
  view.controller.renderHistory({
    key: view.key,
    messages: [{ role: 'assistant', blocks: [{ type: 'tool', ...tool, status: 'start' }] }],
    replace: true,
  });
  const card = view.document.formDock.querySelector('.interactiveForm');
  assert.ok(card);
  await card.querySelector('.formSkip').emit('click');
  assert.deepEqual(requests, [{ url: '/api/forms/form-skip/skip', body: {} }]);
  assert.equal(view.document.formDock.children.length, 0);
  assert.equal(card.querySelector('.formStatus').textContent, 'Skipped');
  assert.equal(view.awaiting.at(-1), false);
});

test('an early form response conflict keeps the question retryable', async () => {
  const view = fixture({ post: async () => ({ error: 'not ready', code: 'form_not_pending' }) });
  view.controller.applyStreamEvent({
    kind: 'tool', id: 'form-race', name: 'request_form', status: 'start',
    args: { title: 'Question', fields: [{ id: 'answer', label: 'Answer', type: 'text' }] },
  }, view.state);
  const card = view.document.formDock.querySelector('.interactiveForm');
  await card.querySelector('.formSkip').emit('click');
  assert.equal(card.classList.contains('pending'), true);
  assert.equal(card.querySelector('.formSkip').disabled, false);
  assert.equal(view.awaiting.at(-1), true);
});

test('skipping a live form keeps the composer paused until the turn settles', async () => {
  const view = fixture({ post: async () => ({ ok: true }) });
  view.state.streaming = true;
  view.controller.applyStreamEvent({
    kind: 'tool', id: 'form-live-skip', name: 'request_form', status: 'start',
    args: { title: 'Question', fields: [{ id: 'answer', label: 'Answer', type: 'text' }] },
  }, view.state);
  const card = view.document.formDock.querySelector('.interactiveForm');
  await card.querySelector('.formSkip').emit('click');
  view.controller.applyStreamEvent({ kind: 'tool', id: 'form-live-skip', name: 'request_form',
    status: 'end', output: JSON.stringify({ status: 'skipped' }) }, view.state);
  assert.equal(view.awaiting.at(-1), true);
  assert.equal(card.querySelector('.formStatus').textContent, 'Skipped');
});

test('answers typed into an interrupted form survive a fresh desktop view', async () => {
  const storage = {
    values: new Map(),
    getItem(name) { return this.values.get(name) ?? null; },
    setItem(name, value) { this.values.set(name, value); },
  };
  const tool = {
    id: 'form-reopen', name: 'request_form',
    args: { title: 'Question', fields: [{ id: 'color', label: 'Color', type: 'text', required: true }] },
  };
  const first = fixture({ localStorage: storage });
  first.controller.renderHistory({ key: first.key, messages: [{ role: 'assistant', blocks: [{ type: 'tool', ...tool, status: 'start' }] }], replace: true });
  const answer = first.document.formDock.querySelector('[data-form-field]');
  answer.value = 'blue';
  await first.document.formDock.querySelector('.modelForm').emit('input', { target: answer });

  const reopened = fixture({ localStorage: storage });
  reopened.controller.renderHistory({ key: reopened.key, messages: [{ role: 'assistant', blocks: [{ type: 'tool', ...tool, status: 'start' }] }], replace: true });
  assert.equal(reopened.document.formDock.querySelector('[data-form-field]').value, 'blue');
});

test('docked questions keep custom answers, navigation and chat snapshots', async () => {
  const submitted = [];
  const view = fixture({ post: async (_url, body) => {
    submitted.push(body);
    return { values: { platform: 'Linux', features: ['sync', 'Local export'], note: 'Keep it local' } };
  } });
  const event = {
    kind: 'tool', id: 'form-choices', name: 'request_form', status: 'start',
    args: { title: 'Project choices', fields: [
      { id: 'platform', label: 'Platform', type: 'radio', required: true, options: [{ value: 'web', label: 'Web' }] },
      { id: 'features', label: 'Features', type: 'multiselect', required: true, options: [{ value: 'sync', label: 'Sync' }] },
      { id: 'note', label: 'Final note', type: 'text', required: true },
    ] },
  };
  view.controller.applyStreamEvent(event, view.state);
  const card = view.document.formDock.querySelector('.interactiveForm');
  const form = card.querySelector('.modelForm');
  assert.equal(card.querySelector('.formQuestionCount').textContent, '1 of 3 ▾');
  assert.equal(view.document.chat.querySelectorAll('.formTranscriptAnchor').length, 1);

  const platformCustom = card.querySelectorAll('[data-form-custom]').find((item) => item.dataset.formCustom === 'platform');
  platformCustom.value = 'Linux';
  await form.emit('input', { target: platformCustom });
  await form.emit('submit');
  assert.equal(card.querySelector('.formQuestionCount').textContent, '2 of 3 ▾');

  view.controller.park(view.key);
  assert.equal(view.document.formDock.children.length, 0);
  view.controller.restore(view.key);
  assert.equal(view.document.formDock.querySelector('.interactiveForm'), card);
  assert.equal(card.querySelector('.formQuestionCount').textContent, '2 of 3 ▾');

  const sync = card.querySelectorAll('[data-form-field]').find((item) => item.dataset.formField === 'features');
  sync.checked = true;
  await form.emit('change', { target: sync });
  const featuresCustom = card.querySelectorAll('[data-form-custom]').find((item) => item.dataset.formCustom === 'features');
  featuresCustom.value = 'Local export';
  await form.emit('input', { target: featuresCustom });
  await form.emit('submit');
  const note = card.querySelectorAll('[data-form-field]').find((item) => item.dataset.formField === 'note');
  note.value = 'Keep it local';
  await form.emit('input', { target: note });
  await form.emit('submit');

  assert.deepEqual(submitted, [{ values: {
    platform: { custom: 'Linux' },
    features: { selected: ['sync'], custom: 'Local export' },
    note: 'Keep it local',
  } }]);
  assert.equal(view.document.formDock.children.length, 0);
  assert.equal(view.document.chat.querySelector('.interactiveForm'), card);
  assert.equal(card.querySelector('.formStatus').textContent, 'Submitted');
});

test('history puts only a still-pending form beside the composer', () => {
  const tool = {
    id: 'form-history', name: 'request_form',
    args: { title: 'Details', fields: [{ id: 'name', label: 'Name', type: 'text', required: true }] },
  };
  const pending = fixture();
  pending.controller.renderHistory({ key: pending.key, messages: [], live: [{ type: 'tool', tool: { ...tool, status: 'start' } }], replace: true });
  assert.equal(pending.document.formDock.querySelector('.interactiveForm')?.classList.contains('isDocked'), true);
  assert.equal(pending.document.chat.querySelectorAll('.formTranscriptAnchor').length, 1);

  const completed = fixture();
  completed.controller.renderHistory({
    key: completed.key,
    messages: [{ role: 'assistant', blocks: [{ type: 'tool', ...tool, status: 'end',
      output: JSON.stringify({ status: 'submitted', values: { name: 'Studio' } }),
    }] }],
    replace: true,
  });
  assert.equal(completed.document.formDock.children.length, 0);
  assert.equal(completed.document.chat.querySelector('.interactiveForm')?.classList.contains('submitted'), true);
});

test('question count menu switches steps without losing a draft answer', async () => {
  const view = fixture();
  view.controller.applyStreamEvent({
    kind: 'tool', id: 'form-menu', name: 'request_form', status: 'start',
    args: { title: 'Choices', fields: [
      { id: 'first', label: 'First?', type: 'radio', options: [{ value: 'yes', label: 'Yes' }] },
      { id: 'second', label: 'Second?', type: 'text' },
      { id: 'third', label: 'Third?', type: 'text' },
    ] },
  }, view.state);
  const card = view.document.formDock.querySelector('.interactiveForm');
  const custom = card.querySelector('[data-form-custom]');
  custom.value = 'Something else';
  await card.querySelector('.modelForm').emit('input', { target: custom });
  const count = card.querySelector('.formQuestionCount');
  await count.emit('click');
  const menu = card.querySelector('.formQuestionMenu');
  assert.equal(menu.hidden, false);
  await menu.emit('click', { target: menu.children[2] });
  assert.equal(count.textContent, '3 of 3 ▾');
  await count.emit('click');
  await menu.emit('click', { target: menu.children[0] });
  assert.equal(custom.value, 'Something else');
  assert.equal(count.textContent, '1 of 3 ▾');
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

test('sanitization preserves web and local paths without permitting unknown protocols', () => {
  const view = fixture();
  view.controller.renderHistory({
    key: view.key,
    messages: [{ role: 'assistant', text: '[skill](C:/Users/Mimmo/.claude/skills/code-review/SKILL.md)' }],
    replace: true,
  });
  const policy = view.sanitizeOptions[0].ALLOWED_URI_REGEXP;
  for (const href of [
    'https://example.com/docs', 'http://example.com', 'mailto:reader@example.com',
    './README.md', '../docs/notes.html', 'docs/file%20with%20spaces.md#L12',
    'C:/Users/Mimmo/.claude/skills/code-review/SKILL.md',
    'd:/Projects/folder with spaces/report (final).html',
    String.raw`C:\Users\Mimmo\file.md`,
    'C:%5CUsers%5CMimmo%5Cfile.md', 'C:%2FUsers%2FMimmo%2Ffile.md',
    '/C:/Users/Mimmo/file.md', 'file:///C:/Users/Mimmo/file.md',
    '#section', 'ms-settings:display',
  ]) assert.equal(policy.test(href), true, href);
  for (const href of [
    'javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,bad',
    'custom-app:run', 'customapp:run', 'c:drive-relative.md',
  ]) assert.equal(policy.test(href), false, href);
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

function workBlocks(view) {
  return view.document.chat.querySelectorAll('.workBlock');
}

function headline(block) {
  return block.querySelector('.wbHeadline').dataset.text;
}

test('reasoning and tool calls share one closed work block that names the current step', () => {
  const view = fixture();
  view.state.responseStartedAt = Date.now() - 20_000;
  view.controller.applyStreamEvent({ kind: 'thinking', delta: '**Locating the bug**\n\nFirst look at ' }, view.state);
  view.controller.applyStreamEvent({ kind: 'thinking', delta: '`sendBtn`.' }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'read-1', name: 'read', status: 'start', summary: 'public/app.js', args: {} }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'bash-1', name: 'bash', status: 'start', summary: 'npm test', args: {} }, view.state);

  const [block, ...others] = workBlocks(view);
  assert.equal(others.length, 0);
  assert.equal(block.dataset.level, 'closed');
  assert.ok(block.classList.contains('live'));
  assert.equal(block.querySelector('.wbHead').getAttribute('aria-expanded'), 'false');
  assert.equal(headline(block), 'Locating the bug');
  const paragraphs = block.querySelectorAll('.wbPara');
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.classList.contains('isHeading')), [true, false]);
  assert.equal(paragraphs[1].querySelector('code').textContent, 'sendBtn');
  assert.deepEqual(block.querySelectorAll('.toolCard .nm').map((name) => name.textContent), ['Reading', 'Running']);
  assert.match(block.querySelector('.wbMeta').textContent, /^2 tools · 0:2\d$/, 'the clock matches the run timer');

  view.controller.applyStreamEvent({ kind: 'tool', id: 'read-1', name: 'read', status: 'end', output: 'one\ntwo' }, view.state);
  assert.equal(block.querySelector('.toolCard .nm').textContent, 'Read');
});

test('a finished tool keeps the summary until the next step instead of falling back to Thinking', () => {
  const view = fixture();
  const event = (payload) => view.controller.applyStreamEvent(payload, view.state);
  event({ kind: 'thinking', delta: 'Look at the docs first.' });
  const [block] = workBlocks(view);
  assert.equal(headline(block), 'Thinking');
  event({ kind: 'tool', id: 'ls-1', name: 'ls', status: 'start', summary: 'docs', args: {} });
  assert.equal(headline(block), 'Listing docs');
  assert.deepEqual(block.querySelectorAll('.wbLine').map((line) => line.textContent), ['Thinking', 'Listing docs'],
    'a new tool changes the summary once, straight to its verb and target');
  event({ kind: 'tool', id: 'ls-1', name: 'ls', status: 'end', output: 'api.md' });
  assert.equal(headline(block), 'Listed docs');
  event({ kind: 'thinking', delta: 'Now the API reference.' });
  assert.equal(headline(block), 'Listed docs');
  event({ kind: 'tool', id: 'read-1', name: 'read', status: 'start', summary: 'docs/api.md', args: {} });
  assert.equal(headline(block), 'Reading docs/api.md');
});

test('assistant text followed by more work becomes an interim update and leads the summary', () => {
  const view = fixture();
  view.controller.applyStreamEvent({ kind: 'thinking', delta: '**Reading the composer**' }, view.state);
  view.controller.applyStreamEvent({ kind: 'text', delta: 'Found the cause. Fixing it now.' }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'edit-1', name: 'edit', status: 'start', args: {} }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'edit-1', name: 'edit', status: 'end', isError: true, output: 'no match' }, view.state);
  view.controller.applyStreamEvent({ kind: 'text', delta: 'Done.' }, view.state);
  view.controller.finalizeStreamingMarkdown();

  const [block] = workBlocks(view);
  assert.equal(workBlocks(view).length, 1);
  const update = block.querySelector('.wbUpdate .msg.assistant');
  assert.equal(update.dataset.raw, 'Found the cause. Fixing it now.');
  assert.equal(headline(block), 'Found the cause. Fixing it now.');
  const answer = view.document.chat.querySelectorAll('.msg.assistant').at(-1);
  assert.equal(answer.dataset.raw, 'Done.');
  assert.equal(answer.closest('.workBlock'), null, 'the final answer stays in the flow');
  assert.equal(block.querySelector('.wbFailed').textContent, ' · 1 failed');

  view.controller.clearSegments();
  assert.equal(block.classList.contains('live'), false);
  assert.match(headline(block), /^Worked for \d+s$/);
  assert.equal(block.querySelector('.wbMeta').textContent, '1 edit · 1 failed');
});

test('the summary row cycles closed, peek and full, and peek keeps only the latest steps', async () => {
  const view = fixture();
  const event = (payload) => view.controller.applyStreamEvent(payload, view.state);
  event({ kind: 'thinking', delta: 'Start here.' });
  event({ kind: 'tool', id: 'grep-1', name: 'grep', status: 'start', args: {} });
  event({ kind: 'text', delta: 'Narrowed it down.' });
  event({ kind: 'thinking', delta: 'First idea.\n\nSecond idea.' });
  event({ kind: 'tool', id: 'read-1', name: 'read', status: 'start', args: {} });
  const [block] = workBlocks(view);
  const head = block.querySelector('.wbHead');
  const more = block.querySelector('.wbMore');

  await view.document.chat.emit('click', { target: head });
  assert.equal(block.dataset.level, 'peek');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  const tail = block.querySelectorAll('.wbStep').filter((step) => step.classList.contains('isTail'));
  assert.deepEqual(tail.map((step) => step.classList.contains('wbThought') ? 'thought' : 'tool'), ['thought', 'tool']);
  assert.equal(tail[0].querySelectorAll('.wbPara').length, 2, 'peek hides the earlier paragraph with CSS, not by removal');
  assert.equal(block.querySelector('.wbFoot').hidden, false);
  assert.equal(more.textContent, 'Show all 5 steps');

  await view.document.chat.emit('click', { target: more });
  assert.equal(block.dataset.level, 'full');
  assert.equal(more.textContent, 'Show less');
  await view.document.chat.emit('click', { target: head });
  assert.equal(block.dataset.level, 'closed');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
});

test('tool rows use distinct icons with a generic fallback', () => {
  const view = fixture();
  for (const [index, name] of ['read', 'bash', 'edit', 'write', 'grep', 'custom_tool'].entries()) {
    view.controller.applyStreamEvent({ kind: 'tool', id: `icon-${index}`, name, status: 'start', args: {} }, view.state);
  }
  const [block] = workBlocks(view);
  assert.deepEqual(block.querySelectorAll('.toolIcon').map((icon) => icon.dataset.kind),
    ['read', 'bash', 'edit', 'write', 'search', 'other']);
  assert.equal(block.querySelectorAll('.toolCard .nm').at(-1).textContent, 'custom_tool');
});

test('previews and error notices stay outside work blocks', () => {
  const view = fixture();
  view.controller.applyStreamEvent({ kind: 'tool', id: 'read-1', name: 'read', status: 'start', args: {} }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'html-1', name: 'show_html', status: 'start', args: {} }, view.state);
  view.controller.applyStreamEvent({ kind: 'error', message: 'retrying' }, view.state);
  view.controller.applyStreamEvent({ kind: 'tool', id: 'read-2', name: 'read', status: 'start', args: {} }, view.state);

  const cards = view.document.chat.querySelectorAll('.toolCard');
  assert.equal(cards.find((card) => card.dataset.tool === 'show_html').closest('.workBlock'), null);
  assert.equal(workBlocks(view).length, 2, 'a preview breaks the stretch of work');
  assert.equal(workBlocks(view).filter((block) => block.classList.contains('live')).length, 1,
    'only the newest block keeps working');
});

test('history rebuilds one work block per stretch with updates and a timed summary', () => {
  const view = fixture();
  const at = (seconds) => new Date(Date.UTC(2026, 9, 18, 10, 0, seconds)).toISOString();
  view.controller.renderHistory({
    key: view.key,
    replace: true,
    messages: [
      { role: 'user', text: 'Fix it', timestamp: at(0) },
      { role: 'assistant', timestamp: at(5), blocks: [
        { type: 'text', text: 'Checking the **logs**.' },
        { type: 'tool', id: 'h-read', name: 'read', status: 'end', output: 'ok' },
      ] },
      { role: 'assistant', timestamp: at(65), blocks: [
        { type: 'thinking', text: '**Planning the fix**' },
        { type: 'tool', id: 'h-edit', name: 'edit', status: 'end', output: 'done' },
      ] },
      { role: 'assistant', timestamp: at(70), blocks: [{ type: 'text', text: 'Finished.' }] },
    ],
  });

  const blocks = workBlocks(view);
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.equal(block.classList.contains('live'), false);
  assert.equal(headline(block), 'Worked for 1m 05s');
  assert.equal(block.querySelector('.wbMeta').textContent, '1 read · 1 edit');
  assert.equal(block.querySelector('.wbUpdate .msg').dataset.raw, 'Checking the **logs**.');
  assert.equal(block.querySelectorAll('.msgActions').length, 0, 'interim updates carry no answer actions');
  assert.equal(block.querySelectorAll('.msgMeta').length, 2, 'work messages keep their timestamps inside the block');
  const answer = view.document.chat.querySelectorAll('.msg.assistant').at(-1);
  assert.equal(answer.dataset.raw, 'Finished.');
  assert.equal(answer.closest('.workBlock'), null);
  assert.ok(answer.parentNode.querySelector('.msgActions'));
});

test('the flow style leaves updates in the chat and folds each stretch of work on its own', () => {
  const view = fixture({ workStyle: 'flow' });
  const event = (payload) => view.controller.applyStreamEvent(payload, view.state);
  event({ kind: 'thinking', delta: '**Locating the bug**\n\nStart with the composer.' });
  event({ kind: 'tool', id: 'grep-1', name: 'grep', status: 'start', summary: 'sendBtn', args: {} });
  const [first] = workBlocks(view);
  assert.equal(headline(first), 'Searching sendBtn', 'the latest named step leads while the stretch is live');
  event({ kind: 'tool', id: 'grep-1', name: 'grep', status: 'end', output: '3 matches' });
  assert.equal(headline(first), 'Searched sendBtn', 'a finished tool does not hand the row back to an older heading');
  event({ kind: 'thinking', delta: 'Three places set it.' });
  assert.equal(headline(first), 'Searched sendBtn', 'reasoning without a heading leaves the row alone');
  event({ kind: 'text', delta: 'Found the cause. Fixing it now.' });
  assert.equal(first.classList.contains('live'), false, 'an update ends the stretch before it');
  assert.equal(headline(first), 'Locating the bug');
  assert.match(first.querySelector('.wbMeta').textContent, /^1 tool · \d+s$/);
  event({ kind: 'tool', id: 'edit-1', name: 'edit', status: 'start', summary: 'app.js', args: {} });
  event({ kind: 'tool', id: 'edit-1', name: 'edit', status: 'end', isError: true, output: 'no match' });
  event({ kind: 'text', delta: 'Done.' });
  view.controller.finalizeStreamingMarkdown();
  view.controller.clearSegments();

  const blocks = workBlocks(view);
  assert.equal(blocks.length, 2);
  const update = view.document.chat.querySelectorAll('.msg.assistant')[0];
  assert.equal(update.dataset.raw, 'Found the cause. Fixing it now.');
  assert.equal(update.closest('.workBlock'), null, 'the update stays in the flow');
  assert.equal(view.document.chat.querySelectorAll('.wbUpdate').length, 0);
  const order = [...update.parentNode.children].filter((node) => node.classList.contains('workBlock') || node.classList.contains('msg'));
  assert.deepEqual(order.map((node) => node.classList.contains('workBlock') ? 'block' : node.dataset.raw),
    ['block', 'Found the cause. Fixing it now.', 'block', 'Done.']);
  assert.equal(headline(blocks[1]), 'Edited app.js', 'a single tool names the stretch');
  assert.match(blocks[1].querySelector('.wbMeta').textContent, /^\d+s · 1 failed$/, 'the headline already names the tool');
});

test('a flow history rebuild splits work at the updates and keeps them in the chat', () => {
  const view = fixture({ workStyle: 'flow' });
  const at = (seconds) => new Date(Date.UTC(2026, 9, 18, 10, 0, seconds)).toISOString();
  view.controller.renderHistory({
    key: view.key,
    replace: true,
    messages: [
      { role: 'user', text: 'Fix it', timestamp: at(0) },
      { role: 'assistant', timestamp: at(5), blocks: [
        { type: 'tool', id: 'h-ls', name: 'ls', status: 'end', output: 'ok' },
        { type: 'text', text: 'Checking the **logs**.' },
        { type: 'tool', id: 'h-read', name: 'read', status: 'end', output: 'ok' },
      ] },
      { role: 'assistant', timestamp: at(65), blocks: [
        { type: 'thinking', text: '**Planning the fix**' },
        { type: 'tool', id: 'h-edit', name: 'edit', status: 'end', output: 'done' },
      ] },
      { role: 'assistant', timestamp: at(70), blocks: [{ type: 'text', text: 'Finished.' }] },
    ],
  });

  const blocks = workBlocks(view);
  assert.equal(blocks.length, 2);
  assert.equal(headline(blocks[0]), 'Listed');
  assert.equal(headline(blocks[1]), 'Planning the fix', 'the stretch after an update spans the next message');
  assert.equal(blocks[1].querySelector('.wbMeta').textContent, '2 tools · 1m 05s');
  const texts = view.document.chat.querySelectorAll('.msg.assistant');
  assert.deepEqual(texts.map((text) => text.closest('.workBlock') === null), [true, true]);
});

test('a running history rebuild keeps its last block working until the run ends', () => {
  const view = fixture();
  view.state.responseStartedAt = Date.now() - 12_000;
  view.controller.renderHistory({
    key: view.key,
    replace: true,
    messages: [{ role: 'user', text: 'Go' }],
    live: [
      { type: 'thinking', text: '**Scanning files**' },
      { type: 'tool', tool: { id: 'live-1', name: 'ls', status: 'start', args: {} } },
    ],
  });
  const [block] = workBlocks(view);
  assert.ok(block.classList.contains('live'));
  assert.equal(headline(block), 'Scanning files');
  assert.match(block.querySelector('.wbMeta').textContent, /^1 tool · 0:1\d$/);

  view.state.responseStartedAt = null; // the app clears the run start before settling the view
  view.controller.clearSegments();
  assert.equal(block.classList.contains('live'), false);
  assert.match(headline(block), /^Worked for 1\ds$/);
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

test('markdown alerts preserve formatted inline content', () => {
  const marker = { nodeType: 3, nodeValue: '[!TIP] ' };
  const strong = { textContent: 'important' };
  const link = { textContent: 'docs' };
  const paragraph = {
    tagName: 'P', firstChild: marker, children: [marker, strong, link],
    get textContent() { return this.children.map((child) => child.nodeValue ?? child.textContent).join(''); },
    remove() { throw new Error('formatted paragraph must not be removed'); },
  };
  const labels = [];
  const quote = {
    firstElementChild: paragraph,
    classList: { add(...names) { labels.push(...names); } },
    prepend(label) { labels.push(label); },
  };
  decorateMarkdownAlert(quote, { createElement: () => ({}) });
  assert.equal(marker.nodeValue, '');
  assert.deepEqual(paragraph.children.slice(1), [strong, link]);
  assert.deepEqual(labels.slice(0, 2), ['mdAlert', 'mdAlert-tip']);
  assert.equal(labels[2].textContent, 'Tip');
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
  view.document.chat.appendChild(message);
  const localHrefs = [
    './public/app.js:42', '../docs/notes.html',
    'C:/Users/Mimmo/.claude/skills/code-review/SKILL.md',
    String.raw`C:\Users\Mimmo\file.md`,
    'C:%5CUsers%5CMimmo%5Cfile.md', 'C:%2FUsers%2FMimmo%2Ffile.md',
    'file:///C:/Users/Mimmo/file%20with%20spaces.md', '/C:/Users/Mimmo/file.md',
  ];
  for (const href of localHrefs) {
    const local = new FakeElement('a');
    local.setAttribute('href', href);
    message.appendChild(local);
    let prevented = false;
    await view.document.chat.emit('click', { target: local, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, href);
    assert.deepEqual(calls.at(-1), ['/api/open-local-path', { href }, { key: view.key, guardChat: true }]);
  }

  for (const href of ['https://example.com/docs', 'mailto:reader@example.com', '#section']) {
    const external = new FakeElement('a');
    external.setAttribute('href', href);
    message.appendChild(external);
    let prevented = false;
    await view.document.chat.emit('click', { target: external, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, href);
  }
  assert.equal(calls.length, localHrefs.length);
});

test('the module starts and disposes its root listener explicitly', () => {
  const view = fixture();
  assert.equal(view.document.chat.listeners.get('click').length, 1);
  view.controller.start();
  assert.equal(view.document.chat.listeners.get('click').length, 1);
  view.controller.dispose();
  assert.equal(view.document.chat.listeners.get('click').length, 0);
});
