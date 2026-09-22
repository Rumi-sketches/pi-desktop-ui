// Page logic of pi desktop ui, extracted from index.html so the page can ship
// a CSP without 'unsafe-inline'. ES module: it runs deferred, after parsing.
import {
  RESPONSE_IDLE,
  RESPONSE_TEXT,
  RESPONSE_WAITING,
  VIEW_CHAT,
  VIEW_SETTINGS,
  VIEW_TERMINAL,
  createUiState,
  normalizeSearchPayload,
  projectTabId,
} from './ui-state.js';
import { createChatCache } from './chat-cache.js';
import { createDraftStorage } from './draft-storage.js';
import {
  chatHeaderState,
  createNavigationController,
  createNavigationSynchronizer,
} from './navigation.js';
import { createTransport } from './transport.js';
import { providerIconHtml } from './provider-icons.js';
import { createAgentInputs } from './agent-inputs.js';
import { createSettingsView } from './settings-view.js';
import { createTerminalView } from './terminal-view.js';
import { createChatView } from './chat-view.js';

// During a development hot reload the page can briefly outlive the server that
// learned the new icon route. Never expose the browser's broken-image glyph:
// the next full app restart loads the PNG, while this run degrades cleanly.
document.addEventListener('error', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('logo-img')) return;
  const logo = image.closest('.logo');
  if (!logo) return;
  logo.classList.add('icon-failed');
}, true);

// The vendored libraries (marked, DOMPurify, highlight.js) load as classic
// scripts and land on `window` with no declarations of their own. One untyped
// view of the global object, instead of a cast per call site.
// Nothing here imports them: an ES import of a library that is not real ESM
// fails, and a failed import kills this whole module — with it, every button.
const win = /** @type {any} */ (window);

// Untyped on purpose: the page reads `.value`, `.checked`, `.dataset` off ids
// whose markup it owns, and threading a cast through every call site would
// cost far more than the two typos it would catch.
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
// Same deal for selector queries: an array (not a NodeList) of untyped nodes.
/** @type {(sel: string, root?: ParentNode) => any[]} */
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
/* Text and sidebar metadata survive a reload in the existing sessionStorage
   keys. The bounded cache owns their lifecycle; attachment payloads stay only
   in its in-memory entries. */
const draftStorage = createDraftStorage({ storage: sessionStorage });
const chatCache = createChatCache({ draftStorage });
window.addEventListener('pagehide', () => chatCache.flushDrafts());
const uiState = createUiState({ chatCache });
const navigation = createNavigationController({
  state: uiState,
  isAvailable: isNavigationSelectionAvailable,
  onTransition: renderNavigationSelection,
});
const transport = createTransport({
  fetchImpl: window.fetch.bind(window),
  createEventSource: (url) => new EventSource(url),
});
const navigationSync = createNavigationSynchronizer({
  showCachedChat: (key) => showChatResource(key),
  syncSessions: () => loadSessions(),
  syncChat: ({ key, ticket }) => Promise.all([
    loadState({ key, ticket }),
    refreshChat({ key, ticket }),
  ]),
  syncProject: ({ key, projectCwd }) => Promise.all([
    loadFiles({ key, projectCwd }),
    refreshGit({ key, projectCwd }),
  ]),
  reportError: (scope, error) => toast(`Could not synchronize ${scope}: ${error?.message ?? error}`),
});
const activeChatKey = () => uiState.selection?.view === VIEW_CHAT ? uiState.selection.resourceId : null;
const activeProjectCwd = () => uiState.projects.get(uiState.activeTabId)?.cwd ?? null;
const sameCwd = (left, right) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());
function projectScopeForChat(key = activeChatKey()) {
  const cwd = key ? uiState.chatState(key).cwd : '';
  return cwd ? uiState.projectState(cwd) : null;
}
const activeProjectScope = () => projectScopeForChat(activeChatKey());
const isProjectScopeActive = (cwd) => sameCwd(activeProjectScope()?.cwd, cwd);

/* ---------------- per-tab chat binding ----------------
   Every tab is bound to ONE chat (its "session key" = the session file path).
   It lives in sessionStorage (per-tab) and in the URL hash, so a tab can be
   duplicated/reopened on the same chat.
   The server keeps the chat alive even when no tab is watching it: leaving a
   chat no longer interrupts anything. */
let renderedChatKey = null;
try {
  const h = new URLSearchParams(location.hash.slice(1)).get('s');
  renderedChatKey = h || sessionStorage.getItem('piSessionKey') || null;
} catch { renderedChatKey = null; }
const activeChatState = () => {
  const key = activeChatKey() ?? renderedChatKey;
  return key ? uiState.chatState(key) : uiState.pendingChat;
};
// This key owns the DOM currently mounted in #chat. Navigation remains the
// only owner of selection; this function only parks/restores that view.
function showChatResource(key, { reconnect = true, park = true } = {}) {
  if (!key) return;
  if (key === renderedChatKey) {
    if (chatCache.peek(key)?.view.snapshot) restoreChatView(key);
    return;
  }
  if (park) parkChatView(renderedChatKey);
  renderedChatKey = key;
  try { sessionStorage.setItem('piSessionKey', key); } catch {}
  history.replaceState(null, '', '#s=' + encodeURIComponent(key));
  restoreChatView(key);
  if (reconnect) connect(key);
}

function draftTitle(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function storeComposerDraft(key, value, metadata = undefined) {
  const current = chatCache.draftRecord(key).metadata;
  const state = uiState.chatState(key);
  const nextMetadata = metadata ?? ((value.trim() || current?.pending) ? {
    cwd: state.cwd,
    title: current?.title || draftTitle(value),
    modified: current?.modified ?? new Date().toISOString(),
    pending: current?.pending ?? false,
  } : null);
  return chatCache.setDraft(key, value, { metadata: nextMetadata });
}

function stashComposerDraft(key) {
  if (key) storeComposerDraft(key, $('input').value);
}

function updateComposerDraft(key, value) {
  if (!key) return;
  const current = chatCache.draftRecord(key);
  const hadDraft = Boolean(current.draft.trim());
  const hasDraft = Boolean(value.trim());
  const state = uiState.chatState(key);
  const metadata = hasDraft ? {
    cwd: state.cwd,
    title: draftTitle(value),
    modified: current.metadata?.modified ?? new Date().toISOString(),
    pending: current.metadata?.pending ?? false,
  } : current.metadata;
  const entry = storeComposerDraft(key, value, metadata);
  if (hadDraft !== hasDraft) {
    renderSessions();
    return;
  }
  if (!hasDraft) return;
  // Existing rows keep their server title. A local draft has no server title
  // yet, so update its visible label without rebuilding a long chat list for
  // every keystroke.
  for (const row of $$('.sessionItem')) {
    if (row.dataset.sessionKey !== entry.key || row.dataset.local !== 'true') continue;
    row.querySelector('.lbl').textContent = metadata.title;
    row.title = metadata.title;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n ?? 0));
// amounts below $1 need 4 decimals to stay readable, above it 2 are enough
const money = (n) => { const v = n ?? 0; return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2)); };

// Desktop app or plain browser tab. It decides the modifier of every shortcut:
// in Electron we own the whole keyboard and Ctrl is the natural key, in a
// browser tab Ctrl+T/N/W/P belong to the browser and never reach the page, so
// there Shift stays.
const IS_ELECTRON = /electron\//i.test(navigator.userAgent);
document.documentElement.classList.toggle('electron', IS_ELECTRON);
const MOD = IS_ELECTRON ? 'Ctrl' : 'Shift';
const hasMod = (e) => (IS_ELECTRON ? e.ctrlKey && !e.shiftKey && !e.metaKey : e.shiftKey && !e.ctrlKey && !e.metaKey) && !e.altKey;

const TOAST_LIFETIME_MS = 6000;
function toast(msg, ok = false, { actionLabel = '', onAction = null } = {}) {
  const actionable = typeof onAction === 'function';
  const t = document.createElement(actionable ? 'button' : 'div');
  if (actionable) t.setAttribute('type', 'button');
  t.className = 'toast' + (ok ? ' ok' : '');
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);
  if (actionLabel) {
    const action = document.createElement('span');
    action.className = 'toastAction';
    action.textContent = actionLabel;
    t.appendChild(action);
  }
  if (actionable) t.addEventListener('click', () => {
    t.remove();
    onAction();
  }, { once: true });
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), TOAST_LIFETIME_MS);
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text ?? ''); }
  catch { toast('Copy failed (browser clipboard permissions)'); }
}
// Two error shapes travel on the wire: the flat `{ error: 'message' }` of most
// endpoints and the `{ error: { code, message } }` of the few that carry a
// machine-readable code. Flatten both into { code, message } so callers only
// ever deal with one.
function errorInfo(payload, fallback) {
  const raw = payload?.error;
  if (raw && typeof raw === 'object') return { code: raw.code ?? '', message: raw.message || fallback };
  if (typeof raw === 'string' && raw) return { code: '', message: raw };
  return { code: '', message: fallback };
}
// every call goes through here: errors are always surfaced, never silent —
// except the codes a caller lists in `quiet`, which it reports its own way.
// Chat-scoped callers pass their captured key and navigation ticket: the
// transport then rejects both aborted fetches and answers completed too late.
async function api(url, opts, {
  quiet = [],
  followKey = true,
  key = activeChatKey() ?? renderedChatKey,
  ticket = null,
  guardChat = false,
  guard = null,
  signal = null,
} = {}) {
  const revision = navigation.currentRevision();
  const isCurrent = ticket || guardChat || guard
    ? () => revision === navigation.currentRevision()
      && (!ticket || navigation.isCurrent(ticket))
      && (!guardChat || activeChatKey() === key)
      && (!guard || guard())
    : null;
  try {
    const result = await transport.request(url, opts, {
      sessionKey: url.startsWith('/api/') ? key : null,
      navigationRevision: ticket?.revision ?? navigation.currentRevision(),
      signal: ticket?.signal ?? signal ?? opts?.signal,
      isCurrent,
    });
    if (result.aborted) return { error: 'aborted', code: 'aborted', stale: true };
    if (result.stale) return { error: 'stale', code: 'stale', stale: true };
    const r = result.response;
    const d = result.payload;
    if (!r.ok || d.error) {
      const err = errorInfo(d, `${url}: HTTP ${r.status}`);
      if (!quiet.includes(err.code)) toast(err.message);
      return { error: err.message, code: err.code };
    }
    if (followKey && d.key && (!key || key === renderedChatKey || key === activeChatKey())) {
      const oldKey = key ?? activeChatKey() ?? renderedChatKey;
      if (oldKey && oldKey !== d.key && uiState.chats.has(oldKey)) {
        parkChatView(oldKey);
        uiState.rekeyChat(oldKey, d.key);
        renderedChatKey = null;
      }
      showChatResource(d.key, { reconnect: d.key !== oldKey, park: false });
    }
    return d;
  } catch (e) {
    toast(`${url}: ${e.message}`);
    return { error: e.message, code: '' };
  }
}
const sendJson = (method, url, body, opts) =>
  api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }, opts);
const post = (url, body, opts) => sendJson('POST', url, body, opts);
const chatView = createChatView({
  cache: chatCache,
  getKey: () => renderedChatKey,
  getChatState: (key) => key ? uiState.chatState(key) : activeChatState(),
  getModels: () => modelsCache(),
  getCommands: () => commandsCache(),
  getPlatformCapabilities: () => platformCaps,
  post,
  toast,
  setAwaitingInput,
  setHeroMode,
  forkFrom,
  cancelQueuedPrompt,
  openImage: openLightbox,
  requestHistoryPage: (before, key) => api(`/api/history?limit=40&before=${before}`, undefined, {
    key, guardChat: true,
  }),
  isActiveKey: (key) => key === activeChatKey(),
  onToolEvent: taskFromTool,
});
chatView.start();
window.addEventListener('pagehide', () => chatView.dispose());
// A chat is identified by its session file path, so it has to be escaped before
// it can travel inside a URL path.
const sessionPath = (id, suffix) => `/api/sessions/${encodeURIComponent(id ?? '')}/${suffix}`;
async function forkFrom(entryId) {
  const key = activeChatKey();
  const result = await post(sessionPath(key, 'fork'), { entryId }, { key, guardChat: true, followKey: false });
  if (result.error || key !== activeChatKey()) return;
  const fork = uiState.chatState(result.key);
  fork.cwd = result.cwd ?? uiState.chatState(key).cwd;
  const ticket = navigation.transition({
    tabId: uiState.activeTabId,
    view: VIEW_CHAT,
    resourceId: result.key,
  });
  await loadOpenChat(ticket);
  toast('New chat created from this point', true);
}

// logo theme: 'brand' (provider colours) or 'mono' (monochrome) — the CSS does
// the override, so switching theme never requires a repaint of the markup
const LOGO_STYLES = [
  { id: 'brand', name: 'Provider colours' },
  { id: 'mono', name: 'Monochrome' },
];
function applyLogoStyle(id) {
  const v = LOGO_STYLES.some((s) => s.id === id) ? id : 'brand';
  document.documentElement.dataset.logo = v;
  localStorage.setItem('piLogoStyle', v);
  $$('.logoStyleCard').forEach((c) => c.classList.toggle('sel', c.dataset.l === v));
}
applyLogoStyle(localStorage.getItem('piLogoStyle') || 'brand');

/* ---------------- dropdowns ---------------- */
// model flyouts live in <body>: they must be closed along with their dropdown
function closeFlyouts() {
  document.querySelectorAll('body > .dd-flyout.on').forEach((f) => f.classList.remove('on'));
  document.querySelectorAll('.dd-sub.open').forEach((s) => s.classList.remove('open'));
}
function setupDd(ddId, btnId) {
  const dd = $(ddId);
  $(btnId).addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dd.classList.contains('open');
    closeFlyouts();
    document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
    $('usageDot')?.classList.remove('open');
    if (!open) dd.classList.add('open');
  });
  dd.querySelector('.dd-menu').addEventListener('click', (e) => e.stopPropagation());
  return dd;
}
// sidebar filters (status + period), replacing the old per-project filter: the
// project is still reachable through search or the "By project" grouping
// (declared here, before any use: setupDd/renderFilterMenu run right below)
let sessionFilter = { status: 'all', period: 'all' };
// chat archiving: when off the sidebar is a flat list and the feature
// disappears from the UI (saved statuses stay on the server)
let chatArchiving = true;
try { sessionFilter = { ...sessionFilter, ...JSON.parse(localStorage.getItem('piSessionFilter') || '{}') }; } catch {}
// sort and grouping: state lives here (the old <select>s became icon dropdowns),
// grouping keeps the same localStorage key as before. All three sidebar controls
// are remembered: a filter you have to set again at every start is not a filter.
let sessionSort = localStorage.getItem('piSortBy') || 'recent';
let sessionGroup = localStorage.getItem('piGroupBy') || 'none';
const modelDd = setupDd('modelDd', 'modelBtn');
setupDd('thinkDd', 'thinkBtn');
const cwdDd = setupDd('cwdDd', 'cwdChip');
const projectBootstrapDd = setupDd('projectBootstrapDd', 'projectBootstrapBtn');
setupDd('statsDd', 'stats');
setupDd('termsDd', 'termsChip');
const filterDd = setupDd('filterDd', 'filterBtn');
const sortDd = setupDd('sortDd', 'sortBtn');
const groupDd = setupDd('groupDd', 'groupBtn');
$('projectBootstrapBtn').addEventListener('click', () => {
  if (projectBootstrapDd.classList.contains('open')) renderProjectBootstrapMenu();
});
function renderFilterMenu() {
  $('filterMenu').querySelectorAll('[data-filter]').forEach((b) => {
    b.classList.toggle('sel', sessionFilter[b.dataset.filter] === b.dataset.val);
  });
  const statusFilterOn = sessionFilter.status !== 'all'
    && (chatArchiving || sessionFilter.status === 'favorite');
  const active = (statusFilterOn ? 1 : 0) + (sessionFilter.period !== 'all' ? 1 : 0);
  $('filterBtn').classList.toggle('on', active > 0);
  $('filterCount').classList.toggle('hide', !active);
  $('filterCount').textContent = active;
}
$('filterMenu').querySelectorAll('[data-filter]').forEach((b) => {
  b.addEventListener('click', () => {
    sessionFilter = { ...sessionFilter, [b.dataset.filter]: b.dataset.val };
    localStorage.setItem('piSessionFilter', JSON.stringify(sessionFilter));
    renderFilterMenu();
    renderSessions();
    filterDd.classList.remove('open');
    syncChatToList();
  });
});
renderFilterMenu();
// sort / group icons: selected option highlighted in the menu, icon lit up when
// the control is off its default (same "on" pattern as the filter icon)
function renderSortMenu() {
  $('sortMenu').querySelectorAll('[data-sort]').forEach((b) => {
    b.classList.toggle('sel', b.dataset.sort === sessionSort);
  });
  $('sortBtn').classList.toggle('on', sessionSort !== 'recent');
}
function renderGroupMenu() {
  $('groupMenu').querySelectorAll('[data-group]').forEach((b) => {
    b.classList.toggle('sel', b.dataset.group === sessionGroup);
  });
  $('groupBtn').classList.toggle('on', sessionGroup !== 'none');
}
$('sortMenu').querySelectorAll('[data-sort]').forEach((b) => {
  b.addEventListener('click', () => {
    sessionSort = b.dataset.sort;
    localStorage.setItem('piSortBy', sessionSort);
    renderSortMenu();
    renderSessions();
    sortDd.classList.remove('open');
    syncChatToList();
  });
});
$('groupMenu').querySelectorAll('[data-group]').forEach((b) => {
  b.addEventListener('click', () => {
    sessionGroup = b.dataset.group;
    localStorage.setItem('piGroupBy', sessionGroup);
    renderGroupMenu();
    renderSessions();
    groupDd.classList.remove('open');
    syncChatToList();
  });
});
renderSortMenu();
renderGroupMenu();
document.addEventListener('click', () => {
  closeFlyouts();
  document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
});

