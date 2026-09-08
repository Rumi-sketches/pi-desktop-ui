import { VIEW_CHAT, VIEW_SETTINGS, VIEW_TERMINAL } from "./ui-state.js";

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

/**
 * Header data is projected from the selected resource. A previous chat or
 * terminal can never leak metadata into the current header.
 */
export function chatHeaderState(selection, chat, session, {
  canOpenFolder = false,
} = {}) {
  if (selection?.view !== VIEW_CHAT || !chat || chat.key !== selection.resourceId) return null;
  const matchingSession = session?.path === selection.resourceId ? session : null;
  const started = Boolean(chat.started || (matchingSession?.messageCount ?? 0) > 0);
  return Object.freeze({
    key: chat.key,
    cwd: chat.cwd,
    folder: chat.cwd.split(/[\\/]/).filter(Boolean).pop() || chat.cwd,
    title: matchingSession?.title || matchingSession?.name || matchingSession?.firstMessage || "New chat",
    started,
    canChangeFolder: !started,
    canOpenFolder: Boolean(canOpenFolder),
    model: chat.model,
    metrics: chat.metrics,
    streaming: chat.streaming,
  });
}

/** The terminal counterpart of chatHeaderState. */
export function terminalHeaderState(selection, terminal, {
  canOpenFolder = false,
  canCopyPath = false,
} = {}) {
  if (selection?.view !== VIEW_TERMINAL || !terminal || terminal.id !== selection.resourceId) return null;
  const exited = terminal.exited !== null && terminal.exited !== undefined;
  return Object.freeze({
    id: terminal.id,
    cwd: terminal.cwd,
    folder: terminal.cwd.split(/[\\/]/).filter(Boolean).pop() || terminal.cwd,
    kind: terminal.kind === "pi" ? "Pi terminal" : "PowerShell",
    status: exited ? `Exited (${terminal.exited})` : "Running",
    running: !exited,
    canOpenFolder: Boolean(canOpenFolder),
    canCopyPath: Boolean(canCopyPath),
  });
}

/**
 * Keeps rendering ahead of network synchronization and starts each owner scope
 * independently. Global catalogs are not accepted here: they belong to the
 * bootstrap or to an explicit invalidation, never to an ordinary switch.
 */
export function createNavigationSynchronizer({
  showCachedChat,
  syncSessions,
  syncChat,
  syncProject,
  reportError = (..._args) => {},
}) {
  requireFunction(showCachedChat, "showCachedChat");
  requireFunction(syncSessions, "syncSessions");
  requireFunction(syncChat, "syncChat");
  requireFunction(syncProject, "syncProject");
  requireFunction(reportError, "reportError");

  function show(selection) {
    if (selection?.view === VIEW_CHAT) showCachedChat(selection.resourceId);
  }

  async function synchronize(ticket, projectCwd) {
    const selection = ticket?.selection;
    if (selection?.view !== VIEW_CHAT) return [];
    const owner = Object.freeze({ key: selection.resourceId, projectCwd, ticket });
    const jobs = [
      ["sessions", syncSessions],
      ["chat", syncChat],
      ...(projectCwd ? [["project", syncProject]] : []),
    ];
    const results = await Promise.allSettled(jobs.map(([, sync]) => Promise.resolve().then(() => sync(owner))));
    results.forEach((result, index) => {
      if (result.status === "rejected") reportError(jobs[index][0], result.reason);
    });
    return results;
  }

  return { show, synchronize };
}

/**
 * Owns the ordering of navigation changes. A ticket identifies one transition;
 * work completed for an older ticket cannot commit another selection.
 */
export function createNavigationController({
  state,
  isAvailable = (..._args) => true,
  onTransition = (..._args) => {},
}) {
  if (!state || typeof state.select !== "function") {
    throw new TypeError("state must be a UI state store");
  }
  requireFunction(isAvailable, "isAvailable");
  requireFunction(onTransition, "onTransition");

  let revision = 0;
  let activeController = new AbortController();

  function begin() {
    activeController?.abort();
    activeController = new AbortController();
    revision += 1;
    return Object.freeze({ revision, selection: null, signal: activeController.signal });
  }

  function isCurrent(ticket) {
    return ticket?.revision === revision && ticket.signal?.aborted === false;
  }

  function commit(selection, ticket = begin()) {
    if (!isCurrent(ticket)) return null;
    const next = state.select(selection);
    const committed = Object.freeze({ revision: ticket.revision, selection: next, signal: ticket.signal });
    onTransition(next, committed);
    return committed;
  }

  function transition(selection) {
    return commit(selection, begin());
  }

  function usable(selection, tabId) {
    return selection?.tabId === tabId
      && state.canSelect(selection)
      && isAvailable(selection);
  }

  /** @param {string} tabId @param {((tabId: string) => any) | undefined} fallback */
  function selectionForTab(tabId, fallback) {
    const project = state.projects.get(tabId);
    if (!project) throw new TypeError("tab id does not identify an open project tab");
    if (usable(project.lastSelection, tabId)) return project.lastSelection;
    if (project.lastSelection) state.clearLastSelection(tabId);
    const candidate = fallback?.(tabId) ?? null;
    return usable(candidate, tabId) ? candidate : null;
  }

  function switchTab(tabId, fallback) {
    const ticket = begin();
    const selection = selectionForTab(tabId, fallback);
    return selection ? commit(selection, ticket) : ticket;
  }

  function closeTab({ tabId, projectCwds, landingTabId, fallback }) {
    const activeWasClosed = state.selection?.tabId === tabId || state.activeTabId === tabId;
    state.replaceProjectTabs(projectCwds);
    if (!activeWasClosed && state.selection) {
      return Object.freeze({ revision, selection: state.selection, signal: activeController.signal });
    }
    const ticket = begin();
    const selection = selectionForTab(landingTabId, fallback);
    return selection ? commit(selection, ticket) : ticket;
  }

  function restoreActive(fallback) {
    return switchTab(state.activeTabId, fallback);
  }

  function settings(tabId = state.activeTabId) {
    return transition({ tabId, view: VIEW_SETTINGS, resourceId: null });
  }

  return {
    begin,
    commit,
    transition,
    switchTab,
    closeTab,
    restoreActive,
    settings,
    isCurrent,
    currentRevision: () => revision,
  };
}
