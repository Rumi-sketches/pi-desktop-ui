import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fixtureConfig, fixtureRuntime, fixtureModel } from './fixtures/debate-runtime.mjs';

let directory, server, service;
const calls = [];
before(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-http-'));
  directory = path.join(root, 'project');
  await mkdir(directory);
  process.env.PI_WEB_UI_TEST = '1';
  process.env.PI_WEB_UI_AGENT_DIR = path.join(root, 'agent');
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  const { startServer } = await import('../server.mjs');
  server = await startServer({ port: 0 });
  server.url = new URL(server.url).origin;
  service = (await import('../src/chat/debates.mjs')).debates;
  const runtime = (await import('../src/chat/contexts.mjs')).getModelRuntime();
  Object.assign(runtime, fixtureRuntime({ calls, delay: 50 }));
  runtime.getModels = () => ['model-a', 'model-b'].map(fixtureModel);
  runtime.checkAuth = async () => ({ configured: true });
});
after(async () => { await server?.stop(); await rm(path.dirname(directory), { recursive: true, force: true }); });
async function request(route, body = undefined, headers = {}) {
  const response = await fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: server.url, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function settle(id) {
  if (!service.isActive(id)) return;
  await new Promise((resolve) => {
    const detach = service.subscribe(id, () => { if (!service.isActive(id)) { detach(); resolve(undefined); } });
  });
}

test('HTTP creation is inert; start runs the full SDK conversation, history stays public and shutdown sees it', async () => {
  const initialCalls = calls.length;
  const created = await request('/api/debates', fixtureConfig(directory));
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'ready');
  assert.equal(calls.length, initialCalls);
  const id = created.data.id;
  const started = await request(`/api/debates/${id}/start`, {});
  assert.equal(started.status, 202);
  const busy = await request('/api/restart', {});
  assert.equal(busy.status, 409);
  assert.ok(busy.data.error.agents >= 1);
  const duplicate = await request(`/api/debates/${id}/start`, {});
  assert.equal(duplicate.status, 409);
  await settle(id);
  const state = await request(`/api/debates/${id}`);
  assert.equal(state.data.status, 'completed');
  assert.equal(state.data.completed, 8);
  const history = await request(`/api/debates/${id}/history`);
  assert.deepEqual(history.data.turns.map((turn) => turn.key), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4']);
  assert.ok(!JSON.stringify(history.data).includes('signature-'));
  assert.ok(!JSON.stringify(history.data).includes('private-'));
  assert.equal((await request(`/api/debates/${id}/history?finals=1`)).data.turns.length, 2);
  assert.equal((await request(`/api/debates/${id}/start`, {})).data.error.code, 'debate_completed');
});

test('SSE reconnect sends a current snapshot; closing the page does not cancel execution', async () => {
  const { data } = await request('/api/debates', fixtureConfig(directory));
  const id = data.id;
  await request(`/api/debates/${id}/start`, {});
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/debates/${id}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('"snapshot"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!text.includes('signature-'));
  controller.abort(); await reader.cancel().catch(() => {});
  await settle(id);
  assert.equal((await request(`/api/debates/${id}`)).data.status, 'completed');
});

test('HTTP rejects malformed config, unsupported effort, foreign origins and arbitrary paths', async () => {
  assert.equal((await request('/api/debates', { ...fixtureConfig(directory), rounds: 1 })).data.error.code, 'invalid_rounds');
  const config = fixtureConfig(directory); config.B.effort = 'max';
  assert.equal((await request('/api/debates', config)).data.error.code, 'effort_unsupported');
  assert.equal((await request('/api/debates', fixtureConfig(directory), { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/api/debates/not-a-path')).data.error.code, 'invalid_debate_id');
  const response = await fetch(`${server.url}/api/debates`, { method: 'PUT', headers: { Origin: server.url } });
  assert.equal(response.status, 405);
  const assets = await Promise.all(['/debate-contract.js', '/debate-view.js'].map((asset) => fetch(server.url + asset)));
  assert.ok(assets.every((asset) => asset.status === 200));
});

test('real SDK resume preserves committed user arrays and own reasoning metadata after an exchange', async () => {
  const { data } = await request('/api/debates', fixtureConfig(directory));
  const reached = new Promise((resolve) => {
    const detach = service.subscribe(data.id, (event) => {
      if (event.kind === 'snapshot' && event.debate.completed >= 3) { detach(); resolve(undefined); }
    });
  });
  await request(`/api/debates/${data.id}/start`, {});
  await reached;
  await request(`/api/debates/${data.id}/stop`, {});
  const prefix = (await request(`/api/debates/${data.id}/history`)).data.turns;
  assert.ok(prefix.length >= 3 && prefix.length < 8);
  await request(`/api/debates/${data.id}/start`, {});
  await settle(data.id);
  const resumed = (await request(`/api/debates/${data.id}/history`)).data.turns;
  assert.equal(resumed.length, 8);
  assert.deepEqual(resumed.slice(0, prefix.length), prefix);
  assert.equal(new Set(resumed.map((turn) => turn.key)).size, 8);
});

test('HTTP continuation preserves the debate, accepts new rounds and rejects an old cycle token', async () => {
  const created = await request('/api/debates', { ...fixtureConfig(directory, 2), attachments: [
    { kind: 'file', name: 'context.md', text: 'ATTACHED_CONTEXT_PRIVATE' },
    { kind: 'image', name: 'image.png', mimeType: 'image/png', data: Buffer.from('private image').toString('base64') },
  ] });
  assert.equal(created.status, 201);
  const id = created.data.id;
  await request(`/api/debates/${id}/start`, {}); await settle(id);
  const prefix = (await request(`/api/debates/${id}/history`)).data.turns;
  const next = await request(`/api/debates/${id}/continue`, { prompt: 'Focus on staffing', rounds: 3, previousCycle: 1 });
  assert.equal(next.status, 202); await settle(id);
  const snapshot = (await request(`/api/debates/${id}`)).data;
  assert.equal(snapshot.cycle, 2); assert.equal(snapshot.completed, 6); assert.equal(snapshot.totalCompleted, 10);
  const history = (await request(`/api/debates/${id}/history`)).data.turns;
  assert.deepEqual(history.slice(0, 4), prefix);
  assert.ok(!JSON.stringify([snapshot, history]).includes('ATTACHED_CONTEXT_PRIVATE'));
  assert.equal((await request(`/api/debates/${id}/continue`, { prompt: 'Duplicate', rounds: 2, previousCycle: 1 })).data.error.code, 'cycle_changed');
  assert.equal((await request(`/api/debates/${id}/continue`, { prompt: 'Missing token', rounds: 2 })).data.error.code, 'invalid_cycle');
  assert.equal((await request(`/api/debates/${id}/continue`, { prompt: 'Foreign', rounds: 2, previousCycle: 2 }, { Origin: 'https://attacker.invalid' })).status, 403);
});

test('stop and server teardown leave saved interrupted runs, never auto-resume on reopen', async () => {
  const { data } = await request('/api/debates', fixtureConfig(directory, 12));
  await request(`/api/debates/${data.id}/start`, {});
  const stopped = await request(`/api/debates/${data.id}/stop`, {});
  assert.equal(stopped.data.status, 'interrupted');
  const count = calls.length;
  await request(`/api/debates/${data.id}`);
  await request('/api/debates');
  assert.equal(calls.length, count);
  await request(`/api/debates/${data.id}/start`, {});
  await server.stop();
  assert.equal(service.count(), 0);
  assert.equal((await service.snapshot(data.id)).status, 'interrupted');
});