// Home screen: a single question naming the project, and the composer right
// below as the only thing to do. The old suggestion cards are gone: they were
// noise on top of an empty prompt.
function projectName() {
  const parts = (activeChatState().cwd || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
/* The checkout tray hangs under the composer and belongs to the new-chat screen
   only: as soon as the chat starts the folder is frozen, so showing it would be
   a lie. One class on #chatView drives both the hero layout and the tray. */
function setHeroMode(on) {
  $('chatView').classList.toggle('hero', !!on);
  if (on) renderTray();
}
function renderTray() {
  $('trayPath').textContent = activeChatState().cwd || '…';
  $('checkoutTray').title = 'Working folder of the next chat: ' + (activeChatState().cwd || '—');
  const gb = $('trayGit');
  const git = activeProjectScope()?.git;
  if (!git?.repo) { gb.classList.add('hide'); return; }
  gb.classList.remove('hide');
  $('trayBranch').textContent = git.branch;
  const n = git.changed ?? 0;
  const count = $('trayCount');
  count.textContent = n;
  count.classList.toggle('hide', !n);
}
/* The tray is a second trigger for the folder menu that lives in the header.
   stopPropagation is not optional: the synthetic click on #cwdChip stops only
   itself, while this one would keep bubbling to the document listener that
   closes every open dropdown — the menu would shut in the same tick it opens. */
$('checkoutTray').addEventListener('click', (e) => {
  e.stopPropagation();
  $('cwdChip').click();
});
const EMPTY_CHAT_USAGE = { tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 0 };
function usageDetail(usage) {
  return `input ${fmt(usage.input)} · output ${fmt(usage.output)} · cache read ${fmt(usage.cacheRead)} · cache write ${fmt(usage.cacheWrite)}`;
}
function contextPercent(context) {
  return context?.percent === null || context?.percent === undefined ? null : Math.min(100, context.percent);
}
function renderStats(chatState = activeChatState()) {
  const metrics = chatState.metrics;
  const c = metrics?.total ?? EMPTY_CHAT_USAGE;
  const context = metrics?.context;
  const pct = contextPercent(context);
  const pctLabel = pct === null ? '?' : `${pct.toFixed(0)}%`;
  const contextTokens = context?.tokens === null || context?.tokens === undefined ? '?' : fmt(context.tokens);
  $('stats').textContent = `${contextTokens} context · ${pctLabel} · ${money(c.cost)}`;
  $('stats').title =
    `current context: ${contextTokens}${context?.contextWindow > 0 ? ` / ${fmt(context.contextWindow)}` : ''} tokens (${pctLabel})\n` +
    `cumulative tokens processed: ${fmt(c.tokens)}\n` +
    `${usageDetail(c)}\n` +
    `requests: ${c.requests} · estimated cost: ${money(c.cost)}\n` +
    `click for the per-model breakdown`;
  renderStatsMenu(c, metrics?.byModel, metrics?.sessionWork);
  if (context?.contextWindow > 0 && pct !== null) {
    $('ctxFill').style.width = pct + '%';
    $('ctxFill').className = pct > 85 ? 'crit' : pct > 60 ? 'warn' : '';
    $('ctxBar').title = `context: ${fmt(context.tokens)} / ${fmt(context.contextWindow)} tokens (${context.percent.toFixed(1)}%)`;
  } else {
    $('ctxFill').style.width = '0%';
    $('ctxFill').className = '';
    $('ctxBar').title = context?.contextWindow > 0
      ? `context: ? / ${fmt(context.contextWindow)} tokens (?)`
      : 'context unavailable';
  }
}
// Counter popover: one row per model plus SDK work that has no model identity.
function renderStatsMenu(c, byModel, sessionWork) {
  const rows = Object.entries(byModel ?? {}).sort((a, b) => b[1].cost - a[1].cost);
  let html = '<div class="dd-group">Cumulative processed tokens and cost, per model</div>';
  if (!rows.length && !sessionWork) html += '<div class="sys" style="padding:.4rem .55rem">no answer yet</div>';
  for (const [key, m] of rows) {
    const slash = key.indexOf('/');
    const p = slash > 0 ? key.slice(0, slash) : '';
    const id = slash > 0 ? key.slice(slash + 1) : key;
    html += `<div class="statsRow" title="${esc(usageDetail(m))}">${providerIconHtml(p, id)}<span class="nm" title="${esc(key)}">${esc(id)}</span>
      <span class="vals">${fmt(m.tokens)} tok · <b>${money(m.cost)}</b> · ${m.requests} req</span></div>`;
  }
  if (sessionWork) {
    html += `<div class="statsRow" title="${esc(usageDetail(sessionWork))}"><span class="nm">Session work</span>
      <span class="vals">${fmt(sessionWork.tokens)} tok · <b>${money(sessionWork.cost)}</b> · ${sessionWork.requests} req</span></div>`;
  }
  if (rows.length || sessionWork) {
    html += `<div class="statsRow total" title="${esc(usageDetail(c))}"><span class="nm">Cumulative usage</span>
      <span class="vals">${fmt(c.tokens)} tok · <b>${money(c.cost)}</b> · ${c.requests} req</span></div>`;
  }
  $('statsMenu').innerHTML = html;
}
function applyQueueChange(items, key = activeChatKey()) {
  if (!key) return [];
  const queue = uiState.applyQueuedPrompts(key, items);
  if (key === activeChatKey() && key === renderedChatKey) chatView.renderQueuedPrompts(queue);
  return queue;
}
function handleQueueEvent(ev, key) {
  const owner = uiState.chatState(key);
  const previous = owner.queuedPrompts;
  if (ev.action === 'dispatch' && key === activeChatKey() && key === renderedChatKey) {
    chatView.dispatchQueuedPrompts(ev.ids ?? [], previous, owner);
  }
  applyQueueChange(ev.queued ?? [], key);
}
async function cancelQueuedPrompt(id) {
  const key = activeChatKey();
  if (!key) return;
  const r = await sendJson('DELETE', `/api/queued-prompts/${encodeURIComponent(id)}`, undefined, {
    key, guardChat: true, followKey: false,
  });
  if (r.error || key !== activeChatKey()) return;
  applyQueueChange(activeChatState().queuedPrompts.filter((item) => item.id !== id), key);
}
function renderComposerState(chatState = activeChatState()) {
  const running = chatState.streaming;
  // The streaming flag may be refreshed independently while the agent is
  // still alive. The task closes only on agent_end, so it owns this indicator.
  const activityRunning = !!chatState.agentTask && !chatState.agentTask.t1;
  // While a form awaits input the agent is idle: pause the activity UI.
  const modelActive = activityRunning && !chatState.awaitingInput;
  $('runState').classList.toggle('on', modelActive);
  $('sendBtn').classList.toggle('hide', running);
  $('queueActions').classList.toggle('hide', !running);
  // The activity timer covers the whole agent run, not only the wait for the
  // first text token. agent_end is the authoritative point at which it stops.
  $('responseSpinner').classList.toggle('hide', !modelActive);
  if (modelActive) renderResponseActivity(chatState);
  input.placeholder = chatState.awaitingInput
    ? 'Complete the form above to continue…'
    : running
    ? 'Scrivi una nuova istruzione mentre l’agente lavora…'
    : 'Ask me anything…  (drop files and images here)';
}
function setAwaitingInput(on, key = activeChatKey() ?? renderedChatKey) {
  const state = key ? uiState.chatState(key) : activeChatState();
  state.awaitingInput = on;
  if (key === activeChatKey() || (!key && !activeChatKey())) renderComposerState(state);
  setAgentTask(!on && state.streaming, state.turnModel, key);
}
const RESPONSE_ACTIVITY_WORDS = ['Thinking', 'Building', 'Cooking', 'Crafting', 'Working', 'Exploring', 'Solving'];
function responseDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
function renderResponseActivity(chatState = activeChatState()) {
  if (!chatState.responseActivityLabel) {
    chatState.responseActivityLabel = RESPONSE_ACTIVITY_WORDS[Math.floor(Math.random() * RESPONSE_ACTIVITY_WORDS.length)];
  }
  if (!chatState.responseStartedAt) chatState.responseStartedAt = Date.now();
  $('responseActivityLabel').textContent = chatState.responseActivityLabel;
  $('responseElapsed').textContent = responseDuration(Date.now() - chatState.responseStartedAt);
  $('responseSpinner').setAttribute('aria-label', `${chatState.responseActivityLabel}, ${$('responseElapsed').textContent}`);
}
setInterval(() => {
  const state = activeChatState();
  if (state.awaitingInput) return;
  if (state.agentTask && !state.agentTask.t1) renderResponseActivity(state);
}, 1000);
function setRunning(on, { newResponse = false } = {}) {
  const key = activeChatKey() ?? renderedChatKey;
  const state = activeChatState();
  if (on) {
    if (key && (newResponse || !state.streaming)) uiState.startResponse(key);
    else state.streaming = true;
  } else if (key) {
    uiState.finishResponse(key);
  } else {
    state.streaming = false;
    state.responsePhase = RESPONSE_IDLE;
    state.responseStartedAt = null;
    state.responseActivityLabel = null;
  }
  renderComposerState(state);
  if (!on) chatView.clearSegments();
}
function markResponseText() {
  const key = activeChatKey() ?? renderedChatKey;
  if (key) uiState.markResponseText(key);
  else activeChatState().responsePhase = RESPONSE_TEXT;
  renderComposerState();
}
/* ---------------- account usage widget (real limits, dynamic on active provider) ---------------- */
function fmtCountdown(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return 'resets shortly';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const d = Math.floor(h / 24);
  if (d > 0) return `resets in ${d}d ${h % 24}h`;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}
// One row of the usage popover. `pct` drives both the bar and the colour, which
// follows the provider's own severity when it sends one.
function usageWindowLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'Window';
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${Math.round(value)}s`;
}
function usageRow(name, pct, severity, resetsAt) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const cls = severity === 'critical' || p > 90 ? 'crit' : severity === 'warning' || p > 70 ? 'warn' : '';
  const rs = resetsAt ? fmtCountdown(resetsAt).replace('resets in ', '').replace('resets shortly', 'now') : '';
  return `<div class="uRow ${cls}"><span class="nm" title="${esc(name)}">${esc(name)}</span>
    <span class="bar"><i style="width:${p}%"></i></span>
    <span class="v">${Math.round(p)}%</span><span class="rs">${esc(rs)}</span></div>`;
}
// The ring itself always shows the short rolling window: that is the limit that
// actually stops you mid-session.
function setUsageDot(pct, severity, isError, isDisabled = false) {
  const dot = $('usageDot');
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const C = 43.98; // 2*pi*r with r=7
  $('usageDotFill').setAttribute('stroke-dashoffset', String(C * (1 - p / 100)));
  dot.classList.remove('warn', 'crit', 'err', 'disabled');
  if (isDisabled) dot.classList.add('disabled');
  else if (isError) dot.classList.add('err');
  else if (severity === 'critical' || p > 90) dot.classList.add('crit');
  else if (severity === 'warning' || p > 70) dot.classList.add('warn');
}
let usageCache = null;
async function refreshUsage(force) {
  usageCache = await api('/api/usage' + (force ? '?force=1' : ''));
  renderUsageWidget();
}
// Context and chat cost, shown in the popover footer instead of above the input.
function renderUsageWidget() {
  const dot = $('usageDot'), pop = $('usagePop');
  const u = usageCache;
  const chatState = activeChatState();
  const provider = chatState.model?.provider;
  if (!u || u.error || !provider) { dot.classList.remove('show'); return; }

  const foot = () => {
    const metrics = chatState.metrics;
    const cost = metrics?.total.cost ? `${fmt(metrics.total.tokens)} tok · ${money(metrics.total.cost)}` : '';
    const pct = contextPercent(metrics?.context);
    const ctx = metrics?.context ? `context ${pct === null ? '?' : `${pct.toFixed(0)}%`}` : '';
    return ctx || cost ? `<div class="foot"><span>${esc(ctx)}</span><span>${esc(cost)}</span></div>` : '';
  };

  if (provider === 'openai-codex') {
    const refreshControl = '<button type="button" class="usageRefresh" data-usage-refresh>Refresh now</button>';
    dot.classList.add('show');
    const openai = u.openai;
    if (!openai?.enabled) {
      setUsageDot(0, null, false, true);
      pop.innerHTML = '<div class="h">OpenAI Codex account usage</div><div class="note">Disabled in Settings</div>';
      dot.title = 'OpenAI Codex account usage is disabled';
      return;
    }
    if (openai.error || !openai.configured) {
      setUsageDot(100, null, true);
      pop.innerHTML = `<div class="h">OpenAI Codex account usage</div><div class="err">${esc(openai.error || 'OAuth unavailable')}</div>${foot()}${refreshControl}`;
      dot.title = openai.error || 'OpenAI Codex OAuth unavailable';
      return;
    }
    const windows = openai.windows ?? [];
    const primary = windows[0];
    setUsageDot(primary?.usedPercent ?? 0);
    const rows = windows.length
      ? windows.map((window) => usageRow(
          usageWindowLabel(window.durationSeconds),
          window.usedPercent,
          null,
          window.resetsAt,
        )).join('')
      : '<div class="err">data unavailable</div>';
    pop.innerHTML = `<div class="h">OpenAI Codex account usage</div>${rows}${foot()}${refreshControl}`;
    dot.title = `OpenAI Codex ${usageWindowLabel(primary?.durationSeconds)}: ${Math.round(primary?.usedPercent ?? 0)}%, click for the breakdown`;
    return;
  }

  if (provider === 'anthropic' && u.anthropic?.configured) {
    dot.classList.add('show');
    if (u.anthropic.error) {
      setUsageDot(100, null, true);
      pop.innerHTML = `<div class="h">Claude</div><div class="err">${esc(u.anthropic.error)}</div>`;
      dot.title = u.anthropic.error;
      return;
    }
    // limits[] is exactly what claude.ai renders: the 5h session, the overall
    // weekly cap, and a weekly cap scoped to one model (its display name comes
    // from the API, so it follows Anthropic's naming instead of ours).
    const limits = u.anthropic.limits ?? [];
    const NAMES = { session: '5 hours', weekly_all: 'Week', weekly_scoped: 'Week' };
    const session = limits.find((l) => l.kind === 'session');
    const fh = session ?? { percent: u.anthropic.fiveHour?.percent, resetsAt: u.anthropic.fiveHour?.resetsAt };
    setUsageDot(fh?.percent, session?.severity);
    const rows = limits.length
      ? limits.map((l) => usageRow(l.label || NAMES[l.kind] || l.kind, l.percent, l.severity, l.resetsAt)).join('')
      : usageRow('5 hours', u.anthropic.fiveHour?.percent, null, u.anthropic.fiveHour?.resetsAt)
        + (u.anthropic.sevenDay ? usageRow('Week', u.anthropic.sevenDay.percent, null, u.anthropic.sevenDay.resetsAt) : '');
    pop.innerHTML = `<div class="h">Claude — account usage</div>${rows}${foot()}`;
    dot.title = `Claude — 5h: ${Math.round(fh?.percent ?? 0)}% · click for the breakdown`;
    return;
  }

  if (provider === 'kimi-coding' && u.kimi?.configured) {
    dot.classList.add('show');
    if (u.kimi.error) {
      setUsageDot(100, null, true);
      pop.innerHTML = `<div class="h">Kimi</div><div class="err">${esc(u.kimi.error)}</div>`;
      dot.title = u.kimi.error;
      return;
    }
    const coding = u.kimi.usages?.find((x) => x.scope === 'FEATURE_CODING') ?? u.kimi.usages?.[0];
    const win5h = coding?.windows?.find((x) => x.durationMinutes === 300) ?? coding?.windows?.[0];
    const period = coding?.period;
    const winPct = win5h?.limit ? 100 * win5h.used / win5h.limit : null;
    const periodPct = period?.limit ? 100 * period.used / period.limit : null;
    setUsageDot(winPct ?? periodPct ?? 0);
    let rows = '';
    if (win5h) rows += usageRow('5 hours', winPct ?? 0, null, win5h.resetsAt);
    if (period) rows += usageRow('Period', periodPct ?? 0, null, period.resetsAt);
    if (!rows) rows = '<div class="err">data unavailable</div>';
    pop.innerHTML = `<div class="h">Kimi — account usage</div>${rows}${foot()}`;
    dot.title = `Kimi — 5h: ${Math.round(winPct ?? 0)}% · click for the breakdown`;
    return;
  }

  dot.classList.remove('show');
}
// the popover is opt-in: the bar stays a single dot until you click it
$('usageDot').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('usageDot').classList.contains('open');
  document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
  $('usageDot').classList.toggle('open', !open);
  if (!open) renderUsageWidget();
});
$('usagePop').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.closest('[data-usage-refresh]')) refreshUsage(true);
});
document.addEventListener('click', () => $('usageDot').classList.remove('open'));

/* ---------------- SSE (with reconnect + refresh fallback) ---------------- */
function connect(key = activeChatKey()) {
  transport.followDetailed(key, {
    onOpen: () => { $('conn').classList.remove('off'); $('connTxt').textContent = 'connected'; },
    onError: () => { $('conn').classList.add('off'); $('connTxt').textContent = 'reconnecting…'; },
    onEvent: (ev, owner) => {
      try { handleEvent(ev, owner.sessionKey); } catch (err) { console.error(err); toast('UI: ' + err.message); }
    },
  });
}
window.addEventListener('pagehide', () => transport.closeDetailed());
function handleEvent(ev, ownerKey) {
  // global events are broadcast on every detailed stream and identify their
  // own chat. They may update badges, never the active chat body.
  if (ev.scope === 'global') {
    if (ev.kind === 'running') {
      // "finished" only means something for a chat we had seen working. An end
      // of run for a key we never saw start (a context re-keyed mid-turn, a
      // window on another chat, a leftover from before this page loaded) is
      // noise, and it used to pop up as a toast out of nowhere.
      const wasRunning = runningKeys.has(ev.key);
      if (ev.running) runningKeys.add(ev.key); else runningKeys.delete(ev.key);
      if (ev.key !== activeChatKey()) {
        updateSessionRunningState(ev.key, ev.running);
        if (!ev.running && wasRunning) toast('Chat finished: ' + chatLabel(ev.key), true, {
          actionLabel: 'Open chat',
          onAction: () => openChatNotification(ev.key),
        });
      }
    } else if (ev.kind === 'sessions') {
      loadSessions();
    } else if (ev.kind === 'terminals') {
      terminalView.load();   // a terminal was created, died or was closed (here or elsewhere)
    }
    return;
  }
  // A closing EventSource can still have a queued message. The stream owner
  // and the event key both have to match the selected chat before touching it.
  if (ownerKey !== activeChatKey()) return;
  if (ev.kind !== 'rekey' && ev.kind !== 'attached' && ev.key && ev.key !== ownerKey) return;
  switch (ev.kind) {
    case 'attached':
      if (ev.key !== ownerKey) {
        parkChatView(ownerKey);
        uiState.rekeyChat(ownerKey, ev.key);
        if (runningKeys.delete(ownerKey)) runningKeys.add(ev.key);
        transport.rekeyDetailed(ownerKey, ev.key);
        showChatResource(ev.key, { reconnect: false, park: false });
      } else {
        showChatResource(ev.key, { reconnect: false });
      }
      applyQueueChange(ev.queuedPrompts ?? [], activeChatKey());
      setRunning(!!ev.running);
      setAwaitingInput(!!ev.awaitingInput, activeChatKey());
      if (ev.running && !activeChatState().agentTask) setAgentTask(true, activeChatState().turnModel, activeChatKey());
      break;
    case 'queue':
      handleQueueEvent(ev, ownerKey);
      break;
    case 'text':
      markResponseText();
      chatView.applyStreamEvent(ev, activeChatState());
      break;
    case 'thinking':
      chatView.applyStreamEvent(ev, activeChatState());
      break;
    case 'tool':
      chatView.applyStreamEvent(ev, activeChatState());
      taskFromTool(ev, ownerKey);
      break;
    case 'message-meta':
      chatView.applyStreamEvent(ev, activeChatState());
      break;
    case 'usage':
      uiState.applyMetricsPayload(ownerKey, ev.metrics);
      renderStats();
      break;
    case 'status':
      if (ev.status === 'running') {
        setChatStarted(true);  // it is running ⇒ the chat exists
        if (ev.model) activeChatState().turnModel = ev.model;  // model answering right now (it can change mid-chat)
        setAgentTask(true, ev.model, ownerKey);
      } else {
        chatView.finalizeStreamingMarkdown();
        const state = activeChatState();
        if (state.pendingAssistantMeta && state.responseStartedAt) {
          state.pendingAssistantMeta.durationMs = Date.now() - state.responseStartedAt;
        }
        chatView.flushAssistantMeta(state);
        state.turnModel = null;
        setAgentTask(false, null, ownerKey);
        refreshGit({ force: true }); // the visible agent may have changed Git
      }
      setRunning(ev.status === 'running', { newResponse: ev.status === 'running' }); break;
    case 'rekey': {
      // The draft became a persisted session, but remains the same chat. Park
      // its live DOM/composer first, then move the whole cache entry atomically.
      const old = ownerKey;
      parkChatView(old);
      uiState.rekeyChat(old, ev.key);
      if (runningKeys.delete(old)) runningKeys.add(ev.key);
      transport.rekeyDetailed(old, ev.key);
      showChatResource(ev.key, { reconnect: false, park: false });
      applyQueueChange(ev.queuedPrompts ?? [], ev.key);
      renderSessions();          // the row can finally be marked as the active one
      break;
    }
    case 'cwd':
      activeChatState().cwd = ev.path;
      renderContextHeader();
      refreshAll(); break;
    case 'file': loadFiles(); break;
    case 'error':
      // Errors can be recoverable (for example an automatic retry). Keep the
      // timer tied to agent_end instead of making an error event look terminal.
      chatView.applyStreamEvent(ev, activeChatState());
      toast(ev.message);
      break;
  }
}

/* ---------------- models + dynamic effort ---------------- */
let modelsLoaded = false;
let modelsLoading = null;
const modelsCache = () => uiState.global.models;
async function loadModels({ force = false } = {}) {
  if (!force && modelsLoaded) return uiState.global.models;
  if (!force && modelsLoading) return modelsLoading;
  const loading = (async () => {
    const raw = await api('/api/models', undefined, { key: null, followKey: false });
    if (raw.error) return null;
    const res = uiState.applyModelsPayload(raw);
    modelsLoaded = true;
    renderModelBtn(); renderModelMenu(); renderThinking();
    return res.models;
  })();
  modelsLoading = loading;
  try { return await loading; }
  finally { if (modelsLoading === loading) modelsLoading = null; }
}
const modelMeta = () => activeChatState().model ? modelsCache().find((m) => m.provider === activeChatState().model.provider && m.id === activeChatState().model.id) : null;
function renderModelBtn() {
  const m = activeChatState().model;
  $('modelLogo').outerHTML = m
    ? providerIconHtml(m.provider, m.id).replace('class="logo"', 'id="modelLogo" class="logo"')
    : '<span class="logo" id="modelLogo"></span>';
  $('modelName').textContent = m ? (modelMeta()?.name || m.id) : 'no model';
  $('modelBtn').title = m ? `${m.provider}/${m.id}` : 'no authenticated model';
}
async function selectModel(provider, id) {
  const key = activeChatKey();
  const r = await post('/api/model', { provider, id }, { key, guardChat: true });
  if (r.error || key !== activeChatKey()) return;
  activeChatState().model = { provider, id };
  activeChatState().thinking = r.thinkingLevel ?? activeChatState().thinking;
  activeChatState().thinkingLevels = r.thinkingLevels?.length ? r.thinkingLevels : ['off'];
  renderModelBtn(); renderModelMenu(); renderThinking(); renderUsageWidget();
  // The SDK recomputes context window and percentage for the selected model.
  if (r.metrics) uiState.applyMetricsPayload(key, r.metrics);
  renderStats();
  if (!$('settingsView').classList.contains('hide')) settingsController.show();
  toast(`Model: ${id}`, true);
}
// MOD+M: cycle through the available/authenticated models
async function cycleModel() {
  const models = modelsCache();
  if (!models.length) { toast('No model available'); return; }
  let idx = models.findIndex((m) => activeChatState().model && m.provider === activeChatState().model.provider && m.id === activeChatState().model.id);
  idx = (idx + 1) % models.length;
  const m = models[idx];
  await selectModel(m.provider, m.id);
}
// Two-level menu: providers first, models show up in a side flyout on hover
// (or on click/keyboard, for accessibility).
function renderModelMenu() {
  const menu = $('modelMenu');
  menu.innerHTML = '';
  document.querySelectorAll('body > .dd-flyout').forEach((f) => f.remove());  // flyouts of the previous render
  const models = modelsCache();
  if (!models.length) { menu.innerHTML = '<div class="dd-group">no active model</div>'; return; }
  const byProv = {};
  for (const m of models) (byProv[m.provider] ??= []).push(m);
  let closeTimer = null;
  // Flyouts live in <body>, not inside the header: the header has
  // backdrop-filter and would become the containing block of position:fixed
  // children, throwing the coordinates off. In the body they really are
  // window coordinates.
  const closeAllSubs = () => {
    menu.querySelectorAll('.dd-sub.open').forEach((s) => s.classList.remove('open'));
    document.querySelectorAll('.dd-flyout.on').forEach((f) => f.classList.remove('on'));
  };
  const openSub = (sub) => {
    clearTimeout(closeTimer);
    closeAllSubs();
    sub.classList.add('open');
    const fly = sub._fly;
    fly.classList.add('on');
    const menuBox = menu.getBoundingClientRect();
    const headBox = sub.getBoundingClientRect();
    fly.style.left = '0px'; fly.style.top = '0px';       // measure at a known position
    const w = fly.offsetWidth, h = fly.offsetHeight;
    // Keep a hairline gap between the two independently rounded panels.
    const flyoutGap = 3;
    const flip = menuBox.right + flyoutGap + w > window.innerWidth - 8;
    fly.classList.toggle('flip', flip);
    fly.style.left = (flip ? Math.max(8, menuBox.left - flyoutGap - w) : menuBox.right + flyoutGap) + 'px';
    fly.style.top = Math.max(8, Math.min(headBox.top - 5, window.innerHeight - 8 - h)) + 'px';
  };
  const closeSub = (sub) => { sub.classList.remove('open'); sub._fly.classList.remove('on'); };
  for (const [prov, list] of Object.entries(byProv)) {
    const hasSel = activeChatState().model && activeChatState().model.provider === prov;
    // `_fly` below is an expando: the flyout lives in <body>, not inside the
    // sub-menu, so the pairing has to be carried on the node itself.
    const sub = /** @type {any} */ (document.createElement('div'));
    sub.className = 'dd-sub';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dd-item' + (hasSel ? ' hasSel' : '');
    head.innerHTML = `${providerIconHtml(prov, hasSel ? activeChatState().model.id : list[0]?.id ?? '')}<span class="col">
      <span>${esc(prov)}</span>
      <span class="desc">${list.length} model${list.length === 1 ? '' : 's'}${hasSel ? ' · in use' : ''}</span></span>
      <svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;
    const fly = document.createElement('div');
    fly.className = 'dd-flyout';
    for (const m of list) {
      const sel = activeChatState().model && activeChatState().model.provider === m.provider && activeChatState().model.id === m.id;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-item' + (sel ? ' sel' : '');
      b.innerHTML = `${providerIconHtml(m.provider, m.id)}<span class="col">
        <span>${esc(m.name || m.id)}</span>
        <span class="desc">${esc(m.id)}${m.reasoning ? ' · reasoning' : ''}</span></span>
        ${m.contextWindow ? `<span class="sub">${fmt(m.contextWindow)}</span>` : ''}`;
      b.addEventListener('click', () => { closeFlyouts(); modelDd.classList.remove('open'); selectModel(m.provider, m.id); });
      fly.appendChild(b);
    }
    sub.appendChild(head);
    document.body.appendChild(fly);
    sub._fly = fly;
    const later = () => { closeTimer = setTimeout(() => closeSub(sub), 200); };
    sub.addEventListener('mouseenter', () => openSub(sub));
    sub.addEventListener('mouseleave', later);
    fly.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    fly.addEventListener('mouseleave', later);
    fly.addEventListener('click', (e) => e.stopPropagation());
    head.addEventListener('click', (e) => { e.stopPropagation(); sub.classList.contains('open') ? closeSub(sub) : openSub(sub); });
    head.addEventListener('focus', () => openSub(sub));
    menu.appendChild(sub);
  }
}
const THINK_LABEL = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const THINK_DESC = { off: 'No extended reasoning', low: 'Short reasoning', medium: 'Moderate reasoning', high: 'Deep reasoning', xhigh: 'Very deep reasoning', max: 'Maximum reasoning budget' };
function renderThinking() {
  const levels = activeChatState().thinkingLevels?.length ? activeChatState().thinkingLevels : ['off'];
  if (!levels.includes(activeChatState().thinking)) activeChatState().thinking = levels[0];
  const range = $('thinkRange');
  const stops = $('thinkStops');
  const preview = (index) => {
    const level = levels[index] ?? levels[0];
    const ratio = levels.length > 1 ? index / (levels.length - 1) : 0;
    const accent = ratio < .5
      ? `color-mix(in srgb, var(--teal) ${Math.round(34 + ratio * 108)}%, var(--panel-3))`
      : `color-mix(in srgb, var(--teal) ${Math.round(100 - (ratio - .5) * 42)}%, var(--txt))`;
    $('thinkMenu').style.setProperty('--effort-accent', accent);
    $('thinkPicker').style.setProperty('--effort-accent', accent);
    $('thinkPicker').style.setProperty('--effort-progress', `${ratio * 100}%`);
    $('thinkSwatch').style.setProperty('--effort-accent', accent);
    $('thinkName').textContent = THINK_LABEL[level] ?? level;
    $('thinkPreviewName').textContent = THINK_LABEL[level] ?? level;
    $('thinkReadout').textContent = THINK_DESC[level] ?? 'Reasoning effort';
    [...stops.children].forEach((stop, stopIndex) => stop.classList.toggle('passed', stopIndex <= index));
  };
  range.min = '0';
  range.max = String(Math.max(0, levels.length - 1));
  range.value = String(levels.indexOf(activeChatState().thinking));
  range.disabled = levels.length === 1;
  stops.replaceChildren(...levels.map(() => {
    const stop = document.createElement('span');
    return stop;
  }));
  preview(Number(range.value));
  $('thinkBtn').title = `${THINK_LABEL[activeChatState().thinking] ?? activeChatState().thinking}: ${THINK_DESC[activeChatState().thinking] ?? 'Reasoning effort'}`;
  range.oninput = () => preview(Number(range.value));
  range.onchange = async () => {
    const level = levels[Number(range.value)] ?? levels[0];
    preview(Number(range.value));
    range.disabled = true;
    const key = activeChatKey();
    const r = await post('/api/thinking', { level }, { key, guardChat: true });
    if (key !== activeChatKey()) return;
    if (!r.error) activeChatState().thinking = r.thinkingLevel ?? level;
    renderThinking();
  };
}
$('thinkRange').addEventListener('wheel', (event) => {
  const range = $('thinkRange');
  if (range.disabled || !event.deltaY) return;
  event.preventDefault();
  const next = Math.max(Number(range.min), Math.min(Number(range.max), Number(range.value) + Math.sign(event.deltaY)));
  if (next === Number(range.value)) return;
  range.value = String(next);
  range.dispatchEvent(new Event('input', { bubbles: true }));
  range.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });
