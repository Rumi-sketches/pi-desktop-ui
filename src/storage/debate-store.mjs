import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { AGENT_DIR } from './agent-paths.mjs';
import { jsonFile, mutateJsonFile } from './json-store.mjs';
import { withFileLock } from './file-lock.mjs';
import { assertDebateId, DEBATE_ID, DEBATE_PAGE_SIZE, DEBATE_STATUSES, DebateError, parseDebateConfig } from '../../public/debate-contract.js';
import { DEBATE_PROTOCOL_VERSION, debateUserText, nextDebateTurns, requireCompleteAnswer } from '../chat/debate-protocol.mjs';
import { prepareDebateCycle, validateCycleInput } from '../chat/debate-input.mjs';

function parseRecord(raw) {
  // Version 1 had one text-only cycle. Migrate in memory; persist only on an explicit mutation.
  if (raw?.version === 1 && Array.isArray(raw.turns)) {
    raw = { ...raw, version: DEBATE_PROTOCOL_VERSION,
      cycles: [prepareDebateCycle(raw.config)],
      turns: raw.turns.map((turn) => ({ ...turn, cycle: 1, intermediate: [] })) };
  }
  if (!raw || raw.version !== DEBATE_PROTOCOL_VERSION || !DEBATE_STATUSES.has(raw.status)
      || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.turns)
      || !Array.isArray(raw.cycles) || raw.cycles.length === 0
      || !(raw.owner === null || (Number.isSafeInteger(raw.owner) && raw.owner > 0))
      || !(raw.error === null || (typeof raw.error?.code === 'string' && typeof raw.error?.message === 'string'))) {
    throw new DebateError('invalid_checkpoint', 'The saved debate is invalid or uses an unsupported version.', 409);
  }
  const config = parseDebateConfig(raw.config);
  const cycles = raw.cycles.map(validateCycleInput);
  const accepted = cycles.map(() => []);
  let previousCycle = 1;
  for (const turn of raw.turns) {
    if (!turn || !Number.isSafeInteger(turn.cycle) || turn.cycle < previousCycle || turn.cycle > cycles.length
        || !turn.user || !Number.isFinite(turn.user.timestamp) || !Array.isArray(turn.intermediate)) {
      throw new DebateError('invalid_checkpoint', 'The saved turn sequence is invalid.', 409);
    }
    const cycleIndex = turn.cycle - 1;
    if (!nextDebateTurns(cycles[cycleIndex], accepted[cycleIndex]).includes(turn.key)) {
      throw new DebateError('invalid_checkpoint', 'The saved turn sequence is invalid.', 409);
    }
    debateUserText(turn.user);
    const agent = config[turn.key[0]];
    requireCompleteAnswer(turn.assistant);
    for (const message of [...turn.intermediate, turn.assistant]) {
      if (!['assistant', 'toolResult'].includes(message.role) || !Array.isArray(message.content)) {
        throw new DebateError('invalid_checkpoint', 'Invalid saved tool conversation.', 409);
      }
      if (message.role === 'assistant' && (message.provider !== agent.provider || message.model !== agent.model)) {
        throw new DebateError('invalid_checkpoint', 'A saved response does not match its agent.', 409);
      }
    }
    previousCycle = turn.cycle;
    accepted[cycleIndex].push(turn);
  }
  for (let index = 0; index < cycles.length; index++) {
    if ((index < cycles.length - 1 || raw.status === 'completed') && nextDebateTurns(cycles[index], accepted[index]).length) {
      throw new DebateError('invalid_checkpoint', 'A completed cycle is missing responses.', 409);
    }
  }
  return { ...raw, id: assertDebateId(raw.id), config, cycles, turns: raw.turns };
}

export function ownerAlive(pid) {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** One atomic checkpoint per debate. Execution ownership uses a separate, long-lived lock. */
export function createDebateStore(directory = path.join(AGENT_DIR, 'web-ui-debates')) {
  const file = (id) => path.join(directory, `${assertDebateId(id)}.json`);
  const store = (id) => jsonFile(file(id), { fallback: () => null, revive: parseRecord, mode: 0o600, dirMode: 0o700 });

  async function load(id) {
    const record = await store(id).loadStrict();
    if (!record) throw new DebateError('debate_not_found', 'Debate not found.', 404);
    if (record.id !== id) throw new DebateError('invalid_checkpoint', 'The saved debate identity does not match.', 409);
    return record;
  }

  async function create(config, cycle = prepareDebateCycle(config)) {
    const id = `${Date.now()}-${randomUUID()}`;
    const record = { version: DEBATE_PROTOCOL_VERSION, id, config: parseDebateConfig(config), cycles: [validateCycleInput(cycle)], revision: 0, status: 'ready', owner: null, turns: [], error: null };
    await mutateJsonFile(store(id), file(id), (current) => {
      if (current) throw new DebateError('debate_exists', 'Debate already exists.', 409);
      return record;
    });
    return record;
  }

  async function save(record, changes) {
    return mutateJsonFile(store(record.id), file(record.id), (current) => {
      if (!current || current.revision !== record.revision) throw new DebateError('checkpoint_conflict', 'The debate changed in another instance.', 409);
      return parseRecord({ ...record, ...changes, revision: record.revision + 1 });
    });
  }

  async function list({ before = null, cwd = null, signal = undefined } = {}) {
    if (before !== null) assertDebateId(before);
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return { records: [], before: null }; throw error; }
    const ids = names.filter((name) => name.endsWith('.json') && DEBATE_ID.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5)).filter((id) => before === null || id < before).sort().reverse();
    const records = [];
    let scanned = 0;
    // Bound content reads independently of the number of archived debates.
    for (const id of ids) {
      signal?.throwIfAborted();
      if (records.length === DEBATE_PAGE_SIZE || scanned === 200) break;
      scanned++;
      const record = await load(id);
      if (cwd === null || record.config.cwd.toLowerCase() === cwd.toLowerCase()) records.push(record);
    }
    return { records, before: scanned < ids.length ? ids[scanned - 1] : null };
  }

  function own(id, operation) {
    return withFileLock(`${file(id)}.run`, operation);
  }
  return { create, load, save, list, own };
}
