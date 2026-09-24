import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createDebateStore } from '../src/storage/debate-store.mjs';
import { createDebateService } from '../src/chat/debates.mjs';
import { debateTurnPrompt, nextDebateTurns, requireCompleteAnswer } from '../src/chat/debate-protocol.mjs';
import { parseDebateConfig, parseDebateSnapshot } from '../public/debate-contract.js';

const config = { prompt: 'Explore this idea', cwd: process.cwd(), rounds: 4,
  A: { provider: 'fixture', model: 'model-a', effort: 'medium' }, B: { provider: 'fixture', model: 'model-b', effort: 'high' } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function response(agent, prompt, text = agent, stopReason = 'stop') {
  return {
    user: { role: 'user', content: prompt, timestamp: 1 },
    assistant: { role: 'assistant', provider: 'fixture', model: config[agent].model, api: 'fixture', timestamp: 2,
      content: [{ type: 'thinking', thinking: `private-${agent}`, thinkingSignature: `signature-${agent}` }, { type: 'text', text }], stopReason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}
async function setup(t, makeAgent = undefined, makeStore = (store) => store) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-debates-'));
  const store = createDebateStore(directory);
  const calls = [];
  const make = makeAgent ?? (async ({ agent, turns }) => {
    let round = turns.filter((turn) => turn.key[0] === agent).length;
    return {
      async answer(prompt, onText) {
        const key = `${agent}${++round}`;
        calls.push({ key, prompt }); onText(key);
        return response(agent, prompt, key);
      }, async abort() {}, dispose() {},
    };
  });
  const service = createDebateService({ store: makeStore(store), runtime: () => null, createAgent: make, validateModels: () => {}, onChange: () => {} });
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, calls, directory, make };
}
async function finished(service, id) {
  if (!service.isActive(id)) return service.snapshot(id);
  return new Promise((resolve) => {
    const detach = service.subscribe(id, (event) => {
      if (event.kind === 'snapshot' && !service.isActive(id) && !['running', 'stopping'].includes(event.debate.status)) { detach(); resolve(event.debate); }
    });
  });
}

test('configuration rejects fractional rounds, unsafe counts and missing identities', () => {
  for (const rounds of [0, 1, 2.5, Infinity, Number.MAX_SAFE_INTEGER, '4']) assert.throws(() => parseDebateConfig({ ...config, rounds }), { code: 'invalid_rounds' });
  assert.throws(() => parseDebateConfig({ ...config, B: {} }), { code: 'invalid_configuration' });
  assert.equal(parseDebateConfig(config).rounds, 4);
});

for (const rounds of [2, 4]) test(`${rounds} rounds produce the exact deliveries and two final warnings`, async (t) => {
  const { service, calls } = await setup(t);
  const item = await service.create({ ...config, rounds });
  await service.start(item.id);
  const result = await finished(service, item.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, rounds * 2);
  assert.deepEqual(calls.map((call) => call.key), Array.from({ length: rounds }, (_, index) => [`A${index + 1}`, `B${index + 1}`]).flat());
  assert.ok(!calls[0].prompt.includes('B1'));
  assert.ok(!calls[1].prompt.includes('A1'));
  assert.match(calls[2].prompt, /B1/);
  assert.match(calls[3].prompt, /A1[\s\S]*A2/);
  assert.equal(calls.filter((call) => call.prompt.includes('LAST message')).length, 2);
  assert.deepEqual(calls.filter((call) => call.prompt.includes('LAST message')).map((call) => call.key), [`A${rounds}`, `B${rounds}`]);
  assert.ok(!JSON.stringify(calls).includes('private-'));
  assert.ok(!JSON.stringify(calls).includes('model-a'));
  const publicData = JSON.stringify([result, await service.history(item.id), await service.list()]);
  assert.ok(!publicData.includes('signature-'));
  assert.ok(!publicData.includes('private-'));
  assert.equal(parseDebateSnapshot(result).completed, rounds * 2);
  await assert.rejects(service.start(item.id), { code: 'debate_completed' });
});

test('a failed opening preserves its independent peer and resumes only missing turns', async (t) => {
  let fail = true;
  const calls = [];
  const { service, store, directory } = await setup(t, async ({ agent, turns }) => {
    let round = turns.filter((turn) => turn.key[0] === agent).length;
    return { async answer(prompt) {
      const key = `${agent}${++round}`; calls.push(key);
      if (agent === 'B' && fail) throw new Error('secret-provider-token');
      return response(agent, prompt, key);
    }, async abort() {}, dispose() {} };
  });
  const item = await service.create(config);
  await service.start(item.id);
  const failed = await finished(service, item.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.completed, 1);
  assert.ok(!JSON.stringify(failed).includes('secret-provider-token'));
  await service.dispose(); service.reopen(); fail = false;
  await service.start(item.id); await finished(service, item.id);
  assert.equal(calls.filter((key) => key === 'A1').length, 1);
  assert.equal(calls.filter((key) => key === 'B1').length, 2);
  const saved = await store.load(item.id);
  assert.equal(saved.turns.length, 8);
  const raw = await readFile(path.join(directory, `${item.id}.json`), 'utf8');
  assert.match(raw, /signature-A/); // own provider metadata survives restart
});

test('stop during a response drains the call, keeps partial text out, and permits manual resume', async (t) => {
  const entered = deferred(); const released = deferred();
  const { service, store } = await setup(t, async ({ agent }) => ({
    async answer(prompt, onText) {
      onText('partial'); entered.resolve(); await released.promise;
      return response(agent, prompt, 'partial', 'aborted');
    }, async abort() { released.resolve(); }, dispose() {},
  }));
  const item = await service.create(config);
  await service.start(item.id); await entered.promise;
  await assert.rejects(service.start(item.id), { code: 'debate_busy' });
  const result = await service.stop(item.id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.completed, 0);
  assert.equal((await store.load(item.id)).turns.length, 0);
  assert.equal(service.count(), 0);
});

test('checkpoint failure never hands an unsaved reply to the peer', async (t) => {
  const { service, calls, store } = await setup(t, undefined, (original) => ({ ...original,
    async save(record, changes) {
      if (changes.turns) throw new Error('disk failed');
      return original.save(record, changes);
    },
  }));
  const item = await service.create(config);
  await service.start(item.id);
  const result = await finished(service, item.id);
  assert.equal(result.error.code, 'checkpoint_failed');
  assert.deepEqual(calls.map((call) => call.key), ['A1', 'B1']);
  assert.equal((await store.load(item.id)).turns.length, 0);
});

test('a new service resumes after A2 without changing the completed conversation prefix', async (t) => {
  const first = await setup(t);
  let record = await first.store.create(config);
  for (const key of ['A1', 'B1', 'A2']) {
    const prompt = debateTurnPrompt(config, record.turns, key);
    record = await first.store.save(record, { turns: [...record.turns, { key, cycle: 1, intermediate: [], ...response(key[0], prompt, key) }] });
  }
  record = await first.store.save(record, { status: 'running', owner: null });
  assert.equal((await first.service.snapshot(record.id)).status, 'interrupted');
  await first.service.start(record.id);
  await finished(first.service, record.id);
  assert.deepEqual(first.calls.map((call) => call.key), ['B2', 'A3', 'B3', 'A4', 'B4']);
  assert.match(first.calls[0].prompt, /A1[\s\S]*A2/);
  const saved = await first.store.load(record.id);
  assert.deepEqual(saved.turns.slice(0, 3), record.turns);
});

test('terminal errors, length stops, empty text and unexpected tools are not successful answers', () => {
  for (const stop of ['length', 'aborted', 'error', 'toolUse', 'pending']) {
    assert.throws(() => requireCompleteAnswer(response('A', '', 'partial', stop).assistant));
  }
  assert.throws(() => requireCompleteAnswer(response('A', '', '').assistant), { code: 'invalid_response' });
});

test('cleanup failure in one agent does not skip releasing its peer', async (t) => {
  const released = [];
  const { service } = await setup(t, async ({ agent }) => ({
    async answer(prompt) { return response(agent, prompt); },
    async abort() { if (agent === 'A') throw new Error('cleanup fixture'); },
    dispose() { released.push(agent); },
  }));
  const item = await service.create({ ...config, rounds: 2 });
  await service.start(item.id);
  const result = await finished(service, item.id);
  assert.equal(result.error.code, 'cleanup_failed');
  assert.deepEqual(released.sort(), ['A', 'B']);
  assert.equal(result.completed, 4);
});

test('failure to save final status keeps completed responses and resume does not regenerate them', async (t) => {
  let fail = true;
  const { service, calls } = await setup(t, undefined, (original) => ({ ...original,
    async save(record, changes) {
      if (changes.status === 'completed' && fail) throw new Error('disk unavailable');
      return original.save(record, changes);
    },
  }));
  const item = await service.create({ ...config, rounds: 2 });
  await service.start(item.id);
  const failed = await finished(service, item.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completed, 4);
  fail = false;
  await service.start(item.id);
  assert.equal((await finished(service, item.id)).status, 'completed');
  assert.equal(calls.length, 4);
});

test('history is paginated, conclusions are separate and IDs never escape the archive', async (t) => {
  const { service } = await setup(t);
  const item = await service.create({ ...config, rounds: 12 });
  await service.start(item.id); await finished(service, item.id);
  const page = await service.history(item.id);
  assert.equal(page.turns.length, 20); assert.equal(page.before, 4);
  const older = await service.history(item.id, { before: page.before });
  assert.deepEqual(older.turns.map((turn) => turn.key), ['A1', 'B1', 'A2', 'B2']);
  const finals = await service.history(item.id, { finals: true });
  assert.deepEqual(finals.turns.map((turn) => turn.key), ['A12', 'B12']);
  await assert.rejects(service.snapshot('../auth'), { code: 'invalid_debate_id' });
  await assert.rejects(service.history(item.id, { before: -1 }), { code: 'invalid_cursor' });
});

test('corrupt checkpoint fails visibly instead of resetting the debate', async (t) => {
  const { store, directory } = await setup(t);
  const item = await store.create(config);
  const file = path.join(directory, `${item.id}.json`);
  await writeFile(file, '{broken');
  await assert.rejects(store.load(item.id), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('continuation chooses new rounds, preserves both histories and rejects duplicate submissions', async (t) => {
  const contexts = []; const deliveries = [];
  const { service, store } = await setup(t, async ({ agent, turns }) => {
    contexts.push({ agent, turns: structuredClone(turns) });
    return { async answer(prompt, _onText, options) {
      deliveries.push({ agent, prompt, images: options.images });
      return response(agent, prompt, `Final position ${agent} ${deliveries.length}`);
    }, async abort() {}, dispose() {} };
  });
  const created = await service.create({ ...config, rounds: 2 });
  await assert.rejects(service.continueDebate(created.id, { prompt: 'Next', rounds: 3, previousCycle: 1 }), { code: 'cycle_incomplete' });
  await service.start(created.id); await finished(service, created.id);
  const prior = (await store.load(created.id)).turns;
  await service.continueDebate(created.id, { prompt: 'Now focus on costs', rounds: 3, previousCycle: 1 });
  const done = await finished(service, created.id);
  assert.equal(done.cycle, 2); assert.equal(done.completed, 6); assert.equal(done.totalCompleted, 10);
  assert.equal(done.config.rounds, 3); assert.equal(done.config.prompt, 'Now focus on costs');
  assert.deepEqual((await store.load(created.id)).turns.slice(0, 4), prior);
  assert.deepEqual(contexts.slice(2).map((item) => item.turns), [prior, prior]);
  assert.match(deliveries[4].prompt, /previous cycle's final answer from agent B/);
  assert.match(deliveries[4].prompt, /Now focus on costs/);
  await assert.rejects(service.continueDebate(created.id, { prompt: 'Duplicate', rounds: 3, previousCycle: 1 }), { code: 'cycle_changed' });
  assert.equal((await service.snapshot(created.id)).cycle, 2);
  const history = await service.history(created.id);
  assert.deepEqual(history.turns.map((turn) => `${turn.cycle}:${turn.key}`), ['1:A1', '1:B1', '1:A2', '1:B2', '2:A1', '2:B1', '2:A2', '2:B2', '2:A3', '2:B3']);
  assert.ok(history.turns.every((turn) => turn.model.model === config[turn.key[0]].model));
  assert.deepEqual((await service.history(created.id, { finals: true })).turns.map((turn) => `${turn.cycle}:${turn.key}`), ['2:A3', '2:B3']);
});

test('attachments reach both independent openings but are absent from API and SSE projections', async (t) => {
  const delivered = [];
  const { service } = await setup(t, async ({ agent }) => ({
    async answer(prompt, _onText, options) { delivered.push({ prompt, images: options.images }); return response(agent, prompt); },
    async abort() {}, dispose() {},
  }));
  const images = Buffer.from('PRIVATE_IMAGE_BYTES').toString('base64');
  const item = await service.create({ ...config, rounds: 2 }, [
    { kind: 'file', name: 'notes.md', text: 'PRIVATE_ATTACHMENT_TEXT' },
    { kind: 'image', name: 'image.png', data: images, mimeType: 'image/png' },
  ]);
  const events = []; const detach = service.subscribe(item.id, (event) => events.push(event));
  await service.start(item.id); await finished(service, item.id); detach();
  for (const opening of delivered.slice(0, 2)) {
    assert.match(opening.prompt, /PRIVATE_ATTACHMENT_TEXT/);
    assert.equal(opening.images[0].data, images);
  }
  assert.ok(delivered.slice(2).every((turn) => turn.images.length === 0));
  const wire = JSON.stringify([item, events, await service.list(), await service.history(item.id)]);
  assert.ok(!wire.includes('PRIVATE_ATTACHMENT_TEXT')); assert.ok(!wire.includes(images));
  assert.deepEqual(item.attachments.map((attachment) => attachment.name), ['notes.md', 'image.png']);
  await assert.rejects(service.create(config, [{ kind: 'image', name: 'bad', data: 'not base64', mimeType: 'image/png' }]), { code: 'invalid_attachment' });
});

test('version one records remain readable and migrate only on an explicit continuation', async (t) => {
  const { service, store, directory } = await setup(t);
  const item = await service.create({ ...config, rounds: 2 });
  await service.start(item.id); await finished(service, item.id);
  const saved = await store.load(item.id);
  const legacy = { ...saved, version: 1 };
  delete legacy.cycles;
  legacy.turns = legacy.turns.map(({ cycle: _cycle, intermediate: _intermediate, ...turn }) => turn);
  const file = path.join(directory, `${item.id}.json`);
  await writeFile(file, JSON.stringify(legacy));
  const before = await readFile(file, 'utf8');
  assert.equal((await service.snapshot(item.id)).cycle, 1);
  assert.equal(await readFile(file, 'utf8'), before);
  await service.continueDebate(item.id, { prompt: 'Continue legacy debate', rounds: 2, previousCycle: 1 });
  await finished(service, item.id);
  assert.equal((await store.load(item.id)).cycles.length, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
});

test('conclusions request the full updated answer, not just a discussion recap', () => {
  const turns = ['A1', 'B1'].map((key) => ({ key, ...response(key[0], '', 'Earlier proposal') }));
  const prompt = debateTurnPrompt({ ...config, rounds: 2 }, turns, 'A2');
  assert.match(prompt, /COMPLETE, SELF-CONTAINED ANSWER/);
  assert.match(prompt, /ALL still-valid proposals/);
  assert.match(prompt, /Do not merely list what changed/);
});

test('watch starts with the current snapshot and completed runs survive dispose', async (t) => {
  const { service } = await setup(t);
  const item = await service.create(config);
  const events = [];
  const detach = await service.watch(item.id, (event) => events.push(event));
  assert.equal(events[0].debate.status, 'ready');
  await service.start(item.id); await finished(service, item.id); detach();
  await service.dispose();
  assert.equal((await service.snapshot(item.id)).status, 'completed');
  assert.deepEqual(nextDebateTurns(config, (await service.history(item.id)).turns), []);
});