// MOD+E: cycle through the reasoning effort levels of the current model
async function cycleThinking() {
  const levels = activeChatState().thinkingLevels?.length ? activeChatState().thinkingLevels : ['off'];
  if (levels.length <= 1) { toast('No other effort level available for this model'); return; }
  let idx = levels.indexOf(activeChatState().thinking);
  idx = (idx + 1) % levels.length;
  const lv = levels[idx];
  const key = activeChatKey();
  const r = await post('/api/thinking', { level: lv }, { key, guardChat: true });
  if (r.error || key !== activeChatKey()) return;
  activeChatState().thinking = r.thinkingLevel ?? lv;
  renderThinking();
  toast(`Effort: ${activeChatState().thinking}`, true);
}

/* ---------------- working directory ---------------- */
/* An "empty" chat does not exist: it is just the home screen. Once its first
   prompt starts, folder mutability is permanently owned by that chat state. */
function setChatStarted(value, key = activeChatKey()) {
  if (!key) return;
  uiState.chatState(key).started = Boolean(value);
  if (key === activeChatKey()) renderContextHeader();
}
async function changeCwd(p) {
  const owner = activeChatState();
  if (owner.started) { toast('This chat has already started: the folder cannot be changed.'); return; }
  const key = activeChatKey();
  p = (p ?? $('cwdInput').value).trim().replace(/^["']|["']$/g, '');
  if (!p) return;
  $('cwdMsg').textContent = 'setting…';
  const r = await post('/api/cwd', { path: p }, { key, guardChat: true, followKey: false });
  if (key === activeChatKey()) $('cwdMsg').textContent = '';
  if (r.error || key !== activeChatKey()) return; // toast already shown, chat untouched
  cwdDd.classList.remove('open');
  // changing folder means another chat: the server answers with the key of the
  // context that owns it, and the tab has to follow it (staying on the old
  // draft would send every later request to the previous folder)
  const target = uiState.chatState(r.key);
  target.cwd = r.cwd ?? p;
  const project = activeProjectCwd();
  let tabId = uiState.activeTabId;
  if (project && !sameCwd(project, target.cwd)) tabId = projectTabId(null);
  const ticket = navigation.transition({ tabId, view: VIEW_CHAT, resourceId: target.key });
  await refreshAll({ key: target.key, ticket });
  loadRecentCwds();
  if (navigation.isCurrent(ticket)) toast('Folder set: the chat will start in ' + target.cwd, true);
}
$('cwdApply').addEventListener('click', () => changeCwd());
$('cwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); changeCwd(); } });
$('browseBtn').addEventListener('click', async () => {
  const btn = $('browseBtn');
  btn.disabled = true;
  try {
    // closing the dialog answers 409 `cancelled`: a choice, not a failure, so
    // it stays silent instead of raising a toast
    const d = await api('/api/pick-folder', { method: 'POST' }, {
      quiet: ['cancelled'], key: activeChatKey(), guardChat: true, followKey: false,
    });
    if (d.error) return;
    if (d.path) await changeCwd(d.path);
  } finally { btn.disabled = false; }
});
// opens the working folder in the system file manager (changes neither chat nor folder)
$('explorerBtn').addEventListener('click', async () => {
  const key = activeChatKey();
  if (!key) return;
  const r = await post('/api/open-explorer', {}, { key, guardChat: true });
  if (!r.error && key === activeChatKey()) cwdDd.classList.remove('open');
});
// The native features do not exist everywhere (no picker without zenity
// on Linux, and so on): the server says what it can do and we hide the rest, so
// no button promises something that would end in an error.
let platformCaps = null;
function applyPlatformCapabilities(caps) {
  if (!caps) return;
  platformCaps = caps;
  renderContextHeader();
  // without a native picker the text field is the only way to choose the folder
  if (!caps.pickFolder) $('cwdInput').placeholder = 'Paste the folder path here';
}

/* ---- recent folders: expandable section inside the folder menu ---- */
let recentCwds = [];
async function loadRecentCwds() {
  const r = await api('/api/recent-cwds');
  if (r.error) return;
  recentCwds = r.recent ?? [];
  renderRecentCwds();
}
function renderRecentCwds() {
  const list = $('recentList');
  $('recentCount').textContent = recentCwds.length || '';
  list.innerHTML = '';
  if (!recentCwds.length) { list.innerHTML = '<div class="sys" style="padding:.35rem .4rem">No recent folder</div>'; return; }
  for (const p of recentCwds) {
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    const cur = activeChatState().cwd && p.toLowerCase() === activeChatState().cwd.toLowerCase();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recentItem' + (cur ? ' cur' : '');
    b.title = p;
    b.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span class="nm">${esc(name)}</span><span class="pth">${esc(p)}</span>`;
    const del = document.createElement('span');
    del.className = 'del'; del.textContent = '×'; del.title = 'Forget this folder';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await api('/api/recent-cwds?path=' + encodeURIComponent(p), { method: 'DELETE' });
      // The server owns this list: if the DELETE failed (api() already toasted),
      // dropping the row here would show a removal that did not happen.
      if (r.error) return;
      recentCwds = r.recent ?? recentCwds.filter((x) => x !== p);
      renderRecentCwds();
    });
    b.appendChild(del);
    b.addEventListener('click', () => { if (!cur) changeCwd(p); });
    list.appendChild(b);
  }
}
$('recentHead').addEventListener('click', () => {
  const box = $('recentBox');
  box.classList.toggle('open');
  localStorage.setItem('piRecentOpen', box.classList.contains('open') ? '1' : '0');
});
if (localStorage.getItem('piRecentOpen') !== '0') $('recentBox').classList.add('open');

/* ---- π logo: always opens a new chat ---- */
$('homeBtn').addEventListener('click', () => {
  showChat();
  if (window.matchMedia('(max-width: 768px)').matches) setSidebarCollapsed(true);
  newChat();
});

/* ---- mouse-resizable sidebar (persisted width) ---- */
const SB_MIN = 190, SB_MAX = 460;
function setSidebarWidth(px) {
  const w = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--sbw', w + 'px');
  localStorage.setItem('piSidebarW', String(w));
}
setSidebarWidth(Number(localStorage.getItem('piSidebarW')) || 230);
$('sidebarResize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX, startW = $('sidebar').getBoundingClientRect().width;
  document.body.classList.add('sb-resizing');
  const move = (ev) => setSidebarWidth(startW + (ev.clientX - startX));
  const up = () => {
    document.body.classList.remove('sb-resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
// double click on the handle: back to the default width
$('sidebarResize').addEventListener('dblclick', () => setSidebarWidth(230));

/* ---------------- sessions ---------------- */
let allSessions = [];
const runningKeys = new Set();   // chats currently working (also in other tabs)
// Chat lists sort on `modified`, an ISO string: parsed once and compared as a
// number, which is what subtracting two Dates was already doing.
const modifiedAt = (s) => new Date(s.modified).getTime();
// How a chat is named everywhere: the server's summary first, then the payload's
// own fallbacks. `title` used to be missing here and there, which is how a toast
// ended up shouting a whole first message across the screen.
const sessionLabel = (s) => s?.title || s?.name || s?.firstMessage || '';
// The same name, cut to notification size: one line, never a transcript.
function chatLabel(key, max = 70) {
  const raw = sessionLabel(sessionForKey(key)).replace(/\s+/g, ' ').trim();
  if (!raw) return '(background chat)';
  return raw.length > max ? raw.slice(0, max - 1).trimEnd() + '\u2026' : raw;
}
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}
let sessionsLoading = null;
async function loadSessions() {
  if (sessionsLoading) return sessionsLoading;
  const loading = (async () => {
    // no per-project filter any more: the sidebar always shows every chat,
    // "By project" grouping plus search are enough to find your way
    const raw = await api('/api/sessions?scope=all', undefined, { key: null, followKey: false });
    if (raw.error) return;
    const res = uiState.applySessionsPayload(raw);
    allSessions = res.sessions;
    if (!uiState.selection) selectCurrentChatState(renderedChatKey ?? res.current);
    runningKeys.clear();
    for (const k of res.running ?? []) runningKeys.add(k);
    renderSessions();
    renderProjTabs();
    if (!uiState.selection) {
      const tabId = uiState.activeTabId;
      const ticket = navigation.switchTab(tabId, fallbackSelectionForTab);
      if (!ticket.selection) await newChat({ tabId, ticket });
      else if (ticket.selection.view === VIEW_CHAT) {
        // Do not await a synchronization that includes this in-flight listing.
        loadOpenChat(ticket);
      }
    }
  })();
  sessionsLoading = loading;
  try { return await loading; }
  finally { if (sessionsLoading === loading) sessionsLoading = null; }
}
// status+period chosen in the icon popover; 'all'/'all' = no active filter
const isChatDone = (s) => chatArchiving && s.status === 'done';
// with the feature off the two status filters no longer exist: hide the entries
// and fall back to "All" without losing the choice saved in localStorage
function applyChatArchiving(enabled) {
  chatArchiving = enabled !== false;
  $('filterMenu').querySelectorAll('.archiveOnly').forEach((b) => {
    b.classList.toggle('hide', !chatArchiving);
  });
  renderFilterMenu();
  renderSessions();
}
function passesSessionFilter(s, projectCwd = activeProjectCwd()) {
  // project tabs: with a tab active the sidebar only shows that project's chats
  if (projectCwd && (s.cwd || '').toLowerCase() !== projectCwd.toLowerCase()) return false;
  const { status, period } = sessionFilter;
  if (chatArchiving && status === 'active' && s.status === 'done') return false;
  if (chatArchiving && status === 'done' && s.status !== 'done') return false;
  if (status === 'favorite' && !s.favorite) return false;
  if (period !== 'all') {
    const d = new Date(s.modified);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'today' && d < startOfDay) return false;
    if (period === 'week') {
      const startOfWeek = new Date(startOfDay);
      startOfWeek.setDate(startOfDay.getDate() - ((startOfDay.getDay() + 6) % 7)); // Monday
      if (d < startOfWeek) return false;
    }
    if (period === 'month' && (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear())) return false;
  }
  return true;
}
// Scattered-words search: every word of the query must appear somewhere in the
// searchable text, in any order, so "docker fix" finds "Fix del container docker".
// A single word behaves exactly like the old substring match.
function matchesSessionSearch(s, words) {
  if (!words.length) return true;
  const hay = `${s.title || ''} ${s.name || ''} ${s.firstMessage || ''} ${s.cwd || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
// Filtered and ordered chats, shared by the sidebar and by the collapsed-sidebar
// flyout: the two must never disagree on what "the most recent chats" are.
function localSessionEntry(chatState) {
  const record = chatCache.draftRecord(chatState.key);
  const draft = record.draft.trim();
  const metadata = record.metadata;
  if (!draft && !metadata?.pending && !chatState.streaming) return null;
  const title = metadata?.title || draftTitle(draft) || 'New chat';
  return {
    path: chatState.key,
    id: chatState.key,
    cwd: chatState.cwd,
    name: '',
    firstMessage: title,
    title,
    messageCount: chatState.started ? 1 : 0,
    modified: metadata?.modified ?? new Date().toISOString(),
    favorite: false,
    status: 'active',
    provider: chatState.model?.provider ?? '',
    model: chatState.model?.id ?? '',
    thinkingLevel: chatState.thinking ?? '',
    branch: '',
    pullRequests: [],
    issues: [],
    local: true,
  };
}

function sidebarSessions() {
  const sessions = [...allSessions];
  const persisted = new Set(sessions.map((session) => session.path));
  for (const chatState of uiState.chats.values()) {
    if (persisted.has(chatState.key)) continue;
    const local = localSessionEntry(chatState);
    if (local) sessions.push(local);
  }
  return sessions;
}

function sessionForKey(key) {
  const persisted = allSessions.find((session) => session.path === key);
  if (persisted) return persisted;
  const chatState = uiState.chats.get(key);
  if (!chatState) return null;
  return localSessionEntry(chatState);
}

function sessionsInOrder(projectCwd = activeProjectCwd()) {
  const words = $('sessionSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // deep search results take the place of the list: the server has already
  // decided what matches, and only the project tab still narrows it down —
  // filters and title search could only take rows away from an answer the user
  // explicitly asked for.
  const list = deepResults
    ? deepResults.filter((s) => !projectCwd || (s.cwd || '').toLowerCase() === projectCwd.toLowerCase())
    : sidebarSessions().filter((s) => passesSessionFilter(s, projectCwd) && matchesSessionSearch(s, words));
  const sort = sessionSort;
  // favorites always sit on top and among themselves are sorted by date (newest
  // first), whatever view/sort is selected; the rest follows the sort.
  // Done chats always sit below active ones, even when more recent.
  const isDone = isChatDone;
  list.sort((a, b) => {
    const da = isDone(a) ? 1 : 0, db = isDone(b) ? 1 : 0;
    if (da !== db) return da - db;
    const fa = a.favorite ? 1 : 0, fb = b.favorite ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (fa) return modifiedAt(b) - modifiedAt(a);
    return sort === 'msgs' ? b.messageCount - a.messageCount
      : sort === 'old' ? modifiedAt(a) - modifiedAt(b)
      : modifiedAt(b) - modifiedAt(a);
  });
  return list;
}
// Grouping is independent from sorting: by day the date order is already enough,
// in the other cases a stable pass makes the groups contiguous without touching
// the inner order.
function orderForGrouping(list, groupBy) {
  const isDone = isChatDone;
  if (groupBy === 'project' || groupBy === 'model') {
    list.sort((a, b) => (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0)
      || (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)
      || groupOf(a, groupBy).localeCompare(groupOf(b, groupBy)));
  }
  return list;
}
// Only one hover card may be visible. Switching directly between adjacent rows
// replaces it synchronously instead of waiting for the previous row's leave timer.
let visibleSessionDetails = null;

// One chat row. Built once and reused by the sidebar and by the hover switcher,
// so active state, favourite/done buttons and running dots cannot drift apart
// between the two.
function sessionItemEl(s) {
  const done = isChatDone(s);
  const div = document.createElement('div');
  div.className = 'sessionItem' + (s.path === activeChatKey() ? ' active' : '') + (done ? ' done' : '');
  div.dataset.sessionKey = s.path;
  div.dataset.local = String(Boolean(s.local));
  // `title` is the server's summary of the chat, already falling back to the
  // truncated first message; the other two cover a payload without it.
  const label = sessionLabel(s) || '(empty)';
  const running = runningKeys.has(s.path);
  const hasDraft = Boolean(chatCache.draftRecord(s.path).draft.trim());
  // one line only: title and date. Model, project, message count and status
  // badges stay in the payload but out of sight; the per-row actions (favorite,
  // done) live in the hover panel as before.
  const actions = s.local ? '' : `<div class="acts">
    ${chatArchiving ? `<button class="doneBtn${done ? ' on' : ''}" title="${done ? 'Move back to active' : 'Mark as done'}">${done ? '↺' : '✓'}</button>` : ''}
    <button class="fav${s.favorite ? ' on' : ''}" title="${s.favorite ? 'Remove from favorites' : 'Add to favorites'}">${s.favorite ? '♥' : '♡'}</button>
    </div>`;
  div.innerHTML = `${actions}<div class="title">${hasDraft ? '<span class="draftDot" title="Unsent draft"></span>' : ''}${running ? '<span class="runDot"></span>' : ''}<span class="lbl"></span>
    <span class="date">${fmtDate(s.modified)}</span></div>`;
  div.querySelector('.lbl').textContent = label;
  /** @type {HTMLElement|null} */
  let details = null;
  let detailsTimer = null;
  const hideDetails = () => {
    clearTimeout(detailsTimer);
    detailsTimer = setTimeout(() => {
      details?.classList.remove('show');
      if (visibleSessionDetails === details) visibleSessionDetails = null;
    }, 120);
  };
  const openDetails = () => {
    if (!div.isConnected) return;
    if (!details) {
      details = sessionDetailsEl(s);
      details.addEventListener('mouseenter', () => clearTimeout(detailsTimer));
      details.addEventListener('mouseleave', hideDetails);
      div.appendChild(details);
    }
    if (visibleSessionDetails && visibleSessionDetails !== details) {
      visibleSessionDetails.classList.remove('show');
    }
    visibleSessionDetails = details;
    details.classList.add('show');
    const row = div.getBoundingClientRect();
    const panel = details.getBoundingClientRect();
    const gap = 8;
    const left = row.right + gap + panel.width <= window.innerWidth
      ? row.right + gap
      : Math.max(gap, row.left - panel.width - gap);
    const top = Math.min(Math.max(gap, row.top), window.innerHeight - panel.height - gap);
    details.style.left = `${left}px`;
    details.style.top = `${Math.max(gap, top)}px`;
  };
  const showDetails = () => {
    clearTimeout(detailsTimer);
    // Crossing the sidebar should not create and measure every row under the
    // pointer. Build the one requested card only after a deliberate hover.
    detailsTimer = setTimeout(openDetails, 180);
  };
  div.addEventListener('mouseenter', showDetails);
  div.addEventListener('mouseleave', hideDetails);
  div.title = label;
  // favorite: clicking the heart must not open the chat
  div.querySelector('.fav')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await post('/api/favorites', { path: s.path, favorite: !s.favorite });
    if (r.error) return;
    s.favorite = !s.favorite;
    renderSessions();
  });
  // done / reopen: here too the click must not open the chat
  div.querySelector('.doneBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = done ? 'active' : 'done';
    // Marking the chat you are in as done means "I am finished with this one":
    // the view then has to move on by itself, to the chat right below it in the
    // sidebar. The list is read BEFORE the change, because after it the chat is
    // either gone (the Active filter) or parked at the bottom, and in both cases
    // "the one after" no longer exists to be found.
    const leaving = next === 'done' && s.path === activeChatKey();
    const before = leaving ? orderForGrouping(sessionsInOrder(), sessionGroup) : null;
    const r = await post('/api/status', { path: s.path, status: next });
    if (r.error) return;
    s.status = r.status ?? next;
    renderSessions();
    if (!leaving) return;
    const after = orderForGrouping(sessionsInOrder(), sessionGroup);
    const i = before.findIndex((x) => x.path === s.path);
    // downwards first, then upwards: whatever the filters left on screen
    const order = i < 0 ? after : [...before.slice(i + 1), ...before.slice(0, i).reverse()];
    const target = order.find((c) => c.path !== s.path && after.some((x) => x.path === c.path));
    // nothing left to land on: the new-chat screen, exactly like emptying the list
    if (target) await openSession(target); else await newChat();
  });
  // middle click or Ctrl+click = open the chat in a new tab (every tab has its own chat)
  const openInNewTab = () => window.open(
    location.origin + location.pathname + '#s=' + encodeURIComponent(s.path), '_blank');
  div.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  div.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openInNewTab(); } });
  div.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); openInNewTab(); return; }
    openSession(s);
  });
  return div;
}
function sessionDetailsEl(s) {
  const details = document.createElement('div');
  details.className = 'sessionDetails';
  const addDetail = (name, value) => {
    if (!value) return;
    const key = document.createElement('span');
    key.className = 'metaKey';
    key.textContent = name;
    const content = document.createElement('span');
    content.className = 'metaValue';
    content.textContent = value;
    details.append(key, content);
  };
  const project = (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
  addDetail('Project', project);
  addDetail('Model', [s.provider, s.model].filter(Boolean).join('/'));
  addDetail('Thinking', s.thinkingLevel || 'off');
  addDetail('Branch', s.cwd ? uiState.projectState(s.cwd).git?.branch : s.branch);
  const addResources = (name, resources, kind) => {
    if (!resources.length) return;
    const key = document.createElement('span');
    key.className = 'metaKey';
    key.textContent = name;
    const links = document.createElement('span');
    links.className = 'metaValue resourceLinks';
    for (const resource of resources) {
      const link = document.createElement('a');
      link.href = resource.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `#${resource.number}`;
      link.title = `Open ${kind} #${resource.number}`;
      link.addEventListener('click', (e) => e.stopPropagation());
      links.appendChild(link);
    }
    details.append(key, links);
  };
  addResources('PR', s.pullRequests, 'pull request');
  addResources('Issues', s.issues, 'issue');
  if (!s.local) {
    const key = document.createElement('span');
    key.className = 'metaKey';
    key.textContent = 'Chat code';
    const code = document.createElement('button');
    code.className = 'chatCode';
    code.type = 'button';
    code.textContent = s.id;
    code.title = 'Copy chat code';
    code.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(s.id);
    });
    details.append(key, code);
  }
  return details;
}

