import { createChatCache } from "./chat-cache.js";

export const ALL_TAB_ID = "all";
export const VIEW_CHAT = "chat";
export const VIEW_TERMINAL = "terminal";
export const VIEW_SETTINGS = "settings";

const VIEW_TYPES = new Set([VIEW_CHAT, VIEW_TERMINAL, VIEW_SETTINGS]);
const TERMINAL_KINDS = new Set(["pi", "shell"]);
const SESSION_STATUSES = new Set(["active", "done", "reopened"]);
const QUEUE_TYPES = new Set(["steer", "followUp"]);

export const RESPONSE_IDLE = "idle";
export const RESPONSE_WAITING = "waiting";
export const RESPONSE_TEXT = "text";

function invalid(label, message) {
  throw new TypeError(`${label} ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label, "must be an object");
  return value;
}

function string(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    invalid(label, empty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function nullableString(value, label) {
  return value === null ? null : string(value, label);
}

function boolean(value, label) {
  if (typeof value !== "boolean") invalid(label, "must be a boolean");
  return value;
}

function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(label, "must be a finite number");
  return value;
}

function nonNegativeNumber(value, label) {
  const normalized = number(value, label);
  if (normalized < 0) invalid(label, "must not be negative");
  return normalized;
}

function nullableNonNegativeNumber(value, label) {
  return value === null ? null : nonNegativeNumber(value, label);
}

function stringArray(value, label) {
  if (!Array.isArray(value)) invalid(label, "must be an array");
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function model(value, label) {
  if (value === null) return null;
  const source = record(value, label);
  return {
    provider: string(source.provider, `${label}.provider`),
    id: string(source.id, `${label}.id`),
  };
}

const USAGE_FIELDS = ["tokens", "input", "output", "cacheWrite", "cacheRead", "cost", "requests"];
const TOTAL_FIELDS = ["input", "output", "cost", "requests"];
function numericFields(value, label, fields) {
  const source = record(value, label);
  const normalized = {};
  for (const field of fields) normalized[field] = nonNegativeNumber(source[field], `${label}.${field}`);
  return normalized;
}
const usage = (value, label) => numericFields(value, label, USAGE_FIELDS);
const totals = (value, label) => numericFields(value, label, TOTAL_FIELDS);

function usageByModel(value, label) {
  const source = record(value, label);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [
    string(key, `${label} key`),
    usage(item, `${label}.${key}`),
  ]));
}

function contextUsage(value, label) {
  if (value === null) return null;
  const source = record(value, label);
  const tokens = nullableNonNegativeNumber(source.tokens, `${label}.tokens`);
  const percent = nullableNonNegativeNumber(source.percent, `${label}.percent`);
  if ((tokens === null) !== (percent === null)) {
    invalid(label, "tokens and percent must both be known or both be null");
  }
  return {
    tokens,
    contextWindow: nonNegativeNumber(source.contextWindow, `${label}.contextWindow`),
    percent,
  };
}

export function normalizeChatMetrics(value, label = "chat metrics") {
  const source = record(value, label);
  return {
    total: usage(source.total, `${label}.total`),
    byModel: usageByModel(source.byModel, `${label}.byModel`),
    sessionWork: source.sessionWork === null ? null : usage(source.sessionWork, `${label}.sessionWork`),
    context: contextUsage(source.context, `${label}.context`),
  };
}

function platform(value, label) {
  const source = record(value, label);
  return {
    os: string(source.os, `${label}.os`),
    osName: string(source.osName, `${label}.osName`, { empty: true }),
    pickFolder: boolean(source.pickFolder, `${label}.pickFolder`),
    openFolder: boolean(source.openFolder, `${label}.openFolder`),
    openTerminal: boolean(source.openTerminal, `${label}.openTerminal`),
    typeInTerminal: boolean(source.typeInTerminal, `${label}.typeInTerminal`),
  };
}

function queuedAttachment(value, label) {
  const source = record(value, label);
  return {
    mimeType: string(source.mimeType, `${label}.mimeType`),
    bytes: nonNegativeNumber(source.bytes, `${label}.bytes`),
  };
}

export function normalizeQueuedPrompts(value, label = "queued prompts") {
  if (!Array.isArray(value)) invalid(label, "must be an array");
  const ids = new Set();
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const source = record(item, itemLabel);
    const id = string(source.id, `${itemLabel}.id`);
    if (ids.has(id)) invalid(`${itemLabel}.id`, "must be unique");
    ids.add(id);
    const type = string(source.type, `${itemLabel}.type`);
    if (!QUEUE_TYPES.has(type)) invalid(`${itemLabel}.type`, "must be steer or followUp");
    if (!Array.isArray(source.attachments)) invalid(`${itemLabel}.attachments`, "must be an array");
    return {
      id,
      type,
      text: string(source.text, `${itemLabel}.text`, { empty: true }),
      attachments: source.attachments.map((attachment, attachmentIndex) =>
        queuedAttachment(attachment, `${itemLabel}.attachments[${attachmentIndex}]`)),
      bytes: nonNegativeNumber(source.bytes, `${itemLabel}.bytes`),
    };
  });
}

export function normalizeStatePayload(value) {
  const source = record(value, "state payload");
  const levels = stringArray(source.thinkingLevels, "state payload.thinkingLevels");
  const level = source.thinkingLevel === null
    ? null
    : string(source.thinkingLevel, "state payload.thinkingLevel");
  if (level !== null && !levels.includes(level)) {
    invalid("state payload.thinkingLevel", "must occur in thinkingLevels");
  }
  return {
    key: string(source.key, "state payload.key"),
    sessionFile: nullableString(source.sessionFile, "state payload.sessionFile"),
    cwd: string(source.cwd, "state payload.cwd"),
    thinkingLevels: levels,
    current: model(source.current, "state payload.current"),
    thinkingLevel: level,
    totals: totals(source.totals, "state payload.totals"),
    metrics: normalizeChatMetrics(source.metrics, "state payload.metrics"),
    streaming: boolean(source.streaming, "state payload.streaming"),
    queuedPrompts: normalizeQueuedPrompts(source.queuedPrompts, "state payload.queuedPrompts"),
    platform: platform(source.platform, "state payload.platform"),
    chatArchiving: boolean(source.chatArchiving, "state payload.chatArchiving"),
  };
}

export function normalizeModelsPayload(value) {
  const source = record(value, "models payload");
  if (!Array.isArray(source.models)) invalid("models payload.models", "must be an array");
  return {
    current: model(source.current, "models payload.current"),
    thinkingLevel: source.thinkingLevel === null
      ? null
      : string(source.thinkingLevel, "models payload.thinkingLevel"),
    thinkingLevels: stringArray(source.thinkingLevels, "models payload.thinkingLevels"),
    models: source.models.map((item, index) => {
      const entry = record(item, `models payload.models[${index}]`);
      return {
        ...entry,
        provider: string(entry.provider, `models payload.models[${index}].provider`),
        id: string(entry.id, `models payload.models[${index}].id`),
      };
    }),
  };
}

export function normalizeCommandsPayload(value) {
  const source = record(value, "commands payload");
  if (!Array.isArray(source.commands)) invalid("commands payload.commands", "must be an array");
  return {
    commands: source.commands.map((item, index) => {
      const entry = record(item, `commands payload.commands[${index}]`);
      return {
        ...entry,
        name: string(entry.name, `commands payload.commands[${index}].name`),
        description: string(entry.description ?? "", `commands payload.commands[${index}].description`, { empty: true }),
        source: string(entry.source, `commands payload.commands[${index}].source`),
      };
    }),
  };
}

function session(value, index) {
  const label = `sessions payload.sessions[${index}]`;
  const source = record(value, label);
  const status = string(source.status, `${label}.status`);
  if (!SESSION_STATUSES.has(status)) invalid(`${label}.status`, "must be active, done or reopened");
  return {
    ...source,
    path: string(source.path, `${label}.path`),
    id: string(source.id, `${label}.id`),
    cwd: string(source.cwd, `${label}.cwd`, { empty: true }),
    name: string(source.name, `${label}.name`, { empty: true }),
    firstMessage: string(source.firstMessage, `${label}.firstMessage`, { empty: true }),
    title: string(source.title, `${label}.title`, { empty: true }),
    messageCount: number(source.messageCount, `${label}.messageCount`),
    modified: string(source.modified, `${label}.modified`),
    favorite: boolean(source.favorite, `${label}.favorite`),
    status,
    provider: string(source.provider, `${label}.provider`, { empty: true }),
    model: string(source.model, `${label}.model`, { empty: true }),
  };
}

export function normalizeSessionsPayload(value) {
  const source = record(value, "sessions payload");
  if (!Array.isArray(source.sessions)) invalid("sessions payload.sessions", "must be an array");
  const scope = string(source.scope, "sessions payload.scope");
  if (scope !== "all" && scope !== "cwd") invalid("sessions payload.scope", "must be all or cwd");
  return {
    current: nullableString(source.current, "sessions payload.current"),
    cwd: string(source.cwd, "sessions payload.cwd"),
    scope,
    running: stringArray(source.running, "sessions payload.running"),
    open: stringArray(source.open, "sessions payload.open"),
    sessions: source.sessions.map(session),
  };
}

function terminal(value, index) {
  const label = `terminals payload.terminals[${index}]`;
  const source = record(value, label);
  const kind = string(source.kind, `${label}.kind`);
  if (!TERMINAL_KINDS.has(kind)) invalid(`${label}.kind`, "must be pi or shell");
  return {
    id: string(source.id, `${label}.id`),
    kind,
    cwd: string(source.cwd, `${label}.cwd`),
    createdAt: number(source.createdAt, `${label}.createdAt`),
    chatKey: nullableString(source.chatKey, `${label}.chatKey`),
    exited: source.exited === null ? null : number(source.exited, `${label}.exited`),
  };
}

export function normalizeTerminalsPayload(value) {
  const source = record(value, "terminals payload");
  if (!Array.isArray(source.terminals)) invalid("terminals payload.terminals", "must be an array");
  return { terminals: source.terminals.map(terminal) };
}

export function projectTabId(cwd) {
  return cwd === null ? ALL_TAB_ID : `project:${string(cwd, "project cwd")}`;
}

function newChatState(key = null) {
  return {
    key,
    cwd: "",
    model: null,
    thinking: "off",
    thinkingLevels: ["off"],
    streaming: false,
    turnModel: null,
    metrics: null,
    queuedPrompts: [],
    responsePhase: RESPONSE_IDLE,
    started: false,
    tasks: new Map(),
    agentTask: null,
  };
}

function sameProject(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function createUiState({ chatCache = createChatCache() } = {}) {
  if (!chatCache || typeof chatCache.ensure !== "function" || typeof chatCache.rekey !== "function") {
    invalid("chat cache", "must provide ensure and rekey functions");
  }
  const global = {
    totals: null,
    platform: null,
    chatArchiving: true,
    models: [],
    commands: [],
  };
  const projects = new Map([[ALL_TAB_ID, { id: ALL_TAB_ID, cwd: null, lastSelection: null }]]);
  const projectData = new Map();
  const chats = new Map();
  const terminals = new Map();
  const pendingChat = newChatState();
  let activeTabId = ALL_TAB_ID;
  let selection = null;

  function registerProject(cwd) {
    const id = projectTabId(cwd);
    if (!projects.has(id)) projects.set(id, { id, cwd, lastSelection: null });
    return projects.get(id);
  }

  function projectState(cwd) {
    string(cwd, "project cwd");
    const canonical = [...projectData.keys()].find((key) => sameProject(key, cwd)) ?? cwd;
    if (!projectData.has(canonical)) {
      projectData.set(canonical, { cwd, git: null, files: [], activeFile: null, diffHtml: '' });
    }
    return projectData.get(canonical);
  }

  function chatState(key) {
    if (key === null || key === undefined) return pendingChat;
    string(key, "chat key");
    if (!chats.has(key)) chats.set(key, newChatState(key));
    return chats.get(key);
  }

  function chatViewState(key) {
    string(key, "chat key");
    return chatCache.ensure(key);
  }

  function rekeyChat(oldKey, newKey) {
    string(oldKey, "old chat key");
    string(newKey, "new chat key");
    if (oldKey === newKey) return chatState(newKey);
    const source = chats.get(oldKey);
    if (!source) {
      if (chatCache.peek?.(oldKey)) chatCache.rekey(oldKey, newKey);
      return chatState(newKey);
    }
    if (chats.has(newKey)) invalid("new chat key", "already identifies another chat");
    if (chatCache.peek?.(oldKey)) chatCache.rekey(oldKey, newKey);
    chats.delete(oldKey);
    source.key = newKey;
    chats.set(newKey, source);
    for (const project of projects.values()) {
      const remembered = project.lastSelection;
      if (remembered?.view !== VIEW_CHAT || remembered.resourceId !== oldKey) continue;
      const next = Object.freeze({ ...remembered, resourceId: newKey });
      project.lastSelection = next;
      if (selection === remembered) selection = next;
    }
    return source;
  }

  function replaceProjectTabs(cwds) {
    if (!Array.isArray(cwds)) invalid("project tabs", "must be an array");
    const keep = new Set([ALL_TAB_ID]);
    for (const cwd of cwds) keep.add(registerProject(string(cwd, "project tab cwd")).id);
    for (const id of projects.keys()) if (!keep.has(id)) projects.delete(id);
    if (!projects.has(activeTabId)) activeTabId = ALL_TAB_ID;
    if (selection && !projects.has(selection.tabId)) selection = null;
  }

  function setActiveTab(tabId) {
    string(tabId, "tab id");
    if (!projects.has(tabId)) invalid("tab id", "does not identify an open project tab");
    activeTabId = tabId;
  }

  function validateSelection(value) {
    const candidate = record(value, "selection");
    const keys = Object.keys(candidate);
    if (keys.length !== 3 || !keys.includes("tabId") || !keys.includes("view") || !keys.includes("resourceId")) {
      invalid("selection", "must contain only tabId, view and resourceId");
    }
    const tabId = string(candidate.tabId, "selection.tabId");
    const view = string(candidate.view, "selection.view");
    if (!VIEW_TYPES.has(view)) invalid("selection.view", "must be chat, terminal or settings");
    const project = projects.get(tabId);
    if (!project) invalid("selection.tabId", "does not identify an open project tab");

    if (view === VIEW_SETTINGS) {
      if (candidate.resourceId !== null) invalid("selection.resourceId", "must be null for settings");
      return { tabId, view, resourceId: null };
    }

    const resourceId = string(candidate.resourceId, "selection.resourceId");
    const resource = view === VIEW_CHAT ? chats.get(resourceId) : terminals.get(resourceId);
    if (!resource) invalid("selection.resourceId", `does not identify a ${view}`);
    if (project.cwd !== null && (!resource.cwd || !sameProject(resource.cwd, project.cwd))) {
      invalid("selection.resourceId", `does not belong to tab ${tabId}`);
    }
    return { tabId, view, resourceId };
  }

  function canSelect(value) {
    try {
      validateSelection(value);
      return true;
    } catch {
      return false;
    }
  }

  function clearLastSelection(tabId) {
    string(tabId, "tab id");
    const project = projects.get(tabId);
    if (!project) invalid("tab id", "does not identify an open project tab");
    project.lastSelection = null;
  }

  function select(value) {
    const next = Object.freeze(validateSelection(value));
    selection = next;
    activeTabId = next.tabId;
    projects.get(next.tabId).lastSelection = next;
    return next;
  }

  function applyStatePayload(value) {
    const payload = normalizeStatePayload(value);
    global.totals = payload.totals;
    global.platform = payload.platform;
    global.chatArchiving = payload.chatArchiving;
    const target = chatState(payload.key);
    const responsePhase = payload.streaming
      ? (target.streaming && target.responsePhase === RESPONSE_TEXT ? RESPONSE_TEXT : RESPONSE_WAITING)
      : RESPONSE_IDLE;
    Object.assign(target, {
      cwd: payload.cwd,
      model: payload.current,
      thinking: payload.thinkingLevel ?? "off",
      thinkingLevels: payload.thinkingLevels.length ? payload.thinkingLevels : ["off"],
      streaming: payload.streaming,
      queuedPrompts: payload.queuedPrompts,
      responsePhase,
      metrics: payload.metrics,
    });
    return payload;
  }

  function applyMetricsPayload(key, value) {
    const metrics = normalizeChatMetrics(value);
    chatState(key).metrics = metrics;
    return metrics;
  }

  function applyQueuedPrompts(key, value) {
    const queuedPrompts = normalizeQueuedPrompts(value);
    chatState(key).queuedPrompts = queuedPrompts;
    return queuedPrompts;
  }

  function startResponse(key) {
    const target = chatState(key);
    target.streaming = true;
    target.responsePhase = RESPONSE_WAITING;
    return target;
  }

  function markResponseText(key) {
    const target = chatState(key);
    if (target.streaming) target.responsePhase = RESPONSE_TEXT;
    return target;
  }

  function finishResponse(key) {
    const target = chatState(key);
    target.streaming = false;
    target.responsePhase = RESPONSE_IDLE;
    return target;
  }

  function applyModelsPayload(value) {
    const payload = normalizeModelsPayload(value);
    global.models = payload.models;
    return payload;
  }

  function applyCommandsPayload(value) {
    const payload = normalizeCommandsPayload(value);
    global.commands = payload.commands;
    return payload;
  }

  function applySessionsPayload(value) {
    const payload = normalizeSessionsPayload(value);
    for (const item of payload.sessions) {
      const target = chatState(item.path);
      target.cwd = item.cwd;
      target.started ||= item.messageCount > 0;
      if (item.provider && item.model) target.model = { provider: item.provider, id: item.model };
      if (item.cwd) registerProject(item.cwd);
    }
    return payload;
  }

  function applyTerminalsPayload(value) {
    const payload = normalizeTerminalsPayload(value);
    terminals.clear();
    for (const item of payload.terminals) {
      terminals.set(item.id, item);
      registerProject(item.cwd);
    }
    return payload;
  }

  return {
    global,
    projects,
    projectData,
    chats,
    terminals,
    pendingChat,
    chatCache,
    get activeTabId() { return activeTabId; },
    get selection() { return selection; },
    registerProject,
    projectState,
    replaceProjectTabs,
    setActiveTab,
    chatState,
    chatViewState,
    rekeyChat,
    canSelect,
    clearLastSelection,
    select,
    applyStatePayload,
    applyMetricsPayload,
    applyQueuedPrompts,
    startResponse,
    markResponseText,
    finishResponse,
    applyModelsPayload,
    applyCommandsPayload,
    applySessionsPayload,
    applyTerminalsPayload,
  };
}
