import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateView } from '../public/debate-view.js';
import { createUiState, VIEW_CHAT, VIEW_DEBATE, projectTabId } from '../public/ui-state.js';
import { fixtureConfig } from './fixtures/debate-runtime.mjs';

class Element {
  parent = null;
  children = []; listeners = new Map(); attributes = {}; value = ''; textContent = ''; disabled = false;
  scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  classes = new Set();
  classList = { add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    contains: (name) => this.classes.has(name),
    toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); } };
  addEventListener(name, fn) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  async fire(name) { await Promise.all([...this.listeners.get(name) ?? []].map((fn) => fn({ preventDefault() {} }))); }
  appendChild(child) { child.parent = this; this.children.push(child); }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll() { return []; }
  focus() {}
}
const ids = ['1700000000000-00000000-0000-4000-8000-000000000001', '1700000000000-00000000-0000-4000-8000-000000000002'];
function snap(index = 0, changes = {}) {
  const result = { id: ids[index], title: 'Library', config: fixtureConfig('project'), status: 'running', revision: 1,
    cycle: 1, attachments: [], totalCompleted: changes.completed ?? 0,
    completed: 0, ownedElsewhere: false, error: null, live: [{ key: 'A1', text: '' }], ...changes };
  result.live = result.live.map((item) => ({ activity: '', ...item }));
  return result;
}
/** @param {import('node:test').TestContext} t @param {(url: string, options: any) => Promise<any>} [request] */
function setup(t, request = async () => ({ turns: [], before: null })) {
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const documentRef = /** @type {any} */ ({ getElementById: $, createElement: () => new Element() });
  const windowRef = /** @type {any} */ (new Element());
  const state = createUiState();
  const streams = []; const timers = new Map(); let timer = 0; const toasts = [];
  const view = createDebateView({ state, documentRef, windowRef,
    getCwd: () => 'project', getModels: () => [{ provider: 'debate-fixture', id: 'model-a', name: 'Alpha', thinkingLevels: ['medium'] }], select() {}, toast: (message) => toasts.push(message),
    fetchImpl: async (url, options) => { const data = await request(url, options); return /** @type {any} */ ({ ok: !data.error, json: async () => data }); },
    createEventSource: () => { const source = /** @type {any} */ ({ close() { this.closed = true; } }); streams.push(source); return source; },
    schedule: /** @type {any} */ ((fn) => { timers.set(++timer, fn); return timer; }),
    cancel: /** @type {any} */ ((id) => timers.delete(id)),
  });
  view.start(); t.after(() => view.dispose());
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  const emit = (event, source = streams.at(-1)) => source.onmessage({ data: JSON.stringify({ cycle: 1, ...event }) });
  return { view, $, state, streams, emit, flush, toasts, windowRef };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('debates use the existing project selection contract without changing a chat owner', () => {
  const state = createUiState();
  const tabId = state.registerProject('project').id;
  state.chatState('chat').cwd = 'project';
  state.applyDebatePayload(snap());
  state.select({ tabId, view: VIEW_CHAT, resourceId: 'chat' });
  state.select({ tabId, view: VIEW_DEBATE, resourceId: ids[0] });
  assert.equal(state.projects.get(tabId).lastSelection.resourceId, ids[0]);
  const other = state.registerProject('other').id;
  assert.equal(state.canSelect({ tabId: other, view: VIEW_DEBATE, resourceId: ids[0] }), false);
  assert.equal(state.chats.get('chat').cwd, 'project');
  state.select({ tabId: projectTabId(null), view: VIEW_DEBATE, resourceId: null });
  assert.equal(state.selection.resourceId, null);
});

test('a late snapshot from an earlier cycle cannot roll back the shared debate state', () => {
  const state = createUiState();
  state.applyDebatePayload(snap(0, { cycle: 2, revision: 5, totalCompleted: 8 }));
  state.applyDebatePayload(snap(0, { cycle: 1, revision: 1 }));
  assert.equal(state.debates.get(ids[0]).cycle, 2);
  assert.equal(state.debates.get(ids[0]).revision, 5);
});

test('A B A navigation ignores old streams and late history; reconnect replaces live text', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let first = true;
  const { view, $, streams, emit, flush } = setup(t, async (url) => {
    if (url.startsWith('/api/debates?')) return { debates: [], before: null };
    if (first) { first = false; return pending; }
    return { turns: [{ key: 'A1', text: 'current history', index: 0, final: false, cycle: 1, model: fixtureConfig('project').A, prompt: 'Question' }], before: null };
  });
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap() });
  const old = streams[0];
  view.show(ids[1]); emit({ kind: 'snapshot', debate: snap(1) });
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap(0, { live: [{ key: 'A1', text: 'prefix' }] }) });
  emit({ kind: 'text', key: 'A1', offset: 0, delta: 'stale' }, old);
  emit({ kind: 'text', key: 'A1', offset: 6, delta: ' next' });
  flush(); await tick();
  assert.equal($('debateLive').children[0].children[2].textContent, 'prefix next');
  release({ turns: [{ key: 'A1', text: 'stale history', index: 0, final: false, cycle: 1, model: fixtureConfig('project').A, prompt: 'Question' }], before: null });
  await tick();
  assert.equal($('debateTranscript').children[1].children[2].textContent, 'current history');
  emit({ kind: 'snapshot', debate: snap(0, { live: [{ key: 'A1', text: 'prefix next recovered' }] }) });
  flush();
  assert.equal($('debateLive').children.length, 1);
  assert.equal($('debateLive').children[0].children[2].textContent, 'prefix next recovered');
  assert.equal(old.closed, true);
});