// Rows plus group headers, in the container of the caller.
function fillSessionList(el, list, groupBy) {
  const fragment = document.createDocumentFragment();
  let lastGroup = null;
  for (const s of list) {
    if (groupBy !== 'none') {
      const g = isChatDone(s) ? 'Done' : s.favorite ? 'Favorites' : groupOf(s, groupBy);
      if (g !== lastGroup) {
        lastGroup = g;
        const h = document.createElement('div');
        h.className = 'sessGroup';
        if (groupBy === 'model' && !isChatDone(s) && !s.favorite) {
          h.innerHTML = providerIconHtml(s.provider, s.model);
          h.append(document.createTextNode(g));
        } else {
          h.textContent = g;
        }
        fragment.appendChild(h);
      }
    }
    fragment.appendChild(sessionItemEl(s));
  }
  el.replaceChildren(fragment);
}
function updateSessionRunningState(key, running) {
  let found = false;
  for (const row of $$('.sessionItem')) {
    if (row.dataset.sessionKey !== key) continue;
    found = true;
    const title = row.querySelector('.title');
    const dot = row.querySelector('.runDot');
    if (running && !dot) {
      const next = document.createElement('span');
      next.className = 'runDot';
      title?.insertBefore(next, title.querySelector('.lbl'));
    } else if (!running) {
      dot?.remove();
    }
  }
  return found;
}
function renderSessions() {
  renderContextHeader();
  const groupBy = sessionGroup;
  const list = orderForGrouping(sessionsInOrder(), groupBy);
  $('sessionCount').textContent = list.length;
  if ($('quickChats').classList.contains('show')) renderQuickChats();
  const el = $('sessionList');
  if (!list.length) { el.innerHTML = '<div class="sys" style="padding:.8rem">No chat</div>'; return; }
  fillSessionList(el, list, groupBy);
}
// group label of a chat in the sidebar
function groupOf(s, mode) {
  if (mode === 'project') return (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'no project';
  if (mode === 'model') return s.model || 'unknown model';
  // day, in readable buckets
  const d = new Date(s.modified);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Last 7 days';
  if (diff < 30) return 'Last 30 days';
  return day.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

// Switching chat interrupts nothing: the chat you leave keeps working on the
// server and you find it again (result included) when you come back.
async function openSession(s, { tabId = uiState.activeTabId } = {}) {
  const previous = uiState.selection;
  // A restored local row may outlive its server context. Resolve it before a
  // committed transition opens SSE, otherwise the stale key can attach to the
  // default context while the resume request is still in flight.
  let ticket;
  if (s.local) ticket = navigation.begin();
  else ticket = navigation.transition({ tabId, view: VIEW_CHAT, resourceId: s.path });
  let route = '/api/sessions';
  if (!s.local) route = sessionPath(s.path, 'activate');
  const r = await post(
    route,
    { cwd: s.cwd || undefined },
    { followKey: false, key: s.path, ticket },
  );
  if (!navigation.isCurrent(ticket)) return false;
  if (r.error) {
    if (!s.local) {
      if (previous && isNavigationSelectionAvailable(previous) && uiState.canSelect(previous)) {
        navigation.transition(previous);
      } else {
        navigation.restoreActive(fallbackSelectionForTab);
      }
    }
    return false;
  }
  const key = r.key ?? s.path;
  if (key !== s.path) uiState.rekeyChat(s.path, key);
  let activeTicket = ticket;
  if (s.local) {
    activeTicket = navigation.commit({ tabId, view: VIEW_CHAT, resourceId: key }, ticket);
  } else if (key !== s.path) {
    activeTicket = navigation.transition({ tabId, view: VIEW_CHAT, resourceId: key });
  }
  if (!activeTicket) return false;
  showChatResource(key);            // the cached view was already shown by the transition
  await loadOpenChat(activeTicket); // synchronize independently; never rely on SSE alone
  return true;
}

async function openChatNotification(key) {
  let session = allSessions.find((item) => item.path === key);
  if (!session) {
    await loadSessions();
    session = allSessions.find((item) => item.path === key);
  }
  if (!session) {
    toast('That chat is no longer available');
    return;
  }
  const projectId = session.cwd ? projectTabId(session.cwd) : null;
  const tabId = projectId && uiState.projects.has(projectId) ? projectId : projectTabId(null);
  await openSession(session, { tabId });
}
// The transition has already restored the cached DOM synchronously. Network
// synchronization starts afterwards and is split by owner: session listing is
// global, history/state belong to the chat, files/Git to its project. Global
// model and command catalogs are intentionally absent from ordinary switches.
async function loadOpenChat(ticket) {
  if (!navigation.isCurrent(ticket)) return;
  const key = activeChatKey();
  await navigationSync.synchronize(ticket, uiState.chatState(key).cwd);
}
// A project tab pins the folder: a chat started while it is active is born in
// that project, whatever folder the chat we are leaving happened to use.
async function newChat({ tabId = uiState.activeTabId, ticket = navigation.begin() } = {}) {
  const project = uiState.projects.get(tabId);
  if (!project) return;
  const want = project.cwd;
  const ownerKey = activeChatKey() ?? renderedChatKey;
  const r = await post('/api/sessions', undefined, { followKey: false, key: ownerKey, ticket });
  if (r.error || !navigation.isCurrent(ticket)) return;
  let key = r.key;
  let cwd = r.cwd ?? '';
  if (want && cwd.toLowerCase() !== want.toLowerCase()) {
    // the folder of an unstarted chat is a new context: follow its key
    const c = await post('/api/cwd', { path: want }, { followKey: false, key, ticket });
    if (c.error || !navigation.isCurrent(ticket)) return;
    key = c.key ?? key;
    cwd = c.cwd ?? want;
  }
  const chatState = uiState.chatState(key);
  chatState.cwd = cwd;
  const committed = navigation.commit({ tabId, view: VIEW_CHAT, resourceId: key }, ticket);
  if (!committed) return;
  await loadOpenChat(committed);
  if (navigation.isCurrent(committed)) $('input').focus();
}
// wrapped: the click event must not be read as the chat's folder
$('newSessionBtn').addEventListener('click', () => newChat());
// What the sidebar shows just changed (filters, sort, grouping): the selected
// chat follows it. Project-tab changes use their own remembered selection.
async function syncChatToList() {
  const first = orderForGrouping(sessionsInOrder(), sessionGroup)[0];
  if (!first) return newChat();
  if (first.path === activeChatKey()) { showChat(); return; }
  await openSession(first);
}
$('openPiTermBtn').addEventListener('click', () => terminalView.open('pi'));
$('openShellTermBtn').addEventListener('click', () => terminalView.open('shell'));

/* ---- deep search: the words inside the messages, not just the titles ---- */
// null = off (the sidebar shows the normal list); an array = the server's answer
let deepResults = null;
let deepSearching = false;
// The deep search in flight, and the number of the search that owns it: an
// older answer must not touch the sidebar nor the button.
let deepSearchAbort = null;
let deepSearchSeq = 0;
// The button has three faces: working, showing an answer, ready to search.
function deepBtnFace() {
  if (deepSearching) return '<span class="deepSpin"></span>Searching in messages…';
  if (deepResults) return 'Back to the chat list';
  return 'Search in messages';
}
function updateDeepBtn() {
  const btn = $('deepSearchBtn');
  const query = $('sessionSearch').value.trim();
  // nothing typed and no results on screen: there is nothing to search or undo
  btn.classList.toggle('hide', !query && !deepResults);
  btn.disabled = deepSearching || (!query && !deepResults);
  btn.innerHTML = deepBtnFace();
}
function exitDeepSearch() {
  deepResults = null;
  updateDeepBtn();
  renderSessions();
}
async function runDeepSearch() {
  const query = $('sessionSearch').value.trim();
  if (!query) return;
  // Starting a search gives up the one still scanning: the server sees the
  // request die and stops reading files instead of answering nobody.
  deepSearchAbort?.abort();
  const ctrl = new AbortController();
  deepSearchAbort = ctrl;
  const seq = ++deepSearchSeq;
  deepSearching = true;
  updateDeepBtn();
  // scope=all like the chat list itself: the project tab, if any, filters the
  // results client-side, exactly as it does for the normal list
  const raw = await api('/api/search?scope=all&q=' + encodeURIComponent(query), { signal: ctrl.signal });
  // aborted, or overtaken by a newer search: the one running now owns the state
  if (seq !== deepSearchSeq) return;
  deepSearching = false;
  deepSearchAbort = null;
  // typing during the request has already put the sidebar back on the titles:
  // these results answer a question the user has moved on from.
  const stale = $('sessionSearch').value.trim() !== query;
  if (!stale && !raw.error) {
    const res = normalizeSearchPayload(raw);
    deepResults = res.sessions;
    // Two ways a search can come back short: 50 matches found, or the scan
    // stopped before the end of the list (the file budget, off with the
    // "full search" option in Settings).
    if (res.capped) toast(`Search stopped at the most recent ${res.scanned} chats`);
    else if (!deepResults.length) toast('No chat contains those words');
    else if (res.truncated) toast(`Showing the ${deepResults.length} most recent matches`);
  }
  updateDeepBtn();
  renderSessions();
}
$('deepSearchBtn').addEventListener('click', () => (deepResults ? exitDeepSearch() : runDeepSearch()));
$('sessionSearch').addEventListener('input', () => {
  // typing again is leaving the results behind: back to searching the titles
  deepResults = null;
  updateDeepBtn();
  renderSessions();
});
$('sessionSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDeepSearch(); });
// MOD+P: cycle through the chats the sidebar is showing right now — the same
// list, in the same order, filters and search included — wrapping around.
async function cycleChat() {
  const list = sessionsInOrder();
  if (list.length < 2) { toast('No other chat in the sidebar'); return; }
  const idx = list.findIndex((s) => s.path === activeChatKey());
  await openSession(list[(idx + 1) % list.length]);
}
function setSidebarCollapsed(v) {
  $('sidebar').classList.toggle('collapsed', v);
  // with the sidebar closed the chat text gets even wider (see body.sb-closed)
  document.body.classList.toggle('sb-closed', v);
  // collapsed, the icon's job is the chat list on hover: a "Show sidebar" tooltip
  // would pop up in front of it
  $('sidebarShow').title = v ? '' : 'Show sidebar';
  if (!v) hideQuickChats();
}

/* ---- quick chat switcher: the chat list on hover, sidebar still collapsed ---- */
const QUICK_CHATS_MAX = 12;
function renderQuickChats() {
  const groupBy = sessionGroup;
  const full = orderForGrouping(sessionsInOrder(), groupBy);
  const list = full.slice(0, QUICK_CHATS_MAX);
  const box = $('quickChats');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="sys" style="padding:.5rem .55rem">No chat</div>'; return; }
  // same rows as the sidebar: active chat, favourite/done buttons, grouping and
  // ordering all come from there, this is only a shorter window on the list
  fillSessionList(box, list, groupBy);
  // opening a chat from here must not leave the flyout hanging over the page
  box.querySelectorAll('.sessionItem').forEach((el) => {
    el.addEventListener('click', (e) => { if (!e.ctrlKey && !e.metaKey) hideQuickChats(); });
  });
  if (full.length > QUICK_CHATS_MAX) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'qcMore';
    more.textContent = `Open the sidebar — ${full.length - QUICK_CHATS_MAX} more chats`;
    more.addEventListener('click', () => { hideQuickChats(); setSidebarCollapsed(false); });
    box.appendChild(more);
  }
}
let quickChatsTimer = null;
function showQuickChats() {
  clearTimeout(quickChatsTimer);
  // it exists to avoid reopening the sidebar: with the sidebar open it is noise
  if (!$('sidebar').classList.contains('collapsed')) return;
  renderQuickChats();
  $('quickChats').classList.add('show');
}
function hideQuickChats() {
  clearTimeout(quickChatsTimer);
  $('quickChats').classList.remove('show');
}
// the delay is what makes the diagonal trip from the icon to the list survivable
const quickChatsLater = () => { clearTimeout(quickChatsTimer); quickChatsTimer = setTimeout(hideQuickChats, 250); };
$('sidebarShowWrap').addEventListener('mouseenter', showQuickChats);
$('sidebarShowWrap').addEventListener('mouseleave', quickChatsLater);
$('sidebarShow').addEventListener('focus', showQuickChats);

/* ---- project tabs: one browser-style tab per open project (persisted) ---- */
// The open-tab list is configuration. The active tab and its view/resource are
// derived only from uiState.selection, so tab, header and content cannot drift.
let projState = { tabs: [] };
let initialProjectCwd = null;
try {
  const saved = JSON.parse(localStorage.getItem('piProjTabs') || '{}');
  if (Array.isArray(saved.tabs)) projState.tabs = saved.tabs.filter((t) => typeof t === 'string');
  if (typeof saved.active === 'string' && projState.tabs.includes(saved.active)) initialProjectCwd = saved.active;
} catch {}
uiState.replaceProjectTabs(projState.tabs);
uiState.setActiveTab(projectTabId(initialProjectCwd));
const projName = (cwd) => (cwd || '').split(/[\\/]/).filter(Boolean).pop() || cwd;
function isNavigationSelectionAvailable(selection) {
  if (selection.view === VIEW_SETTINGS) return true;
  if (selection.view === VIEW_CHAT) {
    return selection.resourceId === renderedChatKey || sidebarSessions().some((s) => s.path === selection.resourceId);
  }
  return terminalView.has(selection.resourceId);
}
function fallbackSelectionForTab(tabId) {
  const project = uiState.projects.get(tabId);
  if (!project) return null;
  const firstChat = orderForGrouping(sessionsInOrder(project.cwd), sessionGroup)[0];
  if (firstChat) return { tabId, view: VIEW_CHAT, resourceId: firstChat.path };
  const firstTerminal = terminalView.firstForProject(project.cwd);
  return firstTerminal ? { tabId, view: VIEW_TERMINAL, resourceId: firstTerminal.id } : null;
}
function selectCurrentChatState(key = renderedChatKey) {
  if (!key || !uiState.chats.has(key)) return null;
  if (uiState.selection && uiState.selection.view !== VIEW_CHAT) return null;
  const tabId = uiState.activeTabId;
  if (uiState.selection?.tabId === tabId && uiState.selection.resourceId === key) return null;
  const project = uiState.projects.get(tabId);
  const chatState = uiState.chats.get(key);
  if (!project || (project.cwd !== null && (!chatState.cwd || project.cwd.toLowerCase() !== chatState.cwd.toLowerCase()))) return null;
  return navigation.transition({ tabId, view: VIEW_CHAT, resourceId: key });
}
function saveProjTabs() {
  localStorage.setItem('piProjTabs', JSON.stringify({ tabs: projState.tabs, active: activeProjectCwd() }));
}
// Chromium protects drag payloads between dragstart and drop, so dragover
// cannot reliably read dataTransfer. Keep the source in page state while the
// gesture is active; the payload remains a fallback for the final drop.
function reorderProjectTabs(tabs, source, target, after) {
  const from = tabs.indexOf(source);
  const targetIndex = tabs.indexOf(target);
  if (from < 0 || targetIndex < 0 || from === targetIndex) return tabs;
  const reordered = tabs.filter((tab) => tab !== source);
  reordered.splice(reordered.indexOf(target) + (after ? 1 : 0), 0, source);
  return reordered;
}
let draggedProjectCwd = null;
function renderProjTabs() {
  const list = $('projTabList');
  list.innerHTML = '';
  const active = activeProjectCwd();
  const mkTab = (label, cwd) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'projTab' + ((cwd ?? null) === active ? ' on' : '');
    t.title = cwd || 'All chats, whatever the project';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = label;
    t.appendChild(nm);
    if (cwd) {
      t.draggable = true;
      t.dataset.cwd = cwd;
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Close this project tab (chats are kept)';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeProjTab(cwd); });
      t.appendChild(x);
      t.addEventListener('dragstart', (e) => {
        draggedProjectCwd = cwd;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cwd);
        requestAnimationFrame(() => t.classList.add('dragging'));
      });
      t.addEventListener('dragend', () => {
        draggedProjectCwd = null;
        $$('.projTab').forEach((tab) => tab.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      t.addEventListener('dragover', (e) => {
        if (!draggedProjectCwd || draggedProjectCwd === cwd) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = e.clientX > t.getBoundingClientRect().left + t.offsetWidth / 2;
        t.classList.toggle('drop-before', !after);
        t.classList.toggle('drop-after', after);
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        const source = draggedProjectCwd || e.dataTransfer.getData('text/plain');
        const after = e.clientX > t.getBoundingClientRect().left + t.offsetWidth / 2;
        const reordered = reorderProjectTabs(projState.tabs, source, cwd, after);
        if (reordered === projState.tabs) return;
        projState.tabs = reordered;
        saveProjTabs();
        renderProjTabs();
      });
    }
    t.addEventListener('click', () => activateProjTab(cwd ?? null));
    list.appendChild(t);
  };
  mkTab('All', null);
  for (const cwd of projState.tabs) mkTab(projName(cwd), cwd);
}
async function activateProjTab(cwd) {
  if (cwd) uiState.registerProject(cwd);
  const tabId = projectTabId(cwd);
  const ticket = navigation.switchTab(tabId, fallbackSelectionForTab);
  if (!ticket.selection) return newChat({ tabId, ticket });
  if (ticket.selection.view !== VIEW_CHAT) return;
  await loadOpenChat(ticket);
}
async function closeProjTab(cwd, { landingCwd = null } = {}) {
  const closingTabId = projectTabId(cwd);
  const wasActive = uiState.activeTabId === closingTabId;
  projState.tabs = projState.tabs.filter((tab) => tab !== cwd);
  const landingTabId = wasActive ? projectTabId(landingCwd) : uiState.activeTabId;
  const ticket = navigation.closeTab({
    tabId: closingTabId,
    projectCwds: projState.tabs,
    landingTabId,
    fallback: fallbackSelectionForTab,
  });
  saveProjTabs();
  renderProjTabs();
  if (!wasActive) return;
  if (!ticket.selection) return newChat({ tabId: landingTabId, ticket });
  if (ticket.selection.view !== VIEW_CHAT) return;
  await loadOpenChat(ticket);
}
// "+" menu: every project we know of — the folders of the existing chats plus the
// recent-folders list — minus the tabs already open
// MOD+T: cycle through the open project tabs, "All" included, wrapping around.
function cycleProjTab() {
  const tabs = [null, ...projState.tabs];
  if (tabs.length < 2) { toast('No other project tab'); return; }
  const idx = tabs.indexOf(activeProjectCwd());
  return activateProjTab(tabs[(idx + 1) % tabs.length]);
}
// MOD+W: close the active project tab and land on the next one. On "All" there
// is no tab to close, so the app itself goes.
function closeCurrentProjTab() {
  const cur = activeProjectCwd();
  if (!cur) { quitApp(); return; }
  const tabs = [null, ...projState.tabs];
  const next = tabs[(tabs.indexOf(cur) + 1) % tabs.length] ?? null;
  const land = next && projState.tabs.includes(next) ? next : null;
  closeProjTab(cur, { landingCwd: land });
}
function quitApp() {
  if (!IS_ELECTRON) { toast('No project tab to close'); return; }
  window.close();
}
const projAddDd = setupDd('projAddDd', 'projAddBtn');
function knownProjects() {
  const open = new Set(projState.tabs.map((t) => t.toLowerCase()));
  const seen = new Map(); // lowercased path -> original casing, so C:\X and c:\x are one project
  for (const cwd of [...allSessions.map((s) => s.cwd), ...recentCwds]) {
    if (!cwd) continue;
    const k = cwd.toLowerCase();
    if (!open.has(k) && !seen.has(k)) seen.set(k, cwd);
  }
  return [...seen.values()].sort((a, b) => projName(a).localeCompare(projName(b)));
}
function renderProjAddMenu() {
  const known = knownProjects();
  const menu = $('projAddMenu');
  menu.innerHTML = '<div class="dd-group">Open a project tab</div>';
  if (!known.length) { menu.innerHTML += '<div class="sys" style="padding:.4rem .55rem">No other project in your chats</div>'; return; }
  for (const cwd of known) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dd-item';
    b.innerHTML = '<span class="col"></span>';
    const col = b.querySelector('.col');
    const nm = document.createElement('span');
    nm.textContent = projName(cwd);
    const pth = document.createElement('span');
    pth.className = 'pth';
    pth.textContent = cwd;
    col.append(nm, pth);
    b.addEventListener('click', () => {
      projState.tabs.push(cwd);
      projAddDd.classList.remove('open');
      activateProjTab(cwd);
    });
    menu.appendChild(b);
  }
}
// The strip scrolls, so it clips its own children: the menu is fixed-positioned
// and anchored to the button here, right after setupDd has toggled it open.
$('projAddBtn').addEventListener('click', () => {
  if (!projAddDd.classList.contains('open')) return;
  renderProjAddMenu();
  const r = $('projAddBtn').getBoundingClientRect();
  const menu = $('projAddMenu');
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  // keep it on screen when the button sits near the right edge
  menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
});
renderProjTabs();

$('sidebarToggle').addEventListener('click', () => setSidebarCollapsed(true));
$('sidebarShow').addEventListener('click', () => setSidebarCollapsed(!$('sidebar').classList.contains('collapsed')));
$('sidebarBackdrop').addEventListener('click', () => setSidebarCollapsed(true));
// on phones the sidebar starts closed (it behaves as a slide-over drawer)
if (window.matchMedia('(max-width: 768px)').matches) setSidebarCollapsed(true);
// auto-close the drawer after picking a session on mobile
if (window.matchMedia('(max-width: 768px)').matches) {
  $('sessionList').addEventListener('click', (e) => {
    if (e.target.closest('.sessionItem')) setSidebarCollapsed(true);
  });
  $('newSessionBtn').addEventListener('click', () => setSidebarCollapsed(true));
}

/* ---------------- refresh helpers ---------------- */
function parkChatView(key) {
  if (!key || chatView.hasSnapshot(key)) return;
  stashComposerDraft(key);
  const entry = uiState.chatViewState(key);
  entry.composer.attachments = pending;
  chatView.park(key);
}
function restoreChatView(key) {
  const entry = uiState.chatViewState(key);
  input.value = entry.composer.draft;
  pending = entry.composer.attachments;
  renderAttachments();
  autoGrow();
  chatView.restore(key);
  renderContextHeader();
}
async function refreshChat({ key = activeChatKey() ?? renderedChatKey, ticket = null } = {}) {
  if (!key || (ticket && !navigation.isCurrent(ticket)) || activeChatKey() !== key) return;
  const entry = uiState.chatViewState(key);
  const preserveScroll = entry.view.scrollTop !== null || chatView.hasContent();
  await loadHistory({ key, ticket, replace: true, preserveScroll });
}
async function refreshAll({ key = activeChatKey() ?? renderedChatKey, ticket = null } = {}) {
  if (!key) return;
  const stateSync = loadState({ key, ticket });
  await stateSync;
  if (ticket && (!navigation.isCurrent(ticket) || activeChatKey() !== key)) return;
  const projectCwd = uiState.chatState(key).cwd;
  const results = await Promise.allSettled([
    loadFiles({ key, projectCwd }),
    refreshGit({ key, projectCwd }),
    loadSessions(),
    refreshChat({ key, ticket }),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') toast('Could not refresh the active scopes: ' + result.reason?.message);
  }
}

/* ---------------- history ---------------- */
async function loadHistory({
  key = activeChatKey() ?? renderedChatKey,
  ticket = null,
  replace = false,
  preserveScroll = false,
} = {}) {
  const view = uiState.chatViewState(key).view;
  const query = preserveScroll && view.historyStart !== null ? `start=${view.historyStart}` : 'limit=40';
  const res = await api(`/api/history?${query}`, undefined, { key, ticket, guardChat: Boolean(key) });
  if (res.error || key !== activeChatKey()) return;
  if (replace) {
    resetTasks(key);
    uiState.chatState(key).pendingAssistantMeta = null;
  }
  view.historyStart = res.start;
  if (res.turnModel) activeChatState().turnModel = res.turnModel;
  const projection = chatView.renderHistory({
    key,
    messages: res.messages ?? [],
    live: res.live ?? [],
    before: res.before,
    replace,
    preserveScroll,
  });
  setChatStarted(res.total > 0 || (res.live ?? []).length > 0, key);
  const owner = uiState.chatState(key);
  if (res.streaming) {
    owner.streaming = true;
    owner.responsePhase = (res.live ?? []).some((segment) => segment.type === 'text' && segment.text)
      ? RESPONSE_TEXT
      : RESPONSE_WAITING;
  }
  setRunning(!!res.streaming);
  setAwaitingInput(!!res.awaitingInput, key);
  chatView.renderQueuedPrompts(owner.queuedPrompts);
  if (res.streaming && !owner.agentTask) setAgentTask(true, res.turnModel, key);
  else if (!res.streaming && owner.agentTask && !owner.agentTask.t1) setAgentTask(false, null, key);
  if (projection.empty) chatView.showHero(projectName());
  else setHeroMode(false);
  view.scrollTop = projection.scrollTop;
}

/* ---------------- diff panel ---------------- */
const dlines = (cls, t) => t.split('\n').map((l) => `<div class="diffline ${cls}">${esc(l) || ' '}</div>`).join('');
function renderProjectFiles(scope = activeProjectScope()) {
  const files = scope?.files ?? [];
  $('diffCount').textContent = files.length;
  $('diffCount').classList.toggle('hide', !files.length);
  const list = $('fileList');
  list.innerHTML = '';
  for (const f of files) {
    const div = document.createElement('div');
    const fileId = `${f.sourceKey}\0${f.path}`;
    div.className = 'fileItem' + (fileId === scope.activeFile ? ' active' : '');
    div.innerHTML = `<span title="${esc(`${f.path}\nSource chat: ${f.sourceKey}`)}">${esc(f.path.split(/[\\/]/).pop())}</span><span class="b">${f.changes}</span>`;
    div.addEventListener('click', () => showDiff(f));
    list.appendChild(div);
  }
}
function renderProjectScope(scope = activeProjectScope()) {
  renderProjectFiles(scope);
  renderGit(scope);
  $('diffBody').innerHTML = scope ? scope.diffHtml : '';
}
async function loadFiles({ key = activeChatKey() ?? renderedChatKey, projectCwd = projectScopeForChat(key)?.cwd } = {}) {
  if (!key || !projectCwd) return;
  const owner = uiState.projectState(projectCwd);
  const r = await api('/api/files', undefined, {
    key,
    guard: () => isProjectScopeActive(owner.cwd),
  });
  if (r.error) return;
  owner.files = r.files ?? [];
  if (isProjectScopeActive(owner.cwd)) renderProjectFiles(owner);
}
async function showDiff(file) {
  const key = activeChatKey();
  const owner = projectScopeForChat(key);
  if (!key || !owner) return;
  const fileId = `${file.sourceKey}\0${file.path}`;
  owner.activeFile = fileId;
  owner.diffHtml = '';
  renderProjectScope(owner);
  await loadFiles({ key, projectCwd: owner.cwd });
  const query = new URLSearchParams({ path: file.path, source: file.sourceKey });
  const d = await api('/api/files/diff?' + query, undefined, {
    key,
    guard: () => isProjectScopeActive(owner.cwd) && owner.activeFile === fileId,
  });
  if (d.error) return;
  let html = '';
  if (d.write) html += '<div class="hunk">' + dlines('add', d.write.content) + '</div>';
  for (const h of d.hunks) html += '<div class="hunk">' + dlines('del', h.oldText) + dlines('add', h.newText) + '</div>';
  owner.diffHtml = html || '<div class="sys" style="padding:.5rem">(no change)</div>';
  $('diffBody').innerHTML = owner.diffHtml;
}
$('navDiff').addEventListener('click', () => {
  const open = $('diffPanel').classList.toggle('open');
  $('navDiff').classList.toggle('on', open);
  document.body.classList.toggle('diff-open', open);
  if (open) loadFiles();
});
$('diffClose').addEventListener('click', () => {
  $('diffPanel').classList.remove('open');
  $('navDiff').classList.remove('on');
  document.body.classList.remove('diff-open');
});

/* ---------------- tasks panel: background processes OF THIS chat ------------
   Tool and agent execution records live on their chat state. Switching only
   changes which record set is projected; it never clears another chat. */
const TASK_TOOLS = /^(bash|shell|task|agent|subagent|dispatch_agent|web_search|web_fetch|fetch)$/i;
function taskOwner(key = activeChatKey()) {
  return key ? uiState.chatState(key) : uiState.pendingChat;
}
function resetTasks(key = activeChatKey()) {
  const owner = taskOwner(key);
  owner.tasks.clear();
  owner.agentTask = null;
  if (key === activeChatKey()) syncTasks();
}
function taskFromTool(ev, key = activeChatKey()) {
  if (!key || !TASK_TOOLS.test(ev.name || '')) return;
  const owner = taskOwner(key);
  if (ev.status === 'start') {
    owner.tasks.set(ev.id, { name: ev.name, summary: ev.summary || '', t0: Date.now(), t1: null, error: false });
  } else if (ev.status === 'end') {
    const task = owner.tasks.get(ev.id);
    if (task) { task.t1 = Date.now(); task.error = !!ev.isError; }
  }
  if (key === activeChatKey()) syncTasks();
}
function setAgentTask(on, model, key = activeChatKey()) {
  if (!key) return;
  const owner = taskOwner(key);
  if (on && (!owner.agentTask || owner.agentTask.t1 !== null)) {
    owner.agentTask = { name: 'Agent', summary: model?.name || model?.id || '', t0: Date.now(), t1: null, error: false };
  } else if (!on && owner.agentTask && !owner.agentTask.t1) {
    owner.agentTask.t1 = Date.now();
    owner.responseStartedAt = null;
    owner.responseActivityLabel = null;
  }
  if (key === activeChatKey()) {
    syncTasks();
    if (typeof renderComposerState === 'function') renderComposerState(owner);
  }
}
function taskList(key = activeChatKey()) {
  const owner = taskOwner(key);
  const all = [...owner.tasks.values()];
  if (owner.agentTask) all.push(owner.agentTask);
  return all.sort((a, b) => (a.t1 ? 1 : 0) - (b.t1 ? 1 : 0) || b.t0 - a.t0);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}
function syncTasks() {
  const list = taskList();
  const live = list.filter((t) => !t.t1).length;
  const b = $('tasksCount');
  b.textContent = live;
  b.classList.toggle('hide', live === 0);
  $('navTasks').classList.toggle('busy', live > 0);
  if ($('tasksPanel').classList.contains('open')) renderTasks(list);
}
function renderTasks(list = taskList()) {
  const el = $('tasksBody');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="sys" style="padding:.6rem">No background process in this chat</div>';
    return;
  }
  for (const t of list) {
    const running = !t.t1;
    const div = document.createElement('div');
    div.className = 'taskItem';
    div.innerHTML = `<div class="t">${running ? '<span class="runDot"></span>' : ''}<span class="lbl"></span></div>
      <div class="m"><span>${esc(t.name)}</span><span>·</span>
      <span class="${t.error ? 'err' : running ? 'st' : 'idle'}">${t.error ? 'Error' : running ? 'Running' : 'Completed'}</span>
      <span>·</span><span>${fmtDur((t.t1 ?? Date.now()) - t.t0)}</span></div>`;
    div.querySelector('.lbl').textContent = t.summary || t.name;
    div.title = t.summary || t.name;
    el.appendChild(div);
  }
}
// running task timers tick on their own, but only while the panel is open
setInterval(() => {
  if ($('tasksPanel').classList.contains('open') && taskList().some((t) => !t.t1)) renderTasks();
}, 1000);
$('navTasks').addEventListener('click', () => {
  const open = $('tasksPanel').classList.toggle('open');
  $('navTasks').classList.toggle('on', open);
  if (open) renderTasks();
});
$('tasksRefresh').addEventListener('click', () => {
  // "Clear": drop finished tasks only from the visible chat.
  const owner = taskOwner();
  for (const [id, task] of owner.tasks) if (task.t1) owner.tasks.delete(id);
  if (owner.agentTask?.t1) owner.agentTask = null;
  syncTasks(); renderTasks();
});
$('tasksClose').addEventListener('click', () => {
  $('tasksPanel').classList.remove('open');
  $('navTasks').classList.remove('on');
});

/* ---------------- integrated terminals (xterm over SSE) ---------------- */
const terminalView = createTerminalView({
  state: uiState,
  api,
  post,
  fetchImpl: window.fetch.bind(window),
  createEventSource: (url) => new EventSource(url),
  getTerminalConstructor: () => win.Terminal,
  getFitAddonConstructor: () => win.FitAddon?.FitAddon,
  getSelection: () => uiState.selection,
  getActiveProjectCwd: activeProjectCwd,
  selectTerminal: (terminal) => {
    const currentProject = activeProjectCwd();
    const tabId = !currentProject || sameCwd(currentProject, terminal.cwd)
      ? uiState.activeTabId
      : projectTabId(null);
    navigation.transition({ tabId, view: VIEW_TERMINAL, resourceId: terminal.id });
  },
  restoreSelection: () => {
    const ticket = navigation.restoreActive(fallbackSelectionForTab);
    if (!ticket.selection) newChat({ tabId: uiState.activeTabId, ticket });
    else if (ticket.selection.view === VIEW_CHAT) loadOpenChat(ticket);
  },
  getPlatformCapabilities: () => platformCaps,
  toast,
});
terminalView.start();

function renderContextHeader(selection = uiState.selection) {
  const selectedChat = selection?.view === VIEW_CHAT ? uiState.chats.get(selection.resourceId) : null;
  const chatSession = selection?.view === VIEW_CHAT
    ? sessionForKey(selection.resourceId)
    : null;
  const chatHeader = chatHeaderState(selection, selectedChat, chatSession, {
    canOpenFolder: platformCaps?.openFolder,
  });
  $('mainHeader').dataset.view = selection?.view ?? VIEW_CHAT;
  document.querySelector('.crumb').classList.toggle('hide', !chatHeader);
  terminalView.renderHeader(selection);

  if (!chatHeader) return;
  const parts = chatHeader.cwd.split(/[\\/]/).filter(Boolean);
  $('cwdLabel').textContent = parts.slice(-2).join('/') || chatHeader.cwd || '—';
  $('cwdChip').title = 'Working folder: ' + chatHeader.cwd;
  $('chatTitle').textContent = chatHeader.title;
  $('cwdInput').value = chatHeader.cwd;
  $('cwdInput').readOnly = !chatHeader.canChangeFolder;
  $('cwdInput').classList.toggle('hide', !chatHeader.canChangeFolder);
  $('cwdEditRow').classList.toggle('hide', !chatHeader.canChangeFolder);
  $('recentBox').classList.toggle('hide', !chatHeader.canChangeFolder);
  $('browseBtn').classList.toggle('hide', !chatHeader.canChangeFolder || !platformCaps?.pickFolder);
  $('cwdHint').textContent = chatHeader.canChangeFolder
    ? 'Working folder: the agent reads and edits the files inside it. You pick it here before starting the chat.'
    : 'Chat already started: the folder can no longer be changed. Open a new chat to work somewhere else.';
  $('cwdOpenRow').classList.toggle('hide', !chatHeader.canOpenFolder);
  $('explorerBtn').title = chatHeader.canOpenFolder
    ? `Open ${chatHeader.cwd}`
    : 'Opening folders is unavailable on this system';
  renderTray();
}

/* ---------------- web UI themes ---------------- */
// the three swatches of each card are the palette's --bg, --panel-3 and --teal,
// copied from the [data-theme] blocks in app.css: keep them in sync by hand
const THEMES = [
  { id: 'paseo', name: 'Paseo (light)', cols: ['#fdfaf6', '#f0e7da', '#d97757'] },
  { id: 'noir', name: 'Teal Noir', cols: ['#0b0d11', '#232833', '#2fe0c0'] },
  { id: 'violet', name: 'Violet Dusk', cols: ['#0b0814', '#292244', '#a78bfa'] },
  { id: 'ember', name: 'Ember', cols: ['#0e0a06', '#302317', '#fb923c'] },
  { id: 'nord', name: 'Nord Ice', cols: ['#0a0f17', '#243144', '#7dd3fc'] },
  { id: 'rose', name: 'Rosé', cols: ['#0f0812', '#2f1f38', '#f472b6'] },
  { id: 'graphite', name: 'Graphite', cols: ['#161616', '#303032', '#7dd3fc'] },
  { id: 'daylight', name: 'Daylight (light)', cols: ['#ffffff', '#eaedf3', '#0d9488'] },
];
// applied when localStorage has no theme yet; an already saved theme is left alone
const DEFAULT_THEME = 'paseo';
// accent override on top of any theme: only colours the themes already use
const ACCENTS = [
  { id: '', name: 'Theme default', col: '' },
  { id: 'teal', name: 'Teal', col: '#2fe0c0' },
  { id: 'violet', name: 'Violet', col: '#a78bfa' },
  { id: 'orange', name: 'Orange', col: '#fb923c' },
  { id: 'blue', name: 'Blue', col: '#7dd3fc' },
  { id: 'rose', name: 'Rosé', col: '#f472b6' },
];
function applyAccent(id) {
  const v = ACCENTS.some((a) => a.id === id) ? id : '';
  if (v) document.documentElement.dataset.accent = v;
  else delete document.documentElement.dataset.accent;
  localStorage.setItem('piAccent', v);
  $$('.accentDot[data-a]').forEach((c) => c.classList.toggle('sel', c.dataset.a === v));
  terminalView.refreshTheme();   // the accent is the cursor colour of the terminals
}
applyAccent(localStorage.getItem('piAccent') || '');
function applyTheme(id) {
  document.documentElement.dataset.theme = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  localStorage.setItem('piTheme', document.documentElement.dataset.theme);
  $$('.themeCard[data-t]').forEach((c) => c.classList.toggle('sel', c.dataset.t === document.documentElement.dataset.theme));
  terminalView.refreshTheme();   // the open terminals follow the page
  const style = getComputedStyle(document.documentElement);
  win.desktopWindow?.setTitleBarTheme({
    background: style.getPropertyValue('--panel').trim(),
    foreground: style.getPropertyValue('--txt').trim(),
  });
}
applyTheme(localStorage.getItem('piTheme') || DEFAULT_THEME);

/* ---------------- views ---------------- */
const agentInputs = createAgentInputs({
  escapeHtml: esc,
  post,
  sendJson,
  toast,
  getPlatformCapabilities: () => platformCaps,
});
const {
  inputKind: bootstrapInputKind,
  fileEditor: bootstrapFileEditor,
  promptPreview: bootstrapPromptPreview,
  resourceList: bootstrapResourceList,
  bindFileActions: bindBootstrapFileActions,
} = agentInputs;

async function renderProjectBootstrapMenu() {
  const menu = $('projectBootstrapMenu');
  const key = activeChatKey();
  if (!key) {
    menu.innerHTML = '<div class="sys bootstrapEmpty">Open a chat to edit its project inputs.</div>';
    return;
  }
  menu.innerHTML = '<div class="sys bootstrapEmpty">Loading project inputs…</div>';
  const bootstrap = await api('/api/agent-bootstrap', undefined, { key, guardChat: true, followKey: false });
  if (bootstrap.error || key !== activeChatKey()) return;
  const files = bootstrap.files;
  const projectInputs = files.filter((file) => file.scope === 'project' && bootstrapInputKind(file)
    && ((file.exists && file.active) || file.prefilled));
  const projectResources = files.filter((file) => file.exists && file.active && file.scope !== 'global');
  const globalTargets = files.filter((file) => file.target && file.scope === 'global');
  const editors = projectInputs.map((file) => {
    const kind = bootstrapInputKind(file);
    const global = globalTargets.find((target) => target.kinds.includes(kind));
    return bootstrapFileEditor(file, {
      saveLabel: 'Save for this project',
      promoteId: global?.id,
      removable: Boolean(file.target && file.scope === 'project'),
    });
  }).join('');
  menu.innerHTML = `
    <div class="projectBootstrapHead"><b>Project agent input</b><code title="${esc(bootstrap.cwd)}">${esc(bootstrap.cwd)}</code></div>
    <div class="projectBootstrapScroll">
      ${bootstrapPromptPreview(bootstrap.effectivePrompt)}
      ${editors || '<div class="sys bootstrapEmpty">No project-specific instruction file is currently passed to the agent.</div>'}
      <div class="bootstrapCatalogHead"><b>Loaded project resources (${projectResources.length})</b><span class="sys">Always visible</span></div>
      <div class="bootstrapResourceList">${bootstrapResourceList(projectResources)}</div>
    </div>
    <div class="bootstrapActions projectBootstrapFoot">
      <button class="btn outline" id="projectBootstrapReload">Reload for the next turn</button>
      <span class="sys" id="projectBootstrapMessage"></span>
    </div>`;
  bindBootstrapFileActions(menu, { key, refresh: renderProjectBootstrapMenu });
  $('projectBootstrapReload').addEventListener('click', async () => {
    const button = $('projectBootstrapReload');
    button.disabled = true;
    const result = await post('/api/agent-bootstrap/reload', {}, { key, followKey: false });
    button.disabled = false;
    $('projectBootstrapMessage').textContent = result.error ? result.error : 'Reloaded';
    if (!result.error) await renderProjectBootstrapMenu();
  });
}

const settingsController = createSettingsView({
  api,
  post,
  sendJson,
  escapeHtml: esc,
  formatNumber: fmt,
  formatMoney: money,
  applyPlatformCapabilities,
  applyChatArchiving,
  getChatArchiving: () => chatArchiving,
  loadSessions,
  refreshUsage,
  selectModel,
  loadModels,
  applyTheme,
  applyAccent,
  applyLogoStyle,
  themes: THEMES,
  accents: ACCENTS,
  logoStyles: LOGO_STYLES,
  agentInputs,
  getRenderedChatKey: () => renderedChatKey,
  setSidebarCollapsed,
});

async function showChat() {
  const tabId = uiState.activeTabId;
  const current = uiState.selection;
  if (current?.tabId === tabId && current.view === VIEW_CHAT && isNavigationSelectionAvailable(current)) {
    return loadOpenChat(navigation.transition(current));
  }
  const sessionState = renderedChatKey ? uiState.chats.get(renderedChatKey) : null;
  const project = uiState.projects.get(tabId);
  if (sessionState && project
      && (!project.cwd || sessionState.cwd.toLowerCase() === project.cwd.toLowerCase())) {
    return loadOpenChat(navigation.transition({ tabId, view: VIEW_CHAT, resourceId: renderedChatKey }));
  }
  const fallback = fallbackSelectionForTab(tabId);
  if (fallback?.view === VIEW_CHAT) return loadOpenChat(navigation.transition(fallback));
  else newChat({ tabId });
}
function showSettings() {
  navigation.settings();
}
function renderNavigationSelection(selection) {
  if (selection.view !== VIEW_SETTINGS) settingsController.hide();
  renderContextHeader(selection);
  if (selection.view === VIEW_CHAT) {
    // Navigation commits before openSession starts HTTP. This call parks the
    // previous DOM and restores the selected chat's cached snapshot in the
    // same synchronous turn, so old content is never shown under a new header.
    renderChatView(); // scroll restoration needs a laid-out container
    navigationSync.show(selection);
    renderCachedChatState();
    renderProjectScope(projectScopeForChat(selection.resourceId));
    connect(selection.resourceId);
  } else {
    parkChatView(renderedChatKey);
    transport.closeDetailed();
  }
  saveProjTabs();
  renderProjTabs();
  renderSessions();
  terminalView.render();
  if (selection.view === VIEW_TERMINAL) terminalView.show(selection.resourceId);
  else if (selection.view === VIEW_SETTINGS) renderSettingsView();
}
function renderCachedChatState() {
  renderContextHeader();
  renderModelBtn();
  renderThinking();
  renderStats();
  setRunning(activeChatState().streaming);
  chatView.renderQueuedPrompts(activeChatState().queuedPrompts);
  syncTasks();
  renderUsageWidget();
}
function renderChatView() {
  $('chatView').classList.remove('hide');
  $('settingsView').classList.add('hide');
  terminalView.hide();
  $('navChat').classList.add('on');
  $('navSettings').classList.remove('on');
  $('navDiff').classList.remove('hide');
  $('navTasks').classList.remove('hide');
  $('sidebar').classList.remove('mode-settings');   // the sidebar goes back to the chats
}
function renderSettingsView() {
  $('chatView').classList.add('hide');
  $('settingsView').classList.remove('hide');
  terminalView.hide();
  $('navChat').classList.remove('on');
  $('navSettings').classList.add('on');
  // in settings the diff/tasks panels make no sense: close them and hide the buttons
  $('diffClose').click();
  $('tasksClose').click();
  $('navDiff').classList.add('hide');
  $('navTasks').classList.add('hide');
  $('sidebar').classList.add('mode-settings');      // the sidebar shows the sections
  settingsController.show();
}

$('navChat').addEventListener('click', showChat);
$('navSettings').addEventListener('click', showSettings);




/* ---------------- attachments (picker + paste + drag&drop) ---------------- */
let pending = [];
const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|log|html?|css|scss|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|sql|xml|svg|vue|svelte|env|gitignore|dockerfile)$/i;
function renderAttachments() {
  const el = $('attachments');
  el.innerHTML = '';
  pending.forEach((a, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = a.kind === 'image'
      ? `<img src="${a.url}" alt="${esc(a.name)}">`
      : `<div class="file"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span></div>`;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
    x.addEventListener('click', () => { pending.splice(i, 1); renderAttachments(); });
    t.appendChild(x);
    el.appendChild(t);
  });
}
function addFiles(files, ownerKey = activeChatKey() ?? renderedChatKey) {
  if (!ownerKey) return;
  const entry = uiState.chatViewState(ownerKey);
  const reader = () => {
    const r = new FileReader();
    r.onloadend = chatCache.addCleanup(entry.key, () => {
      r.onload = r.onloadend = r.onerror = null;
      if (r.readyState === FileReader.LOADING) r.abort();
    });
    r.onerror = () => toast('Could not read attachment');
    return r;
  };
  const append = (attachment) => {
    if (chatCache.peek(entry.key) !== entry) return;
    const attachments = entry.composer.attachments;
    attachments.push(attachment);
    if (entry.key === activeChatKey()) {
      pending = attachments;
      renderAttachments();
    }
  };
  for (const file of files) {
    if (!file) continue;
    if (file.type.startsWith('image/')) {
      const r = reader();
      r.onload = () => {
        const url = String(r.result);
        append({ kind: 'image', name: file.name || 'image', url, data: url.split(',')[1], mimeType: file.type });
      };
      r.readAsDataURL(file);
    } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || !file.type) {
      if (file.size > 512 * 1024) { toast(`${file.name}: too large (max 512 KB)`); continue; }
      const r = reader();
      r.onload = () => append({ kind: 'file', name: file.name, text: String(r.result) });
      r.readAsText(file);
    } else toast(`${file.name}: unsupported type`);
  }
}
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile());
  if (files.length) { e.preventDefault(); addFiles(files); }
});
// window-wide drag & drop; overlay can never get stuck and block clicks
let dragDepth = 0;
const dropOff = () => { dragDepth = 0; $('drop').classList.remove('on'); };
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').classList.add('on'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) dropOff(); });
window.addEventListener('dragend', dropOff);
window.addEventListener('blur', dropOff);
window.addEventListener('drop', (e) => {
  dropOff();
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  showChat();
  addFiles([...e.dataTransfer.files]);
  $('input').focus();
});

