import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDebateStore } from '../src/storage/debate-store.mjs';
import { createDebateService } from '../src/chat/debates.mjs';
import { fixtureConfig } from './fixtures/debate-runtime.mjs';

const worker = fileURLToPath(new URL('./fixtures/debate-worker.mjs', import.meta.url));
test('two server processes cannot execute one debate; a crashed owner can be recovered explicitly', { timeout: 25000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-process-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.filter((child) => child.exitCode === null).map(async (child) => { const exited = once(child, 'exit'); child.send('stop'); await exited; }));
    await rm(directory, { recursive: true, force: true });
  });
  const store = createDebateStore(directory);
  const item = await store.create(fixtureConfig(directory));
  function spawn() {
    const child = fork(worker, [directory, item.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    return child;
  }
  const first = spawn();
  assert.equal((await once(first, 'message'))[0].status, 'started');
  const observer = createDebateService({ store, onChange: () => {} });
  t.after(() => observer.dispose());
  const observed = await observer.snapshot(item.id);
  assert.equal(observed.status, 'running');
  assert.equal(observed.ownedElsewhere, true);
  await assert.rejects(observer.stop(item.id), { code: 'debate_owned_elsewhere' });
  const second = spawn();
  const refusal = (await once(second, 'message'))[0];
  assert.deepEqual(refusal, { status: 'refused', code: 'debate_busy' });
  const exited = once(first, 'exit'); first.send('crash'); await exited;
  assert.equal((await observer.snapshot(item.id)).status, 'interrupted');
  const recovered = spawn();
  assert.equal((await once(recovered, 'message'))[0].status, 'started');
  const stopped = once(recovered, 'exit'); recovered.send('stop'); await stopped;
  assert.equal((await store.load(item.id)).status, 'interrupted');
});