test('a failed resume remains visible after buttons are re-enabled', async (t) => {
  const { view, $, emit } = setup(t, async (url) => {
    if (url.endsWith('/start')) return { error: { code: 'model_unavailable', message: 'Model unavailable.' } };
    return { turns: [], before: null };
  });
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap(0, { status: 'interrupted', live: [] }) });
  await $('debateResume').fire('click');
  assert.equal($('debateError').textContent, 'Model unavailable.');
  assert.equal($('debateError').classList.contains('hide'), false);
  assert.equal($('debateResume').disabled, false);
});

test('continuation captures the chosen rounds before repainting the completed-cycle controls', async (t) => {
  const bodies = [];
  const { view, $, emit, state } = setup(t, async (url, options) => {
    if (url.endsWith('/continue')) {
      bodies.push(JSON.parse(options.body));
      return snap(0, { cycle: 2, revision: 2, totalCompleted: 8,
        config: { ...fixtureConfig('project'), prompt: 'Focus on cost', rounds: 3 } });
    }
    return { turns: [], before: null };
  });
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap(0, { status: 'completed', completed: 8, live: [] }) });
  $('debateContinuePrompt').value = 'Focus on cost';
  $('debateContinueRounds').value = '3';
  await $('debateContinueForm').fire('submit');
  assert.equal(bodies[0].rounds, 3); assert.equal(bodies[0].previousCycle, 1);
  assert.equal(state.debates.get(ids[0]).cycle, 2);
  assert.equal($('debateContinuePrompt').value, '');
});

test('a file read finishing after navigation belongs only to its original composer draft', (t) => {
  const { view, $, emit, windowRef } = setup(t);
  const readers = [];
  windowRef.FileReader = class {
    result = ''; onload = null; onloadend = null;
    readAsText() { readers.push(this); }
    finish() { this.result = 'FILE_CONTENT'; this.onload?.(); this.onloadend?.(); }
    abort() {}
  };
  view.show(null);
  view.addFiles([{ name: 'notes.md', type: 'text/plain', size: 12 }]);
  assert.equal($('debateLaunch').disabled, true);
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap(0, { status: 'completed', completed: 8, live: [] }) });
  readers[0].finish();
  assert.equal($('debateContinueAttachments').children.length, 0);
  view.show(null);
  assert.equal($('debateAttachments').children.length, 1);
  assert.equal($('debateAttachments').children[0].textContent, 'notes.md');
  assert.equal($('debateLaunch').disabled, false);
});

test('final conclusions are requested separately and disposal closes the stream and timers', async (t) => {
  const queries = [];
  const { view, $, streams, emit } = setup(t, async (url) => { queries.push(url); return { turns: [], before: null }; });
  view.show(ids[0]); emit({ kind: 'snapshot', debate: snap(0, { status: 'completed', completed: 8, live: [] }) });
  await $('debateFinals').fire('click'); await tick();
  assert.ok(queries.some((url) => url.endsWith('/history?finals=1')));
  assert.equal($('debateFinals').attributes['aria-pressed'], 'true');
  view.dispose();
  assert.equal(streams[0].closed, true);
  assert.equal($('debateStop').listeners.get('click').size, 0);
});