/* ---------------- "/" slash commands: extension commands, prompt templates, skills ---------------- */
let commandsLoaded = false;
let commandsLoading = null;
const commandsCache = () => uiState.global.commands;
async function loadCommands({ force = false } = {}) {
  if (!force && commandsLoaded) return uiState.global.commands;
  if (!force && commandsLoading) return commandsLoading;
  const loading = (async () => {
    const r = await api('/api/commands', undefined, { key: null, followKey: false });
    if (r.error) return null;
    const payload = uiState.applyCommandsPayload(r);
    commandsLoaded = true;
    return payload.commands;
  })();
  commandsLoading = loading;
  try { return await loading; }
  finally { if (commandsLoading === loading) commandsLoading = null; }
}
const CMD_SOURCE_LABEL = { extension: 'extension', prompt: 'prompt', skill: 'skill' };
let cmdMenuOpen = false, cmdMenuItems = [], cmdMenuIndex = 0, cmdMenuRange = null;
// A slash command can start any word, not only a line. The query ends at the
// caret while the replacement range extends through the whole command token,
// preserving prose on both sides when the caret sits inside an existing word.
function slashToken() {
  const el = $('input');
  const v = el.value, pos = el.selectionStart;
  if (pos !== el.selectionEnd) return null;
  const match = /(^|\s)\/([a-zA-Z0-9_:.-]*)$/.exec(v.slice(0, pos));
  if (!match) return null;
  const start = match.index + match[1].length;
  let end = pos;
  while (end < v.length && /[a-zA-Z0-9_:.-]/.test(v[end])) end += 1;
  return { query: match[2].toLowerCase(), start, end };
}
function updateCmdMenu() {
  const tok = slashToken();
  const commands = commandsCache();
  if (!tok || !commands.length) { closeCmdMenu(); return; }
  cmdMenuRange = tok;
  cmdMenuItems = commands
    .filter((c) => c.name.toLowerCase().includes(tok.query))
    .sort((a, b) => a.name.toLowerCase().indexOf(tok.query) - b.name.toLowerCase().indexOf(tok.query))
    .slice(0, 30);
  if (!cmdMenuItems.length) { closeCmdMenu(); return; }
  cmdMenuIndex = 0;
  renderCmdMenu();
  openCmdMenu();
}
function renderCmdMenu() {
  const el = $('cmdMenu');
  el.innerHTML = cmdMenuItems.map((c, i) => `
    <button type="button" class="dd-item cmdItem${i === cmdMenuIndex ? ' sel' : ''}" data-i="${i}">
      <span class="col">
        <span>/${esc(c.name)}${c.argumentHint ? ' <span class="sub">' + esc(c.argumentHint) + '</span>' : ''}</span>
        ${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}
      </span>
      <span class="sub">${esc(CMD_SOURCE_LABEL[c.source] ?? c.source)}</span>
    </button>`).join('');
  el.querySelectorAll('.cmdItem').forEach((b) => {
    // mousedown (not click): fires before the textarea blur that a click would cause
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickCmd(+b.dataset.i); });
  });
}
function openCmdMenu() { $('cmdMenu').classList.add('show'); cmdMenuOpen = true; }
function closeCmdMenu() { $('cmdMenu').classList.remove('show'); cmdMenuOpen = false; cmdMenuItems = []; }
function pickCmd(i) {
  const c = cmdMenuItems[i];
  if (!c || !cmdMenuRange) return;
  const { start, end } = cmdMenuRange;
  const v = input.value;
  const insert = '/' + c.name + (end === v.length ? ' ' : '');
  input.value = v.slice(0, start) + insert + v.slice(end);
  input.selectionStart = input.selectionEnd = start + insert.length;
  updateComposerDraft(activeChatKey(), input.value);
  closeCmdMenu();
  autoGrow();
  input.focus();
}

