import { createDebateService } from '../../src/chat/debates.mjs';
import { createDebateStore } from '../../src/storage/debate-store.mjs';
import { fixtureRuntime } from './debate-runtime.mjs';
const [directory, id] = process.argv.slice(2);
const service = createDebateService({ store: createDebateStore(directory), runtime: () => fixtureRuntime({ delay: 60000 }), onChange: () => {} });
process.on('message', async (message) => {
  if (message === 'stop') { await service.dispose(); process.exit(0); }
  if (message === 'crash') process.exit(17);
});
try {
  await service.start(id);
  process.send({ status: 'started' });
} catch (error) {
  process.send({ status: 'refused', code: error.code });
  await service.dispose();
  process.exit(0);
}
