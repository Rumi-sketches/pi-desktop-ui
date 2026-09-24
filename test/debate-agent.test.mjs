import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink, rm } from 'node:fs/promises';
import { createDebateAgent, debateResources, validateDebateModels } from '../src/chat/debate-agent.mjs';
import { debateTurnPrompt, debateUserText } from '../src/chat/debate-protocol.mjs';
import { createDebateTools } from '../src/chat/debate-tools.mjs';
import { fixtureConfig, fixtureRuntime } from './fixtures/debate-runtime.mjs';

test('real SDK adapter exposes only read-only tools, no discovered instructions, and resumes its own raw history', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-sdk-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, '.pi'));
  await writeFile(path.join(cwd, 'CLAUDE.md'), 'DO_NOT_SEND_PROJECT_CONTEXT');
  await writeFile(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'DO_NOT_SEND_APPEND_PROMPT');
  const config = fixtureConfig(cwd);
  const calls = [];
  const runtime = fixtureRuntime({ calls });
  validateDebateModels(config, runtime);
  const agent = await createDebateAgent({ config, turns: [], agent: 'A', runtime });
  const prompt = debateTurnPrompt(config, [], 'A1');
  const deltas = [];
  const first = await agent.answer(prompt, (text) => deltas.push(text));
  agent.dispose();
  assert.equal(debateUserText(first.user), prompt);
  assert.equal(first.assistant.stopReason, 'stop');
  assert.match(deltas.join(''), /Response A1/);
  assert.deepEqual(calls[0].context.tools.map((tool) => tool.name).sort(), ['find', 'grep', 'ls', 'read']);
  assert.ok(!calls[0].context.systemPrompt.includes('DO_NOT_SEND'));
  assert.ok(!calls[0].context.systemPrompt.includes('model-a'));
  assert.equal(calls[0].options.maxRetries, 0);
  const restored = await createDebateAgent({ config, turns: [{ key: 'A1', ...first }], agent: 'A', runtime });
  try {
    await restored.answer('Another argument.', () => {});
    const own = calls[1].context.messages.find((message) => message.role === 'assistant');
    assert.equal(own.content[0].thinkingSignature, 'signature-A');
    assert.equal(own.model, 'model-a');
  } finally { restored.dispose(); }
});

test('read-only SDK tool calls inspect actual files and retain their results across reconstruction', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-read-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'README.md'), 'PROJECT_EVIDENCE_123');
  const config = fixtureConfig(cwd);
  const calls = [];
  const runtime = fixtureRuntime({ calls, toolCall: { name: 'read', arguments: { path: 'README.md' } } });
  const agent = await createDebateAgent({ config, turns: [], agent: 'A', runtime });
  const activity = [];
  const first = await agent.answer('Inspect this project.', () => {}, { onActivity: (value) => activity.push(value) });
  agent.dispose();
  const result = first.intermediate.find((message) => message.role === 'toolResult');
  assert.match(JSON.stringify(result.content), /PROJECT_EVIDENCE_123/);
  assert.ok(activity.includes('Exploring with read'));
  const restored = await createDebateAgent({ config, turns: [{ key: 'A1', cycle: 1, ...first }], agent: 'A', runtime });
  try { await restored.answer('What would you improve?', () => {}); }
  finally { restored.dispose(); }
  assert.match(JSON.stringify(calls.at(-1).context.messages), /PROJECT_EVIDENCE_123/);
  assert.equal(await readFile(path.join(cwd, 'README.md'), 'utf8'), 'PROJECT_EVIDENCE_123');
});

test('write is unavailable and read rejects paths outside the selected project', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-scope-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'outside.txt'), 'OUTSIDE');
  const tools = await createDebateTools(cwd);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'NOT_IN_PROJECT');
  await symlink(outside, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const tool of tools) {
    const target = tool.name === 'read' ? 'escape/secret.txt' : 'escape';
    await assert.rejects(tool.execute('test', { path: target, pattern: '*' }, undefined, undefined, undefined), { code: 'path_outside_project' });
  }
  await assert.rejects(tools.find((tool) => tool.name === 'read').execute('test', { path: '../outside.txt' }, undefined, undefined, undefined), { code: 'path_outside_project' });
  const agent = await createDebateAgent({ config: fixtureConfig(cwd), turns: [], agent: 'A',
    runtime: fixtureRuntime({ toolCall: { name: 'write', arguments: { path: 'must-not-exist.txt', content: 'NO' } } }) });
  try {
    const answer = await agent.answer('Attempt a write', () => {});
    assert.equal(answer.intermediate.find((message) => message.role === 'toolResult').isError, true);
    await assert.rejects(access(path.join(cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
  } finally { agent.dispose(); }
});

test('SDK errors and truncation do not become accepted replies even when prompt resolves', async () => {
  const config = fixtureConfig(process.cwd());
  for (const stopReason of ['length', 'error']) {
    const agent = await createDebateAgent({ config, turns: [], agent: 'B', runtime: fixtureRuntime({ stopReason }) });
    try { await assert.rejects(agent.answer('Question', () => {})); }
    finally { agent.dispose(); }
  }
});

test('model and effort validation cannot silently fall back; resource loader has no discovery', () => {
  const config = fixtureConfig(process.cwd());
  assert.throws(() => validateDebateModels({ ...config, A: { ...config.A, model: 'missing' } }, fixtureRuntime()), { code: 'model_unavailable' });
  assert.throws(() => validateDebateModels({ ...config, A: { ...config.A, effort: 'max' } }, fixtureRuntime()), { code: 'effort_unsupported' });
  const textOnly = fixtureRuntime();
  const getModel = textOnly.getModel;
  textOnly.getModel = (provider, id) => ({ ...getModel(provider, id), input: ['text'] });
  assert.throws(() => validateDebateModels(config, textOnly, [{ data: 'AA==', mimeType: 'image/png' }]), { code: 'images_unsupported' });
  const loader = debateResources('A', 4);
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getSkills().skills, []);
});