/* ---------------- composer (Enter = new line, Ctrl+Enter = send) ---------------- */
const input = $('input');
// the composer follows the text instead of scrolling inside a fixed box: the
// scrollbar only appears once the textarea would eat the chat (40% of viewport)
function autoGrow() {
  const cap = Math.round(window.innerHeight * 0.4);
  input.style.height = 'auto';
  const h = Math.min(input.scrollHeight, cap);
  input.style.height = h + 'px';
  input.classList.toggle('scroll', input.scrollHeight > cap);
}
let composerLayoutFrame = null;
function scheduleComposerLayout() {
  if (composerLayoutFrame !== null) return;
  composerLayoutFrame = requestAnimationFrame(() => {
    composerLayoutFrame = null;
    autoGrow();
    updateCmdMenu();
  });
}
window.addEventListener('resize', scheduleComposerLayout);
input.addEventListener('input', () => {
  updateComposerDraft(activeChatKey(), input.value);
  scheduleComposerLayout();
});
input.addEventListener('click', updateCmdMenu);
input.addEventListener('blur', () => setTimeout(closeCmdMenu, 150));
let composerSubmitting = false;
function setComposerSubmitting(value) {
  composerSubmitting = value;
  $('sendBtn').disabled = value;
  $('queueActions').querySelectorAll('button').forEach((button) => { button.disabled = value; });
}
function clearAcceptedComposer(entry, draft, attachments) {
  if (entry.composer.draft === draft) storeComposerDraft(entry.key, '');
  const sent = new Set(attachments);
  entry.composer.attachments = entry.composer.attachments.filter((attachment) => !sent.has(attachment));
  if (entry.key !== activeChatKey()) return;
  input.value = entry.composer.draft;
  pending = entry.composer.attachments;
  autoGrow();
  renderAttachments();
}
async function submitPrompt(queueType = null) {
  if (composerSubmitting) return;
  closeCmdMenu();
  const key = activeChatKey();
  if (!key) return;
  const entry = uiState.chatViewState(key);
  const draft = input.value;
  const text = draft.trim();
  const attachments = [...pending];
  if (!text && !attachments.length) return;
  storeComposerDraft(key, draft);
  entry.composer.attachments = pending;

  const images = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => ({ data: attachment.data, mimeType: attachment.mimeType }));
  let payload = text;
  for (const attachment of attachments.filter((item) => item.kind === 'file')) {
    payload += `\n\n--- attached file: ${attachment.name} ---\n\`\`\`\n${attachment.text}\n\`\`\``;
  }
  const anchor = chatView.capturePromptAnchor();
  setComposerSubmitting(true);
  try {
    const body = { text: payload, images };
    if (queueType) body.type = queueType;
    const result = await post('/api/prompt', body, { key, guardChat: true });
    if (result.error) return;

    const chatState = uiState.chatState(entry.key);
    // HTTP confirms acceptance, not current queue membership. A newer SSE
    // dispatch/cancel may already have removed this item before HTTP arrives.
    if (!result.queued) {
      chatState.started = true;
      const current = entry.composer.metadata;
      chatCache.setMetadata(entry.key, {
        cwd: chatState.cwd,
        title: current?.title || draftTitle(text),
        modified: current?.modified ?? new Date().toISOString(),
        pending: !allSessions.some((session) => session.path === entry.key),
      });
    }
    clearAcceptedComposer(entry, draft, attachments);
    renderSessions();
    if (result.queued) return;
    if (entry.key === activeChatKey() && entry.key === renderedChatKey) {
      chatView.insertAcceptedUserTurn(text, attachments, anchor);
      // Lifecycle comes from status/state, not this possibly late HTTP ack.
    }
  } finally {
    setComposerSubmitting(false);
  }
}
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  submitPrompt(activeChatState().streaming ? 'steer' : null);
});
$('queueActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-queue-type]');
  if (button) submitPrompt(button.dataset.queueType);
});
input.addEventListener('keydown', (e) => {
  if (cmdMenuOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdMenuIndex = (cmdMenuIndex + 1) % cmdMenuItems.length; renderCmdMenu(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cmdMenuIndex = (cmdMenuIndex - 1 + cmdMenuItems.length) % cmdMenuItems.length; renderCmdMenu(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickCmd(cmdMenuIndex); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeCmdMenu(); return; }
  }
  if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); return; }
  // "* " at the start of a line becomes a real bullet point "• "
  if (e.key === ' ') {
    const { value, selectionStart, selectionEnd } = input;
    if (selectionStart === selectionEnd) {
      const before = value.slice(0, selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const line = before.slice(lineStart);
      if (/^\s*\*$/.test(line)) {
        e.preventDefault();
        const rep = line.slice(0, -1) + '• ';
        input.value = value.slice(0, lineStart) + rep + value.slice(selectionStart);
        input.selectionStart = input.selectionEnd = lineStart + rep.length;
        updateComposerDraft(activeChatKey(), input.value);
        autoGrow();
      }
    }
    return;
  }
  // Enter inside a list: continues the list (bullet or incremented number);
  // Enter on an empty item: leaves the list
  if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && continueList()) e.preventDefault();
});
function continueList() {
  const { value, selectionStart, selectionEnd } = input;
  if (selectionStart !== selectionEnd) return false;
  const before = value.slice(0, selectionStart);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const m = line.match(/^(\s*)(•|[-+*]|(\d+)([.)]))(\s+)(.*)$/);
  if (!m) return false;
  const [, indent, marker, num, punc, ws, content] = m;
  const rest = value.slice(selectionStart);
  if (!content.trim()) {
    // empty item: drop the marker and stay on a clean line
    input.value = value.slice(0, lineStart) + rest;
    input.selectionStart = input.selectionEnd = lineStart;
    updateComposerDraft(activeChatKey(), input.value);
    autoGrow();
    return true;
  }
  const next = num ? String(Number(num) + 1) + (punc || '.') : marker;
  const insert = '\n' + indent + next + ws;
  input.value = before + insert + rest;
  input.selectionStart = input.selectionEnd = before.length + insert.length;
  updateComposerDraft(activeChatKey(), input.value);
  autoGrow();
  return true;
}

