// Shared boundary contract. No Node dependencies: the form and server agree.
export const MIN_DEBATE_ROUNDS = 2;
export const DEBATE_PAGE_SIZE = 20;
export const DEBATE_STATUSES = new Set(['ready', 'running', 'stopping', 'interrupted', 'failed', 'completed']);
export const DEBATE_ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class DebateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DebateError';
    this.code = code;
    this.status = status;
  }
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DebateError('invalid_configuration', `${field} must be a non-empty string.`);
  }
  return value;
}

function participant(value, name) {
  if (!value || typeof value !== 'object') throw new DebateError('invalid_configuration', `Missing agent ${name}.`);
  return {
    provider: text(value.provider, `${name}.provider`),
    model: text(value.model, `${name}.model`),
    effort: text(value.effort, `${name}.effort`),
    name: text(value.name ?? value.model, `${name}.name`),
  };
}

export function parseDebateCycle(value) {
  if (!value || typeof value !== 'object') throw new DebateError('invalid_configuration', 'Missing cycle configuration.');
  if (!Number.isSafeInteger(value.rounds) || value.rounds < MIN_DEBATE_ROUNDS || value.rounds > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new DebateError('invalid_rounds', `Rounds must be an integer of at least ${MIN_DEBATE_ROUNDS}.`);
  }
  return {
    prompt: text(value.prompt, 'Prompt'),
    rounds: Number(value.rounds),
  };
}

export function parseDebateConfig(value) {
  return {
    ...parseDebateCycle(value),
    cwd: text(value.cwd, 'Project folder'),
    A: participant(value.A, 'A'),
    B: participant(value.B, 'B'),
  };
}

export function assertDebateId(id) {
  if (typeof id !== 'string' || !DEBATE_ID.test(id)) throw new DebateError('invalid_debate_id', 'Invalid debate ID.');
  return id;
}

/** Validate the public snapshot at the network boundary, before touching UI state. */
export function parseDebateSnapshot(value) {
  if (!value || !DEBATE_STATUSES.has(value.status) || !Number.isSafeInteger(value.revision)
      || value.revision < 0 || typeof value.ownedElsewhere !== 'boolean'
      || !Number.isSafeInteger(value.completed) || value.completed < 0
      || !Number.isSafeInteger(value.cycle) || value.cycle < 1
      || !Number.isSafeInteger(value.totalCompleted) || value.totalCompleted < value.completed
      || !Array.isArray(value.attachments) || !Array.isArray(value.live)) throw new TypeError('Invalid debate snapshot');
  const config = parseDebateConfig(value.config);
  if (value.completed > config.rounds * 2) throw new TypeError('Invalid debate progress');
  const error = value.error;
  if (error !== null && (!error || typeof error.code !== 'string' || typeof error.message !== 'string')) {
    throw new TypeError('Invalid debate error');
  }
  const live = value.live.map((item) => {
    if (!item || !/^[AB][1-9]\d*$/.test(item.key) || typeof item.text !== 'string') throw new TypeError('Invalid live turn');
    if (typeof item.activity !== 'string') throw new TypeError('Invalid debate activity');
    return { key: item.key, text: item.text, activity: item.activity };
  });
  return {
    id: assertDebateId(value.id), config, status: value.status, revision: value.revision,
    completed: value.completed, totalCompleted: value.totalCompleted, cycle: value.cycle,
    title: text(value.title, 'Debate title'),
    attachments: value.attachments.map((item) => {
      if (!item || !['file', 'image'].includes(item.kind) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new TypeError('Invalid attachment metadata');
      return { name: text(item.name, 'Attachment name'), kind: item.kind, bytes: item.bytes };
    }),
    ownedElsewhere: value.ownedElsewhere, error, live,
  };
}

export function parseDebateTurns(value) {
  if (!value || !Array.isArray(value.turns) || !(value.before === null || Number.isSafeInteger(value.before))) {
    throw new TypeError('Invalid debate history');
  }
  return {
    before: value.before,
    turns: value.turns.map((turn) => {
      if (!turn || !/^[AB][1-9]\d*$/.test(turn.key) || typeof turn.text !== 'string'
          || typeof turn.final !== 'boolean' || !Number.isSafeInteger(turn.index)
          || !Number.isSafeInteger(turn.cycle) || turn.cycle < 1) throw new TypeError('Invalid debate turn');
      return { key: turn.key, text: turn.text, final: turn.final, index: turn.index, cycle: turn.cycle,
        model: participant(turn.model, turn.key[0]), prompt: text(turn.prompt, 'Cycle prompt') };
    }),
  };
}
