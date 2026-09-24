import { DebateError, DEBATE_PAGE_SIZE } from '../../public/debate-contract.js';
import { createDebateStore, ownerAlive } from '../storage/debate-store.mjs';
import { mutationQueue } from '../storage/json-store.mjs';
import { currentDebateConfig, currentDebateCycle, currentDebateTurns, assistantText, debateTurnPrompt, nextDebateTurns, requireCompleteAnswer } from './debate-protocol.mjs';
import { createDebateAgent, validateDebateModels } from './debate-agent.mjs';
import { broadcastGlobal, getModelRuntime } from './contexts.mjs';
import { prepareDebateCycle } from './debate-input.mjs';

function publicFailure(error) {
  if (error instanceof DebateError) return { code: error.code, message: error.message };
  return { code: 'execution_failed', message: 'The debate could not continue. No further turn was started. Resume from the last saved response.' };
}

export function debateSummary(record, active = false) {
  let status = record.status;
  const owns = ownerAlive(record.owner);
  const ownedElsewhere = owns && record.owner !== process.pid;
  if ((status === 'running' || status === 'stopping') && !active && !ownedElsewhere) status = 'interrupted';
  return {
    id: record.id, title: record.config.prompt, config: currentDebateConfig(record), revision: record.revision, status,
    cycle: record.cycles.length, totalCompleted: record.turns.length,
    completed: currentDebateTurns(record).length, attachments: currentDebateCycle(record).attachments,
    ownedElsewhere, error: record.error, live: [],
  };
}