/* ---------------- image lightbox ----------------
   Images in the chat are thumbnails: a click opens them full screen, the ✕
   (or Esc / a click on the backdrop) closes them. */
function openLightbox(src, alt = '') {
  $('lightboxImg').src = src;
  $('lightboxImg').alt = alt;
  $('lightbox').classList.add('on');
}
function closeLightbox() {
  $('lightbox').classList.remove('on');
  $('lightboxImg').src = '';
}
$('lightboxClose').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

/* ---------------- shortcuts panel (Shift held down) ---------------- */
/** @type {[keys: string[], description: string][]} */
const SHORTCUTS = [
  [['Ctrl', 'Enter'], 'Send the message'],
  [['Enter'], 'New line in the message'],
  [[MOD, 'M'], 'Switch model (cycle)'],
  [[MOD, 'E'], 'Switch reasoning level'],
  [[MOD, 'P'], 'Switch chat (sidebar order)'],
  [[MOD, 'T'], 'Switch project tab'],
  [[MOD, 'W'], 'Close project tab'],
  [[MOD, 'N'], 'New chat'],
  [[MOD, 'S'], 'Open settings'],
  [['/'], 'Command palette in the composer'],
  [['Ctrl', 'click'], 'Open a chat in a new tab'],
  [['Esc'], 'Close menu, image or panel'],
  [['Shift', '(1.3s)'], 'Show this panel'],
  [['double click'], 'Sidebar edge: default width'],
];
$('shortcutsGrid').innerHTML = SHORTCUTS.map(([keys, d]) =>
  `<div class="sc"><span class="keys">${keys.map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span><span class="d">${esc(d)}</span></div>`).join('');
let shiftTimer = null;
const showShortcuts = (on) => $('shortcuts').classList.toggle('on', on);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') {
    if (e.repeat || shiftTimer) return;
    shiftTimer = setTimeout(() => showShortcuts(true), 1300);
    return;
  }
  // another key was pressed (= you are using a shortcut): the panel gets out of
  // the way at once, so you can see the effect of what you launched
  clearShift();
}, true);
const clearShift = () => { clearTimeout(shiftTimer); shiftTimer = null; showShortcuts(false); };
document.addEventListener('keyup', (e) => { if (e.key === 'Shift') clearShift(); });
window.addEventListener('blur', clearShift);
// Esc closes, in order, the shortcuts panel, the lightbox and the dropdowns
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('shortcuts').classList.contains('on')) { clearShift(); return; }
  if ($('lightbox').classList.contains('on')) { closeLightbox(); return; }
  closeFlyouts();
  document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
});

/* ---------------- global keyboard shortcuts ---------------- */
document.addEventListener('keydown', (e) => {
  // Ctrl+Enter: send the message from anywhere on the page
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') {
    if (input.value.trim() || pending.length) { e.preventDefault(); $('composer').requestSubmit(); }
    return;
  }
  if (!hasMod(e)) return;
  const target = /** @type {any} */ (e.target);
  const tag = (target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  // Shift+letter types a capital letter, Ctrl+letter does not: only the browser
  // binding has to keep its hands off the keyboard while you write.
  if (typing && !IS_ELECTRON) return;
  switch (e.key.toLowerCase()) {
    case 'm': e.preventDefault(); cycleModel(); break;          // cycle models
    case 'e': e.preventDefault(); cycleThinking(); break;       // cycle effort
    case 'p': e.preventDefault(); cycleChat(); break;           // cycle sidebar chats
    case 't': e.preventDefault(); cycleProjTab(); break;        // cycle project tabs
    case 'w': e.preventDefault(); closeCurrentProjTab(); break; // close project tab
    case 's': e.preventDefault(); showSettings(); break;        // settings
    case 'n': e.preventDefault(); newChat(); break;             // new chat
  }
});
$('abort').addEventListener('click', async () => {
  // Keep the run visible until the server confirms agent_end. The abort
  // request being accepted does not itself mean the agent has stopped yet.
  await post('/api/abort');
});
const STOPPED_PAGE = '<div style="margin:auto;padding:40px;text-align:center;color:#8d97a8">pi desktop ui server stopped.<br><br>Start it again with <code>npm start</code>.</div>';
$('quit').addEventListener('click', async () => {
  if (!confirm('Shut down the pi desktop ui server?\nThis page will stop working until you start it again with `npm start`.')) return;
  if (!await askToStop('/api/shutdown')) return;
  document.body.innerHTML = STOPPED_PAGE;
});
// POST to a route that stops the server, with the confirmation the server asks
// for when there is work it would interrupt: chats mid-turn, open terminals.
// The counts are the server's — this page only knows what it last saw.
// Answers `null` when the user backed out: nothing was stopped and the page
// must stay exactly as it is.
async function askToStop(route) {
  for (const force of [false, true]) {
    let payload = {};
    let status = 0;
    try {
      const r = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      status = r.status;
      payload = await r.json().catch(() => ({}));
    } catch { /* no answer at all: assume it is coming back, as before */ }
    if (status === 409 && payload?.error?.code === 'work_in_progress') {
      const err = errorInfo(payload, 'this will stop the work in progress');
      if (!confirm(`${err.message}.\nContinue?`)) return null;
      continue;
    }
    return payload;
  }
  return null;
}
$('restartBtn').addEventListener('click', async () => {
  if (!confirm('Restart the pi desktop ui server?\nThe chat stays saved; the page reloads by itself as soon as the server is ready again.')) return;
  // Only the desktop shell restarts the server in place. Started from the
  // terminal it stops for good and says so with `restarting: false`: waiting
  // for it to come back would leave this page spinning on a dead server.
  const answer = await askToStop('/api/restart');
  if (!answer) return;
  const restarting = answer.restarting !== false;
  if (!restarting) {
    document.body.innerHTML = STOPPED_PAGE;
    return;
  }
  document.body.innerHTML = '<div style="margin:auto;padding:40px;text-align:center;color:#8d97a8">Restarting pi desktop ui…<br><br>The page will reload by itself.</div>';
  // poll until the new process answers, then reload
  const wait = setInterval(async () => {
    try {
      const r = await fetch('/api/state');
      if (r.ok) { clearInterval(wait); location.reload(); }
    } catch { /* server still down: keep trying */ }
  }, 700);
  setTimeout(() => clearInterval(wait), 30000);
});

/* ---------------- git status (branch + pending changes) ---------------- */
const gitRefreshes = new Map();
async function refreshGit({ key = activeChatKey() ?? renderedChatKey, projectCwd = projectScopeForChat(key)?.cwd, force = false } = {}) {
  if (!key || !projectCwd || !isProjectScopeActive(projectCwd)) return;
  const owner = uiState.projectState(projectCwd);
  const cached = gitRefreshes.get(owner.cwd);
  if (force && cached) cached.at = 0;
  if (document.hidden) return;
  if (cached?.pending) {
    await cached.pending;
    if (force && !cached.forced) return refreshGit({ key, projectCwd, force: true });
    return;
  }
  if (!force && cached && Date.now() - cached.at < 30_000) return;
  const entry = { at: cached?.at ?? 0, pending: null, forced: force };
  const pending = (async () => {
    const g = await api(force ? '/api/git?force=1' : '/api/git', undefined, {
      key,
      guard: () => isProjectScopeActive(owner.cwd),
    });
    if (g.error) return;
    owner.git = g;
    entry.at = Date.now();
    if (isProjectScopeActive(owner.cwd)) renderGit(owner);
  })();
  entry.pending = pending;
  gitRefreshes.set(owner.cwd, entry);
  try { await pending; }
  finally { entry.pending = null; }
}
function renderGit(scope = activeProjectScope()) {
  const git = scope?.git;
  const chip = $('gitChip');
  const dd = $('gitDd');
  renderTray(); // the tray shows the same branch, also when there is no repo
  if (!git?.repo) { dd.classList.add('hide'); return; }
  dd.classList.remove('hide');
  $('gitBranch').textContent = git.branch;
  const n = git.changed ?? 0;
  const count = $('gitCount');
  count.textContent = n;
  count.classList.toggle('hide', !n);
  count.classList.toggle('warn', (git.staged ?? 0) > 0);
  const sync = [];
  if (git.ahead) sync.push(`↑ ${git.ahead} commits to push`);
  if (git.behind) sync.push(`↓ ${git.behind} commits to pull`);
  chip.title = `branch: ${git.branch}\n` +
    `pending changes: ${n} (staged ${git.staged} · unstaged ${git.unstaged} · new ${git.untracked})\n` +
    (sync.length ? sync.join(' · ') : 'in sync with the remote');
}

const gitDd = setupDd('gitDd', 'gitChip');
function renderGitMenu() {
  const git = activeProjectScope()?.git;
  const menu = $('gitMenu');
  menu.innerHTML = '<div class="dd-group">Switch branch</div>';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'dd-item';
  refresh.textContent = 'Refresh Git status';
  refresh.addEventListener('click', async () => {
    await refreshGit({ force: true });
    if (gitDd.classList.contains('open')) renderGitMenu();
  });
  menu.appendChild(refresh);
  for (const branch of git?.branches ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dd-item' + (branch === git.branch ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = branch;
    button.appendChild(name);
    button.disabled = branch === git.branch;
    button.addEventListener('click', async () => {
      gitDd.classList.remove('open');
      const result = await post('/api/git/branch', { branch }, { guardChat: true });
      if (result.error) return;
      await Promise.all([refreshGit({ force: true }), loadFiles()]);
      toast(`Switched to ${branch}`, true);
    });
    menu.appendChild(button);
  }
}
$('gitChip').addEventListener('click', () => {
  if (gitDd.classList.contains('open')) renderGitMenu();
});

/* ---------------- boot ---------------- */
async function loadState({ key = activeChatKey() ?? renderedChatKey, ticket = null } = {}) {
  const raw = await api('/api/state', undefined, {
    key, ticket,
    guard: () => !uiState.selection || activeChatKey() === key,
  });
  if (raw.error || (ticket && key !== activeChatKey())) return;
  const s = uiState.applyStatePayload(raw);
  selectCurrentChatState(s.key);
  applyPlatformCapabilities(uiState.global.platform);
  applyChatArchiving(uiState.global.chatArchiving);
  renderCachedChatState();
  renderProjectScope(projectScopeForChat(s.key));
}
async function loadInitialChat() {
  if (renderedChatKey) {
    restoreChatView(renderedChatKey);
    const restored = sessionForKey(renderedChatKey);
    if (restored?.local) return await openSession(restored);
  }
  connect();
  await loadState();
  return true;
}
(async () => {
  await loadInitialChat();
  // Global catalogs load once at bootstrap. Ordinary chat/tab switches only
  // synchronize the selected chat, its project and the global session list.
  await Promise.all([loadModels(), loadCommands(), loadRecentCwds()]);
  await loadSessions();
  await terminalView.load();
  await Promise.all([
    refreshChat(),
    loadFiles(),
    refreshGit(),
    refreshUsage(),
  ]);
})();
// safety net: if SSE dies the sidebar must never go stale
setInterval(() => {
  if (!document.hidden && transport.detailedReadyState() === 2) {
    transport.closeDetailed();
    connect();
  }
}, 5000);
// real account usage limits (claude.ai / kimi.com) — poll, don't hammer
setInterval(() => { if (!document.hidden) refreshUsage(); }, 30000);
// External edits are checked on return to the app, never on an idle timer.
window.addEventListener('focus', () => refreshGit());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshGit(); });