export function createDebateService({
  store = createDebateStore(),
  runtime = getModelRuntime,
  createAgent = createDebateAgent,
  validateModels = validateDebateModels,
  onChange = () => broadcastGlobal({ kind: 'debates' }),
} = {}) {
  const active = new Map();
  const listeners = new Map();
  const failures = new Map();
  let closing = false;

  function publish(id, event) {
    for (const listener of listeners.get(id) ?? []) listener(event);
  }
  function snapshotFor(record) {
    const slot = active.get(record.id);
    const result = debateSummary(record, Boolean(slot));
    if (slot) {
      result.live = [...slot.live].map(([key, text]) => ({ key, text, activity: slot.activities.get(key) ?? '' }));
      result.status = slot.stopped ? 'stopping' : 'running';
    }
    const failure = failures.get(record.id);
    if (failure) { result.status = 'failed'; result.error = failure; }
    return result;
  }
  async function recordFor(id) {
    const current = active.get(id)?.record;
    if (current) return current;
    const saved = await store.load(id);
    return active.get(id)?.record ?? saved;
  }
  async function snapshot(id) { return snapshotFor(await recordFor(id)); }
  function changed(slot) {
    publish(slot.record.id, { kind: 'snapshot', debate: snapshotFor(slot.record) });
    onChange();
  }

  async function create(config, attachments = []) {
    if (closing) throw new DebateError('server_stopping', 'The server is stopping.', 409);
    const cycle = prepareDebateCycle(config, attachments);
    validateModels(config, runtime(), cycle.input.images);
    const record = await store.create(config, cycle);
    onChange();
    return snapshotFor(record);
  }

  async function execute(slot) {
    const config = currentDebateConfig(slot.record);
    const cycle = currentDebateCycle(slot.record);
    for (const agent of ['A', 'B']) {
      if (slot.stopped) return;
      const instance = await createAgent({ config, turns: slot.record.turns, agent, runtime: runtime() });
      slot.agents.set(agent, instance);
    }
    async function answer(key) {
      if (slot.stopped) return;
      let prompt = debateTurnPrompt({ ...config, prompt: cycle.input.text }, currentDebateTurns(slot.record), key);
      if (Number(key.slice(1)) === 1 && slot.record.cycles.length > 1) {
        const previous = slot.record.cycles.length - 1;
        const peer = key[0] === 'A' ? 'B' : 'A';
        const conclusion = slot.record.turns.find((turn) => turn.cycle === previous && turn.key === `${peer}${slot.record.cycles[previous - 1].rounds}`);
        // In particular, A has not yet received B's last answer from the previous cycle.
        prompt = `For context, the previous cycle's final answer from agent ${peer}:\n<peer_response>\n${assistantText(conclusion.assistant)}\n</peer_response>\n\n${prompt}`;
      }
      slot.live.set(key, '');
      changed(slot);
      const response = await slot.agents.get(key[0]).answer(prompt, (delta) => {
        if (slot.stopped) return;
        const previous = slot.live.get(key);
        slot.live.set(key, previous + delta);
        publish(slot.record.id, { kind: 'text', key, offset: previous.length, delta, cycle: slot.record.cycles.length });
      }, {
        images: Number(key.slice(1)) === 1 ? cycle.input.images : [],
        onActivity: (activity) => {
          if (slot.stopped) return;
          slot.activities.set(key, activity);
          publish(slot.record.id, { kind: 'activity', key, activity, cycle: slot.record.cycles.length });
        },
      });
      requireCompleteAnswer(response.assistant);
      await slot.commit(async () => {
        if (slot.stopped) return;
        const turn = { key, cycle: slot.record.cycles.length, user: response.user,
          assistant: response.assistant, intermediate: response.intermediate ?? [] };
        try {
          slot.record = await store.save(slot.record, { turns: [...slot.record.turns, turn] });
        } catch {
          throw new DebateError('checkpoint_failed', 'The response could not be saved. Execution stopped before handing it to the other agent.', 500);
        }
        slot.live.delete(key);
        slot.activities.delete(key);
        changed(slot);
      });
    }
    while (!slot.stopped) {
      const next = nextDebateTurns(config, currentDebateTurns(slot.record));
      if (!next.length) return;
      // allSettled drains both opening calls before disposal, even when one fails.
      const results = await Promise.allSettled(next.map((key) => answer(key)));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }

  async function start(id, continuation = null) {
    if (closing) throw new DebateError('server_stopping', 'The server is stopping.', 409);
    if (active.has(id)) throw new DebateError('debate_busy', 'This debate is already running.', 409);
    let accept;
    let reject;
    const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    const slot = { record: null, stopped: false, live: new Map(), activities: new Map(), agents: new Map(), commit: mutationQueue(), task: null };
    active.set(id, slot);
    failures.delete(id);
    slot.task = store.own(id, async () => {
      slot.record = await store.load(id);
      let cycles = slot.record.cycles;
      if (continuation) {
        if (slot.record.status !== 'completed') throw new DebateError('cycle_incomplete', 'Finish or resume the current cycle before starting another.', 409);
        if (cycles.length !== continuation.previousCycle) throw new DebateError('cycle_changed', 'Another cycle has already been added. Reload this debate.', 409);
        cycles = [...cycles, continuation.cycle];
      } else if (slot.record.status === 'completed') {
        throw new DebateError('debate_completed', 'This cycle is complete. Send a new prompt to continue.', 409);
      }
      if (slot.stopped) throw new DebateError('response_interrupted', 'Start was interrupted.', 409);
      validateModels(slot.record.config, runtime(), cycles.flatMap((cycle) => cycle.input.images));
      slot.record = await store.save(slot.record, { cycles, status: 'running', owner: process.pid, error: null });
      changed(slot);
      accept(snapshotFor(slot.record));
      let error = null;
      try { await execute(slot); }
      catch (cause) { if (!slot.stopped) error = publicFailure(cause); }
      finally {
        const releases = await Promise.allSettled([...slot.agents.values()].map(async (instance) => {
          try { await instance.abort(); } finally { instance.dispose(); }
        }));
        if (!error && releases.some((result) => result.status === 'rejected')) {
          error = { code: 'cleanup_failed', message: 'An agent could not be released cleanly. Saved responses are intact.' };
        }
      }
      let status = 'completed';
      if (slot.stopped) status = 'interrupted';
      else if (error) status = 'failed';
      slot.live.clear();
      slot.record = await store.save(slot.record, { status, owner: null, error });
      // Stop is a runtime state only until the persisted terminal state is visible.
      slot.stopped = false;
      // Publish the terminal state only after releasing execution ownership in finally.
      // The next-cycle composer must not become usable while start() still sees a busy run.
    }).catch((error) => {
      let failure = error;
      if (error.code === 'STORAGE_LOCK_TIMEOUT') failure = new DebateError('debate_busy', 'This debate is running in another app instance. Control it there.', 409);
      if (slot.record && slot.record.owner === process.pid) {
        failures.set(id, publicFailure(failure));
      }
      reject(failure);
    }).finally(() => {
      active.delete(id);
      if (slot.record) publish(id, { kind: 'snapshot', debate: snapshotFor(slot.record) });
      onChange();
    });
    return ready;
  }

  async function continueDebate(id, value, attachments = []) {
    if (!value || !Number.isSafeInteger(value.previousCycle) || value.previousCycle < 1) {
      throw new DebateError('invalid_cycle', 'A continuation must identify its previous cycle.');
    }
    return start(id, { previousCycle: value.previousCycle, cycle: prepareDebateCycle(value, attachments) });
  }

  async function stop(id) {
    const slot = active.get(id);
    if (!slot) {
      const current = await snapshot(id);
      if (current.ownedElsewhere) throw new DebateError('debate_owned_elsewhere', 'Stop this debate in the app instance that started it.', 409);
      return current;
    }
    slot.stopped = true;
    if (slot.record) changed(slot);
    await Promise.allSettled([...slot.agents.values()].map((instance) => instance.abort()));
    await slot.task;
    return snapshot(id);
  }

  async function history(id, { before = null, finals = false } = {}) {
    const record = await recordFor(id);
    const ordered = [...record.turns].sort((a, b) => a.cycle - b.cycle || turnIndex(a.key) - turnIndex(b.key));
    let end = ordered.length;
    if (before !== null) {
      if (!Number.isSafeInteger(before) || before < 0 || before > ordered.length) throw new DebateError('invalid_cursor', 'Invalid history cursor.');
      end = before;
    }
    const start = Math.max(0, end - DEBATE_PAGE_SIZE);
    let selected = ordered.slice(start, end);
    if (finals) selected = ordered.filter((turn) => turn.cycle === record.cycles.length && Number(turn.key.slice(1)) === currentDebateCycle(record).rounds);
    return {
      turns: selected.map((turn) => ({ key: turn.key, cycle: turn.cycle,
        index: record.cycles.slice(0, turn.cycle - 1).reduce((sum, cycle) => sum + cycle.rounds * 2, 0) + turnIndex(turn.key),
        model: record.config[turn.key[0]], prompt: record.cycles[turn.cycle - 1].prompt,
        text: assistantText(turn.assistant), final: Number(turn.key.slice(1)) === record.cycles[turn.cycle - 1].rounds })),
      before: !finals && start > 0 ? start : null,
    };
  }
  async function list(options = {}) {
    const page = await store.list(options);
    return { debates: page.records.map((record) => snapshotFor(active.get(record.id)?.record ?? record)), before: page.before };
  }
  function subscribe(id, listener) {
    const set = listeners.get(id) ?? new Set();
    listeners.set(id, set);
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
  }
  async function watch(id, listener) {
    const record = await recordFor(id);
    const detach = subscribe(id, listener);
    listener({ kind: 'snapshot', debate: snapshotFor(active.get(id)?.record ?? record) });
    return detach;
  }
  async function dispose() {
    closing = true;
    await Promise.allSettled([...active.keys()].map(stop));
    for (const set of listeners.values()) for (const listener of set) listener({ kind: 'closed' });
    listeners.clear();
    failures.clear();
  }
  return { create, start, continueDebate, stop, snapshot, history, list, subscribe, watch, dispose, count: () => active.size, isActive: (id) => active.has(id), reopen: () => { closing = false; } };
}

function turnIndex(key) { return (Number(key.slice(1)) - 1) * 2 + (key[0] === 'B' ? 1 : 0); }
export const debates = createDebateService();
