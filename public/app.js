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
  projectTabId,
} from './ui-state.js';
import { createChatCache } from './chat-cache.js';
import {
  chatHeaderState,
  createNavigationController,
  createNavigationSynchronizer,
  terminalHeaderState,
} from './navigation.js';
import { createTransport, withSessionKey } from './transport.js';
import { providerIconHtml } from './provider-icons.js';

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
const chat = $('chat'), chatWrap = $('chatWrap');
let currentAssistant = null, currentThinking = null, currentTurn = null;

/* Text drafts survive a reload in sessionStorage. The bounded cache owns the
   live composer and view state; its persistence adapter deliberately receives
   only text, never attachment payloads. */
let persistedComposerDrafts = {};
try { persistedComposerDrafts = JSON.parse(sessionStorage.getItem('piComposerDrafts') || '{}'); } catch {}
function savePersistedComposerDrafts() {
  try { sessionStorage.setItem('piComposerDrafts', JSON.stringify(persistedComposerDrafts)); } catch {}
}
const chatCache = createChatCache({
  loadDraft: (key) => persistedComposerDrafts[key] ?? '',
  saveDraft: (key, draft) => {
    persistedComposerDrafts[key] = draft;
    savePersistedComposerDrafts();
  },
  removeDraft: (key) => {
    delete persistedComposerDrafts[key];
    savePersistedComposerDrafts();
  },
});
let persistedFormDrafts = {};
try { persistedFormDrafts = JSON.parse(sessionStorage.getItem('piFormDrafts') || '{}'); } catch {}
function savePersistedFormDrafts() {
  try { sessionStorage.setItem('piFormDrafts', JSON.stringify(persistedFormDrafts)); } catch {}
}
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
const activeTerminalId = () => uiState.selection?.view === VIEW_TERMINAL ? uiState.selection.resourceId : null;
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

function stashComposerDraft(key) {
  if (key) chatCache.setDraft(key, $('input').value);
}

if (win.marked) win.marked.setOptions({ breaks: true, gfm: true });
// DOMPurify's default URL policy deliberately drops file: and Windows-drive
// links. They are safe here because clicks never navigate this renderer: the
// delegated handler below sends them to the local-path endpoint instead.
const CHAT_URI_PATTERN = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[a-z]:%5c|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n ?? 0));
// amounts below $1 need 4 decimals to stay readable, above it 2 are enough
const money = (n) => { const v = n ?? 0; return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2)); };
const atBottom = () => chatWrap.scrollHeight - chatWrap.scrollTop - chatWrap.clientHeight < 90;
const scrollDown = () => { chatWrap.scrollTop = chatWrap.scrollHeight; };
function addChatListener(target, type, callback, options) {
  if (renderedChatKey) return chatCache.trackListener(renderedChatKey, target, type, callback, options);
  target.addEventListener(type, callback, options);
  return () => target.removeEventListener(type, callback, options);
}
function addChatTimer(callback, delay) {
  const ownerKey = renderedChatKey;
  let untrack = () => {};
  const id = setTimeout(() => { untrack(); callback(); }, delay);
  if (ownerKey) untrack = chatCache.trackTimer(ownerKey, id, clearTimeout);
  return id;
}

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
      signal: ticket?.signal ?? opts?.signal,
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
// A chat is identified by its session file path, so it has to be escaped before
// it can travel inside a URL path.
const sessionPath = (id, suffix) => `/api/sessions/${encodeURIComponent(id ?? '')}/${suffix}`;

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
const thinkDd = setupDd('thinkDd', 'thinkBtn');
const cwdDd = setupDd('cwdDd', 'cwdChip');
const projectBootstrapDd = setupDd('projectBootstrapDd', 'projectBootstrapBtn');
setupDd('statsDd', 'stats');
const termsDd = setupDd('termsDd', 'termsChip');
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

/* ---------------- chat rendering (everything left-aligned, no bubbles) ---------------- */
function renderMarkdown(div) {
  // The model's markdown can carry attacker-influenced content (files, tool
  // output, fetched pages): sanitize before it ever touches innerHTML.
  div.innerHTML = win.marked && win.DOMPurify
    ? win.DOMPurify.sanitize(win.marked.parse(div.dataset.raw ?? ''), { ALLOWED_URI_REGEXP: CHAT_URI_PATTERN })
    : esc(div.dataset.raw ?? '');
  if (win.hljs) $$('pre code', div).forEach((el) => win.hljs.highlightElement(el));
  addCopyButtons(div);
}

function isLocalLink(href) {
  if (!href || href.startsWith('#')) return false;
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch {}
  if (/^(https?|mailto):/i.test(decoded)) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(decoded) || /^file:/i.test(decoded) || /^[a-z]:[\\/]/i.test(decoded);
}

/* ---- copy-to-clipboard: whole messages and single code/context blocks ---- */
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_RUN = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_FORK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.3"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="12" r="2.3"/><path d="M6 8.3V15.7M8 7l7.5 3.5M8 17l7.5-3.5"/></svg>';
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text ?? '');
    if (btn) flashCopied(btn);
  } catch {
    toast('Copy failed (browser clipboard permissions)');
  }
}
function flashCopied(btn) {
  if (btn.dataset.flashing) return;
  btn.dataset.flashing = '1';
  const prev = btn.innerHTML;
  btn.innerHTML = ICON_CHECK;
  btn.classList.add('copied');
  addChatTimer(() => { btn.innerHTML = prev; btn.classList.remove('copied'); delete btn.dataset.flashing; }, 1200);
}
// wrap every <pre> (markdown code fences, tool request/output) in a box with a
// floating copy button. The wrapper sits *outside* the <pre>, so re-rendering
// the pre's content (streaming tool output, incremental markdown) never wipes
// the button — only run once per <pre> (guarded by the wrapper check).
function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('codeBox')) return;
    const wrap = document.createElement('div');
    wrap.className = 'codeBox';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'codeCopyBtn';
    btn.title = 'Copy';
    btn.innerHTML = ICON_COPY;
    wrap.appendChild(btn);
    addRunButton(wrap, pre);
  });
}
// ▶ next to the copy button, but only on blocks that really look like a command
// to paste in a shell: one line, and either no language or a shell one. On a
// Python snippet or a diff the triangle would be a lie.
const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps', 'ps1', 'pwsh', 'cmd', 'bat'];
function shellCommandOf(pre) {
  const codeEl = pre.querySelector('code');
  const text = (codeEl ? codeEl.innerText : pre.innerText).trim();
  if (!text || text.includes('\n')) return null;
  if (text.length > 2000) return null;
  const lang = [...(codeEl?.classList ?? [])]
    .map((c) => c.replace(/^(language|lang)-/, ''))
    .find((c) => c !== 'hljs' && c !== '');
  if (lang && !SHELL_LANGS.includes(lang.toLowerCase())) return null;
  return text;
}
function addRunButton(wrap, pre) {
  if (!platformCaps?.typeInTerminal) return;
  const cmd = shellCommandOf(pre);
  if (!cmd) return;
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'codeRunBtn';
  run.title = 'Open a terminal with this command typed in — it is not executed';
  run.innerHTML = ICON_RUN;
  run.dataset.command = cmd;
  wrap.appendChild(run);
}
// hover toolbar under a turn: copy the whole message, or fork a new chat that
// starts from exactly this point (native SessionManager branch extraction).
/**
 * @param {any} body row the toolbar is appended to
 * @param {any} div message element the actions read their text from
 * @param {{ entryId?: string }} [opts] entry to fork from, when the turn has one
 */
function addMsgActions(body, div, { entryId } = {}) {
  const bar = document.createElement('div');
  bar.className = 'msgActions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msgActionBtn';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = ICON_COPY;
  addChatListener(copyBtn, 'click', () => copyToClipboard(div.dataset.raw ?? div.textContent, copyBtn));
  bar.appendChild(copyBtn);
  if (entryId) {
    const forkBtn = document.createElement('button');
    forkBtn.type = 'button';
    forkBtn.className = 'msgActionBtn';
    forkBtn.title = 'New chat from here';
    forkBtn.innerHTML = ICON_FORK;
    addChatListener(forkBtn, 'click', () => forkFrom(entryId));
    bar.appendChild(forkBtn);
  }
  body.appendChild(bar);
}
async function forkFrom(entryId) {
  const key = activeChatKey();
  const r = await post(sessionPath(key, 'fork'), { entryId }, { key, guardChat: true, followKey: false });
  if (r.error || key !== activeChatKey()) return;
  const fork = uiState.chatState(r.key);
  fork.cwd = r.cwd ?? uiState.chatState(key).cwd;
  const ticket = navigation.transition({
    tabId: uiState.activeTabId,
    view: VIEW_CHAT,
    resourceId: r.key,
  });
  await loadOpenChat(ticket);
  toast('New chat created from this point', true);
}
function newTurn(role, model = null) {
  $('hero')?.remove();
  setHeroMode(false);
  // Consecutive messages from the same speaker (same model, for the assistant)
  // stay in the same turn: avatar and name show up once, until the other side
  // answers.
  const ghosts = chat.querySelector('.queuedPrompts');
  const last = ghosts ? ghosts.previousElementSibling : chat.lastElementChild;
  if (last?.classList.contains('turn') && last.classList.contains(role)) {
    const m = role === 'user' ? null : (model ?? activeChatState().turnModel ?? activeChatState().model);
    const sig = role === 'user' ? 'user' : `${m?.provider ?? ''}/${m?.id ?? m?.model ?? ''}`;
    if (last.dataset.sig === sig) return last.querySelector('.body');
  }
  const t = document.createElement('div');
  t.className = 'turn ' + role;
  if (role === 'user') {
    t.dataset.sig = 'user';
    t.innerHTML = '<div class="body"></div>';
  } else {
    // the assistant turn is labeled with the model that produced it (it can
    // change mid-chat): provider logo as avatar + model name instead of "pi"
    const m = model ?? activeChatState().turnModel ?? activeChatState().model;
    const pid = m?.provider ?? '';
    const mid = m ? (m.id ?? m.model ?? '') : '';
    const pretty = m?.name || modelsCache().find((x) => x.provider === pid && x.id === mid)?.name || mid;
    t.dataset.sig = `${pid}/${mid}`;
    t.innerHTML = m
      ? `<div class="body"><div class="who" title="${esc(pid)}/${esc(mid)}">${esc(pretty)} <span class="mprov">${esc(pid)}</span></div></div>`
      : '<div class="body"><div class="who">pi</div></div>';
  }
  chat.insertBefore(t, ghosts);
  return t.querySelector('.body');
}
function skillInvocationFromCommand(text, knownCommands = null) {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  if (Array.isArray(knownCommands)
      && !knownCommands.some((command) => command.source === 'skill' && command.name === `skill:${match[1]}`)) {
    return null;
  }
  return { type: 'skill', name: match[1], arguments: match[2]?.trim() ?? '' };
}
function skillInvocationText(skill) {
  return [`/skill:${skill.name}`, skill.arguments].filter(Boolean).join(' ');
}
function skillInvocationElement(skill) {
  const div = document.createElement('div');
  div.className = 'msg user skillInvocation';
  div.dataset.raw = skillInvocationText(skill);
  const name = document.createElement('span');
  name.className = 'skillName';
  name.textContent = `/skill:${skill.name}`;
  div.appendChild(name);
  if (skill.arguments) {
    const args = document.createElement('span');
    args.className = 'skillArguments';
    args.textContent = skill.arguments;
    div.appendChild(args);
  }
  return div;
}
// Every live transcript mutation shares one rule: measure before changing the
// DOM, then follow the new bottom only when the reader was already there.
function mutateTranscript(mutate) {
  const stick = atBottom();
  const result = mutate();
  if (stick) scrollDown();
  return result;
}
function bubble(cls, text = '', body = null) {
  return mutateTranscript(() => {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (cls === 'assistant') { div.classList.add('md'); div.dataset.raw = text; renderMarkdown(div); }
    else div.textContent = text;
    (body ?? newTurn(cls === 'user' ? 'user' : 'pi')).appendChild(div);
    return div;
  });
}
function appendMd(div, delta) {
  mutateTranscript(() => {
    div.dataset.raw = (div.dataset.raw ?? '') + delta;
    renderMarkdown(div);
  });
}
function appendText(div, delta) {
  mutateTranscript(() => { div.textContent += delta; });
}
/* ---- tool calls: expandable card showing exactly what the model is doing ---- */
const toolCards = new Map(); // toolCallId -> element

function formResult(output) {
  try {
    const parsed = JSON.parse(output ?? '');
    return parsed?.status === 'submitted' && parsed.values && typeof parsed.values === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function formControls(card, fieldId) {
  return $$('[data-form-field]', card).filter((control) => control.dataset.formField === fieldId);
}

function setInteractiveFormValues(card, definition, values) {
  for (const field of definition.fields ?? []) {
    const controls = formControls(card, field.id);
    const value = values?.[field.id];
    if (field.type === 'checkbox') {
      if (controls[0]) controls[0].checked = value === true;
    } else if (field.type === 'multiselect') {
      const selected = new Set(Array.isArray(value) ? value : []);
      controls.forEach((control) => { control.checked = selected.has(control.value); });
    } else if (field.type === 'radio') {
      controls.forEach((control) => { control.checked = control.value === value; });
    } else if (controls[0]) {
      controls[0].value = value ?? '';
    }
  }
}

function finishInteractiveForm(card, definition, { values = null, error = false } = {}) {
  if (values) setInteractiveFormValues(card, definition, values);
  card.classList.toggle('submitted', !!values && !error);
  card.classList.toggle('formError', error);
  const fieldset = card.querySelector('.formFields');
  if (fieldset) fieldset.disabled = true;
  const button = card.querySelector('.formSubmit');
  if (button) button.disabled = true;
  const status = card.querySelector('.formStatus');
  if (status) status.textContent = error ? 'Unavailable' : 'Submitted';
  if (card.dataset.draftKey) {
    delete persistedFormDrafts[card.dataset.draftKey];
    savePersistedFormDrafts();
  }
}

function optionControl(field, option, inputType) {
  const label = document.createElement('label');
  label.className = 'formOption';
  const input = document.createElement('input');
  input.type = inputType;
  input.name = field.id;
  input.value = option.value;
  input.dataset.formField = field.id;
  input.required = inputType === 'radio' && !!field.required;
  const copy = document.createElement('span');
  copy.className = 'formOptionCopy';
  const name = document.createElement('span');
  name.className = 'formOptionLabel';
  name.textContent = option.label;
  copy.appendChild(name);
  if (option.description) {
    const description = document.createElement('span');
    description.className = 'formOptionDescription';
    description.textContent = option.description;
    copy.appendChild(description);
  }
  label.append(input, copy);
  return label;
}

let formControlSequence = 0;
function interactiveFormField(field) {
  const row = document.createElement(field.type === 'radio' || field.type === 'multiselect' ? 'fieldset' : 'div');
  row.className = 'formField';
  const label = document.createElement(field.type === 'radio' || field.type === 'multiselect' ? 'legend' : 'label');
  label.className = 'formLabel';
  label.textContent = field.label;
  if (field.required) {
    const required = document.createElement('span');
    required.className = 'formRequired';
    required.textContent = 'Required';
    label.appendChild(required);
  }
  row.appendChild(label);
  if (field.description) {
    const description = document.createElement('div');
    description.className = 'formHint';
    description.textContent = field.description;
    row.appendChild(description);
  }
  if (field.type === 'radio' || field.type === 'multiselect') {
    const options = document.createElement('div');
    options.className = 'formOptions';
    for (const option of field.options ?? []) {
      options.appendChild(optionControl(field, option, field.type === 'radio' ? 'radio' : 'checkbox'));
    }
    row.appendChild(options);
    return row;
  }
  if (field.type === 'checkbox') {
    const choice = document.createElement('label');
    choice.className = 'formBoolean';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = field.id;
    input.dataset.formField = field.id;
    input.required = !!field.required;
    const text = document.createElement('span');
    text.textContent = field.placeholder || 'Yes';
    choice.append(input, text);
    row.appendChild(choice);
    return row;
  }
  let control;
  if (field.type === 'textarea') {
    control = document.createElement('textarea');
    control.rows = 3;
  } else if (field.type === 'select') {
    control = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = field.placeholder || 'Select an option…';
    placeholder.disabled = !!field.required;
    placeholder.selected = true;
    control.appendChild(placeholder);
    for (const option of field.options ?? []) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      control.appendChild(element);
    }
  } else {
    control = document.createElement('input');
    control.type = field.type;
  }
  control.name = field.id;
  control.dataset.formField = field.id;
  control.required = !!field.required;
  control.id = `model-form-field-${++formControlSequence}`;
  label.setAttribute('for', control.id);
  if (field.placeholder && field.type !== 'select') control.placeholder = field.placeholder;
  row.appendChild(control);
  return row;
}

function interactiveFormValues(card, definition) {
  const values = {};
  for (const field of definition.fields ?? []) {
    const controls = formControls(card, field.id);
    if (field.type === 'checkbox') values[field.id] = !!controls[0]?.checked;
    else if (field.type === 'multiselect') values[field.id] = controls.filter((control) => control.checked).map((control) => control.value);
    else if (field.type === 'radio') values[field.id] = controls.find((control) => control.checked)?.value ?? '';
    else values[field.id] = controls[0]?.value ?? '';
  }
  return values;
}

function renderInteractiveForm(ev) {
  let card = ev.id ? toolCards.get(ev.id) : null;
  if (!card && ev.status === 'start') {
    setAwaitingInput(true);
    const definition = ev.args ?? {};
    card = document.createElement('section');
    card.className = 'interactiveForm';
    card.dataset.definition = JSON.stringify(definition);
    const head = document.createElement('div');
    head.className = 'formHead';
    const heading = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = definition.title || 'A few details';
    heading.appendChild(title);
    if (definition.description) {
      const description = document.createElement('p');
      description.textContent = definition.description;
      heading.appendChild(description);
    }
    const status = document.createElement('span');
    status.className = 'formStatus';
    status.textContent = 'Needs your input';
    status.setAttribute('aria-live', 'polite');
    head.append(heading, status);
    const form = document.createElement('form');
    form.className = 'modelForm';
    const fields = document.createElement('fieldset');
    fields.className = 'formFields';
    for (const field of definition.fields ?? []) fields.appendChild(interactiveFormField(field));
    const actions = document.createElement('div');
    actions.className = 'formActions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn teal formSubmit';
    submit.textContent = definition.submitLabel || 'Submit';
    actions.appendChild(submit);
    form.append(fields, actions);
    card.append(head, form);
    currentTurn.appendChild(card);
    if (ev.id) toolCards.set(ev.id, card);
    const ownerKey = renderedChatKey;
    const draftKey = `${ownerKey ?? ''}\n${ev.id ?? ''}`;
    card.dataset.draftKey = draftKey;
    if (persistedFormDrafts[draftKey]) setInteractiveFormValues(card, definition, persistedFormDrafts[draftKey]);
    const rememberDraft = () => {
      persistedFormDrafts[draftKey] = interactiveFormValues(card, definition);
      savePersistedFormDrafts();
    };
    addChatListener(form, 'input', rememberDraft);
    addChatListener(form, 'change', rememberDraft);
    addChatListener(form, 'submit', async (event) => {
      event.preventDefault();
      const missingMulti = (definition.fields ?? []).find((field) => field.type === 'multiselect'
        && field.required && !formControls(card, field.id).some((control) => control.checked));
      if (missingMulti) {
        const first = formControls(card, missingMulti.id)[0];
        first?.setCustomValidity('Select at least one option');
        first?.reportValidity();
        first?.setCustomValidity('');
        return;
      }
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = 'Submitting…';
      const result = await post(`/api/forms/${encodeURIComponent(ev.id)}/respond`, {
        values: interactiveFormValues(card, definition),
      }, { key: ownerKey, guardChat: true, followKey: false, quiet: ['form_not_pending'] });
      if (result.error) {
        submit.disabled = false;
        status.textContent = result.code === 'form_not_pending' ? 'No longer active' : 'Needs your input';
        if (result.code === 'form_not_pending') finishInteractiveForm(card, definition, { error: true });
        return;
      }
      finishInteractiveForm(card, definition, { values: result.values });
      setAwaitingInput(false);
    });
  }
  if (!card) return null;
  let definition = {};
  try { definition = JSON.parse(card.dataset.definition || '{}'); } catch {}
  if (ev.status === 'end') {
    setAwaitingInput(false);
    const result = formResult(ev.output);
    finishInteractiveForm(card, definition, { values: result?.values ?? null, error: !!ev.isError || !result });
  }
  return card;
}

function renderTool(ev) {
  return mutateTranscript(() => {
    if (!currentTurn) currentTurn = newTurn('pi');
    if (ev.name === 'request_form') return renderInteractiveForm(ev);
    let card = ev.id ? toolCards.get(ev.id) : null;
    if (!card) {
      card = document.createElement('div');
      card.className = 'toolCard';
      card.innerHTML = `<button type="button" class="toolHead">
          <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 5l7 7-7 7"/></svg>
          <span class="nm"></span><span class="sm"></span><span class="st">…</span>
        </button>
        <div class="toolBody">
          <h6>Request</h6><pre class="args">…</pre>
          <h6>Output</h6><pre class="out">(running…)</pre>
        </div>`;
      addChatListener(card.querySelector('.toolHead'), 'click', () => card.classList.toggle('open'));
      currentTurn.appendChild(card);
      if (ev.id) toolCards.set(ev.id, card);
      addCopyButtons(card);
    }
    const q = (s) => card.querySelector(s);
    if (ev.status === 'start') {
      q('.nm').textContent = ev.name;
      q('.sm').textContent = ev.summary || '';
      q('.sm').title = ev.summary || '';
      q('.args').textContent = typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args ?? {}, null, 2);
    } else if (ev.status === 'update') {
      if (ev.output) q('.out').textContent = ev.output;
    } else {
      q('.st').textContent = ev.isError ? '✗ error' : '✓';
      q('.st').classList.toggle('err', !!ev.isError);
      q('.out').textContent = ev.output || '(no output)';
      if (ev.isError) card.classList.add('open');
    }
    return card;
  });
}

// Home screen: a single question naming the project, and the composer right
// below as the only thing to do. The old suggestion cards are gone: they were
// noise on top of an empty prompt.
function projectName() {
  const parts = (activeChatState().cwd || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
function showHero() {
  if (chat.children.length) return;
  const h = document.createElement('div');
  h.id = 'hero';
  const name = projectName();
  h.innerHTML = name
    ? `<h1>What should we build in <span class="proj">${esc(name)}</span>?</h1>`
    : '<h1>What should we build today?</h1>';
  chat.appendChild(h);
  setHeroMode(true);
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
function queueTypeLabel(type) {
  return type === 'steer' ? 'Reindirizza' : 'Dopo';
}
function queueAttachmentLabel(item) {
  const count = item.attachments?.length ?? 0;
  return count ? `${count} ${count === 1 ? 'allegato' : 'allegati'}` : '';
}
function queuedPromptElement(item, index) {
  const row = document.createElement('div');
  row.className = 'queuedPrompt';
  row.dataset.id = item.id;
  row.dataset.type = item.type;

  const order = document.createElement('span');
  order.className = 'queueOrder';
  order.textContent = String(index + 1);

  const content = document.createElement('div');
  content.className = 'queueBubble';
  const type = document.createElement('span');
  type.className = 'queueType';
  type.textContent = queueTypeLabel(item.type);
  content.appendChild(type);
  if (item.text) content.appendChild(document.createTextNode(item.text));
  const attachmentLabel = queueAttachmentLabel(item);
  if (attachmentLabel) {
    const attachment = document.createElement('span');
    attachment.className = 'queueAttachment';
    attachment.textContent = `${item.text ? ' · ' : ''}${attachmentLabel}`;
    content.appendChild(attachment);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'queueRemove';
  remove.dataset.queueRemove = item.id;
  remove.title = 'Rimuovi dalla coda';
  remove.setAttribute('aria-label', 'Rimuovi dalla coda');
  remove.textContent = '×';
  row.append(order, content, remove);
  return row;
}
function renderQueuedPrompts(chatState = activeChatState()) {
  chat.querySelector('.queuedPrompts')?.remove();
  if (!chatState.queuedPrompts.length) return;
  const section = document.createElement('section');
  section.className = 'queuedPrompts';
  section.setAttribute('aria-label', 'Messaggi preparati, non ancora nel transcript');
  const caption = document.createElement('div');
  caption.className = 'queuedCaption';
  caption.textContent = 'Messaggi preparati, non ancora nel transcript';
  section.appendChild(caption);
  chatState.queuedPrompts.forEach((item, index) => section.appendChild(queuedPromptElement(item, index)));
  chat.appendChild(section);
}
function deliveredPromptElement(item) {
  const turn = document.createElement('div');
  turn.className = 'turn user queuedDelivered';
  turn.dataset.queueId = item.id;
  turn.dataset.sig = 'user';
  const body = document.createElement('div');
  body.className = 'body';
  const type = document.createElement('span');
  type.className = 'queueType';
  type.textContent = queueTypeLabel(item.type);
  const skill = skillInvocationFromCommand(item.text, commandsCache());
  const message = skill ? skillInvocationElement(skill) : document.createElement('div');
  if (!skill) {
    message.className = 'msg user';
    message.textContent = item.text || queueAttachmentLabel(item);
  }
  body.append(type, message);
  turn.appendChild(body);
  return turn;
}
function applyQueueChange(items, key = activeChatKey()) {
  if (!key) return [];
  const queue = uiState.applyQueuedPrompts(key, items);
  if (key === activeChatKey() && key === renderedChatKey) renderQueuedPrompts(uiState.chatState(key));
  return queue;
}
function handleQueueEvent(ev, key) {
  const owner = uiState.chatState(key);
  const previous = new Map(owner.queuedPrompts.map((item) => [item.id, item]));
  if (ev.action === 'dispatch' && key === activeChatKey() && key === renderedChatKey) {
    const section = chat.querySelector('.queuedPrompts');
    for (const id of ev.ids ?? []) {
      const item = previous.get(id);
      const alreadyFixed = $$('[data-queue-id]', chat).some((turn) => turn.dataset.queueId === id);
      if (!item || alreadyFixed) continue;
      const turn = deliveredPromptElement(item);
      mutateTranscript(() => {
        if (section) chat.insertBefore(turn, section); else chat.appendChild(turn);
      });
      // The next assistant block belongs below the delivered instruction,
      // even when steering continues inside the same SDK agent run.
      currentTurn = currentAssistant = currentThinking = null;
    }
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
  const modelActive = activityRunning && !chatState.awaitingInput;
  $('runState').classList.toggle('on', modelActive);
  $('sendBtn').classList.toggle('hide', running);
  $('queueActions').classList.toggle('hide', !running);
  $('responseSpinner').classList.toggle('hide', !modelActive);
  if (modelActive) renderResponseActivity(chatState);
  input.placeholder = chatState.awaitingInput
    ? 'Complete the form above to continue…'
    : running
    ? 'Scrivi una nuova istruzione mentre l’agente lavora…'
    : 'Ask me anything…  (drop files and images here)';
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
  if (state.agentTask && !state.agentTask.t1 && !state.awaitingInput) renderResponseActivity(state);
}, 1000);
function setAwaitingInput(on, key = activeChatKey() ?? renderedChatKey) {
  const state = key ? uiState.chatState(key) : activeChatState();
  state.awaitingInput = on;
  if (key === activeChatKey() || (!key && !activeChatKey())) renderComposerState(state);
}
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
  if (!on) { currentAssistant = currentThinking = currentTurn = null; }
}
function markResponseText() {
  const key = activeChatKey() ?? renderedChatKey;
  if (key) uiState.markResponseText(key);
  else activeChatState().responsePhase = RESPONSE_TEXT;
  renderComposerState();
}
function closeResponseSpinner() {
  activeChatState().responsePhase = RESPONSE_IDLE;
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
        renderSessions();
        if (!ev.running && wasRunning) toast('Chat finished: ' + chatLabel(ev.key), true, {
          actionLabel: 'Open chat',
          onAction: () => openChatNotification(ev.key),
        });
      }
    } else if (ev.kind === 'sessions') {
      loadSessions();
    } else if (ev.kind === 'terminals') {
      loadTerminals();   // a terminal was created, died or was closed (here or elsewhere)
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
      // a new text segment after thinking/tool must be appended AFTER them, in order: drop the
      // stale thinking reference so the next 'thinking' event (if any) starts a fresh bubble below
      currentThinking = null;
      markResponseText();
      if (!currentAssistant) { if (!currentTurn) currentTurn = newTurn('pi'); currentAssistant = bubble('assistant', '', currentTurn); }
      appendMd(currentAssistant, ev.delta); break;
    case 'thinking':
      // a new thinking segment after text/tool must create a fresh bubble in DOM order, not
      // reuse (and jump back to) an earlier one
      currentAssistant = null;
      if (!currentTurn) currentTurn = newTurn('pi');
      if (!currentThinking) currentThinking = bubble('thinking', '', currentTurn);
      appendText(currentThinking, ev.delta); break;
    case 'tool':
      // tool calls always happen between other segments: whatever comes next (thinking/text)
      // must render as a new element after the tool card, never append into a stale one
      currentThinking = null; currentAssistant = null;
      renderTool(ev); taskFromTool(ev, ownerKey); break;
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
        activeChatState().turnModel = null;
        setAgentTask(false, null, ownerKey);
        refreshGit();  // the agent may have touched files / branches
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
      closeResponseSpinner();
      bubble('sys err', (ev.aborted ? '⏹ ' : '⚠ ') + ev.message);
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
  if (!$('settingsView').classList.contains('hide')) renderSettings();
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
const THINK_DESC = { off: 'No extended reasoning', low: 'Short reasoning', medium: 'Moderate reasoning', high: 'Deep reasoning', xhigh: 'Very deep reasoning', max: 'Maximum reasoning budget' };
function renderThinking() {
  const levels = activeChatState().thinkingLevels?.length ? activeChatState().thinkingLevels : ['off'];
  if (!levels.includes(activeChatState().thinking)) activeChatState().thinking = levels[0];
  const only = levels.length === 1;
  $('thinkName').textContent = only && levels[0] === 'off' ? 'no reasoning' : activeChatState().thinking;
  $('thinkBtn').style.opacity = only ? '.55' : '1';
  const menu = $('thinkMenu');
  menu.innerHTML = `<div class="dd-group">Effort levels available for ${esc(activeChatState().model?.id ?? 'this model')}</div>`;
  for (const lv of levels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dd-item' + (lv === activeChatState().thinking ? ' sel' : '');
    b.innerHTML = `<span class="col"><span>${lv}</span><span class="desc">${THINK_DESC[lv] ?? ''}</span></span>`;
    b.addEventListener('click', async () => {
      thinkDd.classList.remove('open');
      const key = activeChatKey();
      const r = await post('/api/thinking', { level: lv }, { key, guardChat: true });
      if (r.error || key !== activeChatKey()) return;
      activeChatState().thinking = r.thinkingLevel ?? lv;
      renderThinking();
    });
    menu.appendChild(b);
  }
}
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
  const raw = sessionLabel(allSessions.find((s) => s.path === key)).replace(/\s+/g, ' ').trim();
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
function sessionsInOrder(projectCwd = activeProjectCwd()) {
  const words = $('sessionSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // deep search results take the place of the list: the server has already
  // decided what matches, and only the project tab still narrows it down —
  // filters and title search could only take rows away from an answer the user
  // explicitly asked for.
  const list = deepResults
    ? deepResults.filter((s) => !projectCwd || (s.cwd || '').toLowerCase() === projectCwd.toLowerCase())
    : allSessions.filter((s) => passesSessionFilter(s, projectCwd) && matchesSessionSearch(s, words));
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
// One chat row. Built once and reused by the sidebar and by the hover switcher,
// so active state, favourite/done buttons and running dots cannot drift apart
// between the two.
function sessionItemEl(s) {
  const done = isChatDone(s);
  const div = document.createElement('div');
  div.className = 'sessionItem' + (s.path === activeChatKey() ? ' active' : '') + (done ? ' done' : '');
  // `title` is the server's summary of the chat, already falling back to the
  // truncated first message; the other two cover a payload without it.
  const label = sessionLabel(s) || '(empty)';
  const running = runningKeys.has(s.path);
  // one line only: title and date. Model, project, message count and status
  // badges stay in the payload but out of sight; the per-row actions (favorite,
  // done) live in the hover panel as before.
  div.innerHTML = `<div class="acts">
    ${chatArchiving ? `<button class="doneBtn${done ? ' on' : ''}" title="${done ? 'Move back to active' : 'Mark as done'}">${done ? '↺' : '✓'}</button>` : ''}
    <button class="fav${s.favorite ? ' on' : ''}" title="${s.favorite ? 'Remove from favorites' : 'Add to favorites'}">${s.favorite ? '♥' : '♡'}</button>
    </div><div class="title">${running ? '<span class="runDot"></span>' : ''}<span class="lbl"></span>
    <span class="date">${fmtDate(s.modified)}</span></div>`;
  div.querySelector('.lbl').textContent = label;
  div.title = label;
  // favorite: clicking the heart must not open the chat
  div.querySelector('.fav').addEventListener('click', async (e) => {
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
// Rows plus group headers, in the container of the caller.
function fillSessionList(el, list, groupBy) {
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
        el.appendChild(h);
      }
    }
    el.appendChild(sessionItemEl(s));
  }
}
function renderSessions() {
  renderContextHeader();
  const groupBy = sessionGroup;
  const list = orderForGrouping(sessionsInOrder(), groupBy);
  $('sessionCount').textContent = list.length;
  if ($('quickChats').classList.contains('show')) renderQuickChats();
  const el = $('sessionList');
  el.innerHTML = '';
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
  const ticket = navigation.transition({ tabId, view: VIEW_CHAT, resourceId: s.path });
  const r = await post(
    sessionPath(s.path, 'activate'),
    { cwd: s.cwd || undefined },
    { followKey: false, key: s.path, ticket },
  );
  if (!navigation.isCurrent(ticket)) return;
  if (r.error) {
    if (previous && isNavigationSelectionAvailable(previous) && uiState.canSelect(previous)) {
      navigation.transition(previous);
    } else {
      navigation.restoreActive(fallbackSelectionForTab);
    }
    return;
  }
  const key = r.key ?? s.path;
  let activeTicket = ticket;
  if (key !== s.path) {
    uiState.rekeyChat(s.path, key);
    activeTicket = navigation.transition({ tabId, view: VIEW_CHAT, resourceId: key });
  }
  showChatResource(key);            // the cached view was already shown by the transition
  await loadOpenChat(activeTicket); // synchronize independently; never rely on SSE alone
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
$('openPiTermBtn').addEventListener('click', () => openTerminal('pi'));
$('openShellTermBtn').addEventListener('click', () => openTerminal('shell'));

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
  const res = await api('/api/search?scope=all&q=' + encodeURIComponent(query), { signal: ctrl.signal });
  // aborted, or overtaken by a newer search: the one running now owns the state
  if (seq !== deepSearchSeq) return;
  deepSearching = false;
  deepSearchAbort = null;
  // typing during the request has already put the sidebar back on the titles:
  // these results answer a question the user has moved on from.
  const stale = $('sessionSearch').value.trim() !== query;
  if (!stale && !res.error) {
    deepResults = res.sessions ?? [];
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
    return selection.resourceId === renderedChatKey || allSessions.some((s) => s.path === selection.resourceId);
  }
  return terminals.some((terminal) => terminal.id === selection.resourceId);
}
function fallbackSelectionForTab(tabId) {
  const project = uiState.projects.get(tabId);
  if (!project) return null;
  const firstChat = orderForGrouping(sessionsInOrder(project.cwd), sessionGroup)[0];
  if (firstChat) return { tabId, view: VIEW_CHAT, resourceId: firstChat.path };
  const firstTerminal = terminals.find((terminal) => !project.cwd
    || terminal.cwd.toLowerCase() === project.cwd.toLowerCase());
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
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cwd);
        requestAnimationFrame(() => t.classList.add('dragging'));
      });
      t.addEventListener('dragend', () => {
        $$('.projTab').forEach((tab) => tab.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      t.addEventListener('dragover', (e) => {
        const source = e.dataTransfer.getData('text/plain');
        if (!source || source === cwd) return;
        e.preventDefault();
        const after = e.clientX > t.getBoundingClientRect().left + t.offsetWidth / 2;
        t.classList.toggle('drop-before', !after);
        t.classList.toggle('drop-after', after);
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        const source = e.dataTransfer.getData('text/plain');
        const from = projState.tabs.indexOf(source);
        const target = projState.tabs.indexOf(cwd);
        if (from < 0 || target < 0 || from === target) return;
        const after = e.clientX > t.getBoundingClientRect().left + t.offsetWidth / 2;
        projState.tabs.splice(from, 1);
        const insertAt = projState.tabs.indexOf(cwd) + (after ? 1 : 0);
        projState.tabs.splice(insertAt, 0, source);
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
function disposeChatSnapshot(snapshot) {
  snapshot.fragment.replaceChildren();
  snapshot.toolCards.length = 0;
  snapshot.currentAssistant = snapshot.currentThinking = snapshot.currentTurn = null;
}
function parkChatView(key) {
  if (!key || chatCache.peek(key)?.view.snapshot) return;
  stashComposerDraft(key);
  const entry = uiState.chatViewState(key);
  entry.composer.attachments = pending;
  const fragment = document.createDocumentFragment();
  chatCache.captureView(key, {
    readScrollTop: () => chatWrap.scrollTop,
    detachSnapshot: () => {
      fragment.append(...chat.childNodes);
      return {
        fragment,
        currentAssistant,
        currentThinking,
        currentTurn,
        toolCards: [...toolCards],
      };
    },
    disposeSnapshot: disposeChatSnapshot,
  });
  currentAssistant = currentThinking = currentTurn = null;
  toolCards.clear();
}
function restoreChatView(key) {
  const entry = uiState.chatViewState(key);
  input.value = entry.composer.draft;
  pending = entry.composer.attachments;
  renderAttachments();
  autoGrow();
  const snapshot = chatCache.takeSnapshot(key);
  chat.replaceChildren();
  currentAssistant = currentThinking = currentTurn = null;
  toolCards.clear();
  if (snapshot) {
    chat.append(snapshot.fragment);
    currentAssistant = snapshot.currentAssistant;
    currentThinking = snapshot.currentThinking;
    currentTurn = snapshot.currentTurn;
    for (const [id, card] of snapshot.toolCards) toolCards.set(id, card);
  }
  renderContextHeader();
  if (entry.view.scrollTop !== null) chatWrap.scrollTop = entry.view.scrollTop;
}
async function refreshChat({ key = activeChatKey() ?? renderedChatKey, ticket = null } = {}) {
  if (!key || (ticket && !navigation.isCurrent(ticket)) || activeChatKey() !== key) return;
  const entry = uiState.chatViewState(key);
  const preserveScroll = entry.view.scrollTop !== null || chat.children.length > 0;
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
  const res = await api('/api/history', undefined, { key, ticket, guardChat: Boolean(key) });
  if (res.error || key !== activeChatKey()) return;
  // Read this after HTTP completes: restoring the value captured when the
  // request started would undo scrolling the user did while syncing.
  const savedScrollTop = preserveScroll ? chatWrap.scrollTop : null;
  if (replace) {
    resetTasks(key);
    chatCache.clearView(key);
    chat.replaceChildren();
    toolCards.clear();
    currentAssistant = currentThinking = currentTurn = null;
  }
  for (const m of res.messages ?? []) {
    const blocks = Array.isArray(m.blocks) && m.blocks.length
      ? m.blocks
      : (m.text ? [{ type: 'text', text: m.text }] : []);
    if (!blocks.length && !m.errorMessage) continue;
    const body = newTurn(m.role === 'user' ? 'user' : 'pi',
      m.role === 'assistant' && (m.provider || m.model) ? { provider: m.provider, id: m.model } : null);
    // tool cards belong to the turn being rebuilt, not to the live one
    const prevTurn = currentTurn;
    currentTurn = body;
    let lastText = null;
    for (const b of blocks) {
      if (b.type === 'text') {
        lastText = bubble(m.role === 'user' ? 'user' : 'assistant', b.text ?? '', body);
      } else if (b.type === 'image' && m.entryId && Number.isInteger(b.contentIndex)) {
        appendMessageImage(body, {
          src: withSessionKey(
            `/api/attachment?entry=${encodeURIComponent(m.entryId)}&block=${b.contentIndex}`,
            key,
          ),
        });
      } else if (b.type === 'skill' && m.role === 'user') {
        lastText = skillInvocationElement(b);
        body.appendChild(lastText);
      } else if (b.type === 'thinking') {
        bubble('thinking', b.text ?? '', body);
      } else if (b.type === 'tool') {
        renderTool({ ...b, status: 'start' });
        if (b.status === 'end') renderTool({ ...b, status: 'end' });
      }
    }
    // turn that ended badly (provider error / abort): without this the history
    // would show an empty turn with no explanation
    if (m.errorMessage) bubble('sys err', (m.stopReason === 'aborted' ? '⏹ ' : '⚠ ') + m.errorMessage, body);
    currentTurn = prevTurn;
    if (lastText) addMsgActions(body, lastText, { entryId: m.entryId });
  }
  // turn still in progress (the chat kept working while you were elsewhere):
  // it is rebuilt from the server buffer and streaming continues live
  if (res.turnModel) activeChatState().turnModel = res.turnModel;
  currentTurn = currentAssistant = currentThinking = null;
  for (const seg of res.live ?? []) {
    if (!currentTurn) currentTurn = newTurn('pi');
    if (seg.type === 'text') {
      currentThinking = null;
      currentAssistant = bubble('assistant', seg.text ?? '', currentTurn);
    } else if (seg.type === 'thinking') {
      currentAssistant = null;
      currentThinking = bubble('thinking', seg.text ?? '', currentTurn);
    } else if (seg.type === 'tool' && seg.tool) {
      currentAssistant = currentThinking = null;
      renderTool({ ...seg.tool, status: 'start' });
      taskFromTool({ ...seg.tool, status: 'start' }, key);
      if (seg.tool.status === 'end') { renderTool({ ...seg.tool, status: 'end' }); taskFromTool({ ...seg.tool, status: 'end' }, key); }
      else if (seg.tool.output) renderTool({ ...seg.tool, status: 'update' });
    }
  }
  // the folder can still be chosen only if the chat never started
  setChatStarted((res.messages ?? []).length > 0 || (res.live ?? []).length > 0, key);
  const owner = uiState.chatState(key);
  if (res.streaming) {
    owner.streaming = true;
    owner.responsePhase = (res.live ?? []).some((segment) => segment.type === 'text' && segment.text)
      ? RESPONSE_TEXT
      : RESPONSE_WAITING;
  }
  setRunning(!!res.streaming);
  setAwaitingInput(!!res.awaitingInput, key);
  renderQueuedPrompts(owner);
  if (res.streaming && !owner.agentTask) setAgentTask(true, res.turnModel, key);
  else if (!res.streaming && owner.agentTask && !owner.agentTask.t1) setAgentTask(false, null, key);
  if (!chat.children.length) showHero();
  else setHeroMode(false); // switching to a started chat: no hero, no tray
  if (savedScrollTop === null) scrollDown();
  else chatWrap.scrollTop = savedScrollTop;
  uiState.chatViewState(key).view.scrollTop = chatWrap.scrollTop;
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

/* ---------------- integrated terminals (xterm over SSE) ----------------
   One xterm instance per terminal id, created the first time it is selected
   and kept alive afterwards: switching to a chat and back must not lose the
   scrollback. The process itself lives in the server, so a page reload only
   costs the instance, never the session. */
const termPanes = new Map();   // id -> { pane, term, fit, es }

// xterm parses colours itself and only understands hex and `rgb()/rgba()`: a
// theme token written as `color-mix()` (or any other CSS colour function) is
// rejected in silence and replaced by an xterm default, which is how the
// selection turned white. So every value read from CSS is resolved to a plain
// `rgba()` first, by painting it on a 1x1 canvas and reading the pixel back.
// Assigning to `fillStyle` is a no-op when the value is unparsable, so two
// different sentinels tell a rejected value apart from a genuinely painted one.
let colorProbe;                       // undefined = not tried yet, null = unusable
function colorProbeCtx() {
  if (colorProbe === undefined) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      colorProbe = canvas.getContext('2d', { willReadFrequently: true }) || null;
    } catch { colorProbe = null; }
  }
  return colorProbe;
}
function cssColorToRgba(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const ctx = colorProbeCtx();
  if (!ctx) return fallback;
  try {
    ctx.fillStyle = '#000000';
    ctx.fillStyle = raw;
    const onBlack = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = raw;
    if (onBlack !== ctx.fillStyle) return fallback;   // both sentinels survived: value refused
    ctx.globalCompositeOperation = 'copy';            // keep the alpha instead of blending it away
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  } catch {
    return fallback;
  }
}

// The colours follow the active web UI theme instead of xterm's defaults, so a
// terminal does not punch a black hole into a light page.
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cssColorToRgba(css.getPropertyValue(name), fallback);
  const foreground = v('--txt', 'rgba(233, 237, 243, 1)');
  const background = v('--bg', 'rgba(11, 13, 17, 1)');
  return {
    background,
    foreground,
    cursor: v('--teal', foreground),
    cursorAccent: background,
    selectionBackground: v('--teal-dim', 'rgba(47, 224, 192, 0.2)'),
  };
}
function refreshTerminalThemes() {
  const theme = termTheme();
  for (const entry of termPanes.values()) entry.term.options.theme = theme;
}

// Keystrokes are the most frequent request the page makes: they go out on a
// bare fetch, without the toast-on-error wrapper, so a hiccup cannot bury the
// screen under notifications.
function sendTerminalInput(id, data) {
  fetch(`/api/terminals/${encodeURIComponent(id)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  }).catch((e) => console.error('terminal input', e));
}

// `navigator.clipboard` only exists in a secure context: served on the LAN over
// plain http it is undefined, and touching it inside the right-click handler
// would throw where the browser menu has already been suppressed. Say so with
// the same toast the copy buttons use, and let the caller give up quietly.
function clipboardOrWarn() {
  if (navigator.clipboard) return navigator.clipboard;
  toast('Clipboard unavailable (the browser only allows it over https or on localhost)');
  return null;
}

// Copy the current selection, if there is one, and say whether there was: the
// caller decides what to do with an empty selection (right-click pastes
// instead). Clearing after the copy is what makes the next right-click paste.
function copyTerminalSelection(term) {
  const sel = term.getSelection();
  if (!sel) return false;
  // a selection there was, whether or not the clipboard took it: right-click
  // must not fall through to pasting
  clipboardOrWarn()?.writeText(sel)
    .then(() => term.clearSelection())
    .catch((e) => console.error('terminal copy', e));
  return true;
}

// The clipboard goes in through `term.paste`, the same door keystrokes use
// (onData -> sendTerminalInput): bracketed paste mode keeps multi-line text as
// text instead of the shell running every line on arrival. A dead pane takes
// no input, as with the keyboard.
function pasteIntoTerminal(id, term) {
  if (termPanes.get(id)?.exited) return;
  clipboardOrWarn()?.readText()
    .then((text) => { if (text) term.paste(text); })
    .catch((e) => console.error('terminal paste', e));
}

// The PTY has to be told the geometry the addon just computed, otherwise the
// program running inside it keeps wrapping at the old width.
function fitTerminal(id) {
  const entry = termPanes.get(id);
  if (!entry || entry.pane.classList.contains('hide')) return;
  try { entry.fit.fit(); } catch { return; }
  const { cols, rows } = entry.term;
  if (cols === entry.cols && rows === entry.rows) return;
  entry.cols = cols; entry.rows = rows;
  fetch(`/api/terminals/${encodeURIComponent(id)}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).catch((e) => console.error('terminal resize', e));
}

// The process behind this pane is gone: say so once, and stop pretending the
// keyboard goes anywhere. The row stays in the sidebar (and the pane reopens
// read-only) until the user closes it with ×, so the scrollback is not lost
// with the process.
function markTerminalExited(id, code) {
  const entry = termPanes.get(id);
  // The frame comes again on every reconnection of the stream: the notice and
  // the read-only switch must happen once per pane, not once per delivery.
  if (!entry || entry.exited) return;
  entry.exited = true;
  entry.term.options.disableStdin = true;
  entry.term.options.cursorBlink = false;
  entry.term.write(`\r\n[process exited (code ${code}) — close this terminal with ×]\r\n`);
  const terminal = terminals.find((item) => item.id === id);
  if (terminal) terminal.exited = code;
  const scoped = uiState.terminals.get(id);
  if (scoped) scoped.exited = code;
  renderContextHeader();
}

function openTerminalPane(id) {
  const existing = termPanes.get(id);
  if (existing) return existing;
  if (!win.Terminal) { toast('xterm.js did not load: the terminal cannot be shown'); return null; }
  const pane = document.createElement('div');
  pane.className = 'termPane hide';
  pane.dataset.id = id;
  $('termHost').appendChild(pane);

  const css = getComputedStyle(document.documentElement);
  const term = new win.Terminal({
    theme: termTheme(),
    fontFamily: css.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
  });
  const fit = new win.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  term.onData((data) => sendTerminalInput(id, data));

  // Right-click works like Windows Terminal: with a selection it copies, with
  // none it pastes. The branch is decided synchronously so the clipboard read
  // still runs under the user gesture, and the browser menu never opens on a
  // terminal, where it would only offer things that do not apply.
  // Without `navigator.clipboard` (LAN over plain http) there is nothing to
  // offer instead, so the native menu is left alone: it lives outside the page
  // and can still copy the selection.
  pane.addEventListener('contextmenu', (e) => {
    if (!navigator.clipboard) return;
    e.preventDefault();
    if (!copyTerminalSelection(term)) pasteIntoTerminal(id, term);
  });

  // Ctrl+Shift+C/V for the same two actions. Plain Ctrl+C and Ctrl+V are left
  // to the terminal: they are SIGINT and a literal ^V, and the shell wants
  // them.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c') { copyTerminalSelection(term); return false; }
    if (key === 'v') { pasteIntoTerminal(id, term); return false; }
    return true;
  });

  // Scrollback first, then the live output: both arrive as `{ data }` frames,
  // because a terminal emits raw control bytes SSE framing would eat.
  // Every frame carries an id (the offset it brings us to), which EventSource
  // sends back as Last-Event-ID when it reconnects on its own: the server then
  // replays only what we missed. `reset` means it could not — the output we are
  // missing has scrolled away — so what follows replaces the screen, it does
  // not continue it.
  // `exited` is the death of the process, announced by the server: it is what
  // turns the pane read-only, and it arrives whether or not anyone typed.
  const es = new EventSource(`/api/terminals/${encodeURIComponent(id)}/stream`);
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.reset === true) term.reset();
    if (typeof ev.data === 'string') term.write(ev.data);
    if (typeof ev.exited === 'number') markTerminalExited(id, ev.exited);
  };
  es.onerror = () => { /* EventSource reconnects on its own */ };

  const entry = { pane, term, fit, es, cols: 0, rows: 0, exited: false };
  termPanes.set(id, entry);
  return entry;
}

// Called when a terminal is gone (killed from the sidebar, or vanished from
// the server list): the instance has no process to talk to anymore.
function disposeTerminalPane(id) {
  const entry = termPanes.get(id);
  if (!entry) return;
  try { entry.es.close(); } catch {}
  try { entry.term.dispose(); } catch {}
  entry.pane.remove();
  termPanes.delete(id);
}

function showTerminal(id) {
  const terminal = terminals.find((item) => item.id === id);
  if (!terminal) return;
  const currentProject = activeProjectCwd();
  const tabId = !currentProject || currentProject.toLowerCase() === terminal.cwd.toLowerCase()
    ? uiState.activeTabId
    : projectTabId(null);
  navigation.transition({ tabId, view: VIEW_TERMINAL, resourceId: id });
}

function renderContextHeader(selection = uiState.selection) {
  const selectedChat = selection?.view === VIEW_CHAT ? uiState.chats.get(selection.resourceId) : null;
  const chatSession = selection?.view === VIEW_CHAT
    ? allSessions.find((item) => item.path === selection.resourceId)
    : null;
  const chatHeader = chatHeaderState(selection, selectedChat, chatSession, {
    canOpenFolder: platformCaps?.openFolder,
  });
  const terminal = selection?.view === VIEW_TERMINAL
    ? terminals.find((item) => item.id === selection.resourceId)
    : null;
  const terminalHeader = terminalHeaderState(selection, terminal, {
    canOpenFolder: platformCaps?.openFolder,
    canCopyPath: Boolean(navigator.clipboard) || typeof document.execCommand === 'function',
  });
  $('mainHeader').dataset.view = selection?.view ?? VIEW_CHAT;
  document.querySelector('.crumb').classList.toggle('hide', !chatHeader);
  $('terminalHeader').classList.toggle('hide', !terminalHeader);

  if (chatHeader) {
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

  if (!terminalHeader) return;
  $('terminalFolder').textContent = terminalHeader.folder || 'Terminal';
  $('terminalPath').textContent = terminalHeader.cwd;
  $('terminalPath').title = terminalHeader.cwd;
  $('terminalKind').textContent = terminalHeader.kind;
  $('terminalStatus').textContent = terminalHeader.status;
  $('terminalStatus').classList.toggle('running', terminalHeader.running);
  $('terminalStatus').classList.toggle('exited', !terminalHeader.running);
  $('terminalOpenFolderBtn').disabled = !terminalHeader.canOpenFolder;
  $('terminalOpenFolderBtn').title = terminalHeader.canOpenFolder
    ? `Open ${terminalHeader.cwd}`
    : 'Opening folders is unavailable on this system';
  $('terminalCopyPathBtn').disabled = !terminalHeader.canCopyPath;
  $('terminalCopyPathBtn').title = terminalHeader.canCopyPath
    ? `Copy ${terminalHeader.cwd}`
    : 'Clipboard unavailable; select the path and use the browser menu';
  const restarting = pendingTerminalRestarts.has(terminalHeader.id);
  $('terminalRestartBtn').disabled = restarting;
  $('terminalRestartBtn').textContent = restarting ? 'Restarting…' : 'Restart';
  $('terminalCloseBtn').disabled = restarting;
}

function renderTerminalView(id) {
  const entry = openTerminalPane(id);
  if (!entry) return;
  $('chatView').classList.add('hide');
  $('settingsView').classList.add('hide');
  $('termView').classList.remove('hide');
  $('navChat').classList.remove('on');
  $('navSettings').classList.remove('on');
  for (const [paneId, paneEntry] of termPanes) paneEntry.pane.classList.toggle('hide', paneId !== id);
  fitTerminal(id);
  entry.term.focus();
}

// Leaving the terminal view only hides it: the instances, their SSE streams and
// their scrollback survive, so coming back is instant.
function hideTerminalView() {
  $('termView').classList.add('hide');
}

// The window is not the only thing that changes the width: the sidebar folds,
// the diff panel opens. Re-fitting on every resize event of the window covers
// the ones that matter without watching the whole layout.
let termFitTimer = null;
win.addEventListener('resize', () => {
  clearTimeout(termFitTimer);
  termFitTimer = setTimeout(() => {
    const id = activeTerminalId();
    if (id) fitTerminal(id);
  }, 120);
});

/* ---------------- terminals in the sidebar ----------------
   The server owns the list: this is a projection of GET /api/terminals,
   re-rendered from scratch on every global `terminals` event. Every tab gets
   that event, so the render has to be idempotent — it is, it rebuilds the rows.
   The quick-chat flyout deliberately stays out of this: it is a window on the
   chats, terminals have no business in it. */
let terminals = [];
const pendingTerminalRestarts = new Set();

// A plain fetch, not api(): the endpoints answer 403 to anything that is not
// loopback, and a LAN client would eat a toast at every boot for a feature it
// simply does not have.
async function loadTerminals() {
  let payload;
  try {
    const r = await fetch('/api/terminals');
    payload = r.ok ? await r.json() : { terminals: [] };
  } catch { payload = { terminals: [] }; }
  terminals = uiState.applyTerminalsPayload(payload).terminals;
  renderTerminals();
}

// `exited` is the exit code, and the ordinary way a shell quits is code 0:
// only `null` means the process is still alive.
const hasExited = (t) => t.exited !== null && t.exited !== undefined;

function terminalItemEl(t) {
  const div = document.createElement('div');
  const dead = hasExited(t);
  div.className = 'sessionItem termItem'
    + (t.id === activeTerminalId() ? ' active' : '') + (dead ? ' done' : '');
  div.innerHTML = `<div class="acts"><button class="killBtn" title="Close this terminal">×</button></div>
    <div class="title"><span class="termIcon">${t.kind === 'pi' ? 'π' : '▢'}</span>${dead ? '' : '<span class="liveDot"></span>'}<span class="lbl"></span></div>
    <div class="meta">${dead ? '<span class="exited">exited</span>' : `<span>${t.kind === 'pi' ? 'pi' : 'powershell'}</span>`}</div>`;
  div.querySelector('.lbl').textContent = projName(t.cwd) || '(no folder)';
  div.title = t.cwd || '';
  div.querySelector('.killBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    killTerminal(t.id);
  });
  div.addEventListener('click', () => selectTerminal(t.id));
  return div;
}

// Header chip: how many terminals are running right now, and a popover to jump
// to one or close it without opening the sidebar. There is no cap on how many
// can be open — this is the way to keep an eye on them, not a limit.
// An exited terminal keeps its sidebar row (its scrollback is still readable)
// but it is not "running", so it stays out of both the count and the list.
function renderTermsChip() {
  const live = terminals.filter((t) => !hasExited(t));
  const menu = $('termsMenu');
  termsDd.classList.toggle('hide', live.length === 0);
  if (live.length === 0) termsDd.classList.remove('open');
  $('termsCount').textContent = live.length;
  menu.innerHTML = '<div class="dd-group">Running terminals</div>';
  for (const t of live) {
    const row = document.createElement('div');
    row.className = 'termRow' + (t.id === activeTerminalId() ? ' sel' : '');
    row.innerHTML = `<button class="dd-item go"><span class="termIcon">${t.kind === 'pi' ? 'π' : '▢'}</span><span class="col"><span class="nm"></span><span class="pth"></span></span></button>
      <button class="btn icon kill" title="Close this terminal">×</button>`;
    row.querySelector('.nm').textContent = projName(t.cwd) || '(no folder)';
    row.querySelector('.pth').textContent = t.cwd || '';
    row.querySelector('.go').addEventListener('click', () => {
      termsDd.classList.remove('open');
      selectTerminal(t.id);
    });
    // the popover stays open: closing terminals one after the other is the
    // whole point of having the list here
    row.querySelector('.kill').addEventListener('click', () => killTerminal(t.id));
    menu.appendChild(row);
  }
}

// The sidebar section belongs to the project tab you are on: on "All" it lists
// everything, on a project only the terminals opened in that folder. The chip in
// the header stays global on purpose — it is the one place that answers "what is
// still running anywhere?".
function terminalsOfActiveProject() {
  const act = (activeProjectCwd() || '').toLowerCase();
  if (!act) return terminals;
  return terminals.filter((t) => (t.cwd || '').toLowerCase() === act);
}

function renderTerminals() {
  const list = $('termList');
  const shown = terminalsOfActiveProject();
  const empty = shown.length === 0;
  $('termLabel').classList.toggle('hide', empty);
  list.classList.toggle('hide', empty);
  $('termCount').textContent = shown.length;
  // a terminal the server no longer knows about has no process to talk to:
  // its instance goes with the row
  const alive = new Set(terminals.map((t) => t.id));
  const selectedTerminal = activeTerminalId();
  const activeGone = selectedTerminal !== null
    && !alive.has(selectedTerminal)
    && !pendingTerminalRestarts.has(selectedTerminal);
  for (const id of [...termPanes.keys()]) if (!alive.has(id)) disposeTerminalPane(id);
  list.innerHTML = '';
  for (const t of shown) list.appendChild(terminalItemEl(t));
  renderTermsChip();
  renderContextHeader();
  if (activeGone) {
    const ticket = navigation.restoreActive(fallbackSelectionForTab);
    if (!ticket.selection) newChat({ tabId: uiState.activeTabId, ticket });
    else if (ticket.selection.view === VIEW_CHAT) loadOpenChat(ticket);
  }
}

// Selecting a terminal only swaps the view: the chat keeps streaming behind it
// and its xterm instance, if any, is reused as it is.
function selectTerminal(id) {
  showTerminal(id);
  renderTerminals();
}

// The two buttons next to "New chat". The folder is not ours to choose: the
// server reads it from the context of the chat this tab is on, which is why
// this goes through post() (it appends the session key) and why the body only
// carries the kind. Errors — 403 from a LAN tab, 501 where pty is missing —
// come back as a toast from api(), like everywhere else.
async function openTerminal(kind) {
  const r = await post('/api/terminals', { kind });
  if (r.error) return;
  await loadTerminals();
  selectTerminal(r.id);
}

async function openVisibleTerminalFolder() {
  const terminal = terminals.find((item) => item.id === activeTerminalId());
  if (!terminal) return;
  const button = $('terminalOpenFolderBtn');
  button.disabled = true;
  try {
    const r = await api(`/api/terminals/${encodeURIComponent(terminal.id)}/open-folder`, {
      method: 'POST',
    }, { key: null, followKey: false });
    if (!r.error) toast(`Opened ${r.cwd}`, true);
  } finally {
    renderContextHeader();
  }
}

async function writeTerminalPathToClipboard(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  // Electron and plain-http LAN pages may not expose Clipboard API. A focused
  // temporary input keeps the explicit Copy path action useful without
  // changing the terminal's native context-menu fallback.
  const input = document.createElement('input');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy command refused');
  } finally {
    input.remove();
  }
}

async function copyVisibleTerminalPath() {
  const terminal = terminals.find((item) => item.id === activeTerminalId());
  if (!terminal) return;
  try {
    await writeTerminalPathToClipboard(terminal.cwd);
    toast('Terminal path copied', true);
  } catch {
    toast('Copy failed (browser clipboard permissions)');
  }
}

async function restartVisibleTerminal() {
  const id = activeTerminalId();
  if (!id || pendingTerminalRestarts.has(id)) return;
  pendingTerminalRestarts.add(id);
  renderContextHeader();
  try {
    const r = await api(`/api/terminals/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
    }, { key: null, followKey: false });
    if (r.error) return;

    const stillSelected = activeTerminalId() === id;
    const next = uiState.applyTerminalsPayload({
      terminals: [
        ...terminals.filter((item) => item.id !== id && item.id !== r.terminal.id),
        r.terminal,
      ],
    });
    terminals = next.terminals;
    disposeTerminalPane(id);
    if (stillSelected) showTerminal(r.terminal.id);
    else renderTerminals();
    toast('Terminal restarted', true);
  } finally {
    pendingTerminalRestarts.delete(id);
    renderTerminals();
  }
}

$('terminalOpenFolderBtn').addEventListener('click', openVisibleTerminalFolder);
$('terminalCopyPathBtn').addEventListener('click', copyVisibleTerminalPath);
$('terminalRestartBtn').addEventListener('click', restartVisibleTerminal);
$('terminalCloseBtn').addEventListener('click', () => {
  const id = activeTerminalId();
  if (id) killTerminal(id);
});

async function killTerminal(id) {
  const r = await api(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
    key: null,
    followKey: false,
  });
  if (r.error) return;
  terminals = terminals.filter((t) => t.id !== id);
  uiState.applyTerminalsPayload({ terminals });
  disposeTerminalPane(id);
  if (activeTerminalId() === id) {
    const ticket = navigation.restoreActive(fallbackSelectionForTab);
    if (!ticket.selection) newChat({ tabId: uiState.activeTabId, ticket });
    else if (ticket.selection.view === VIEW_CHAT) loadOpenChat(ticket);
  }
  renderTerminals();
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
  refreshTerminalThemes();   // the accent is the cursor colour of the terminals
}
applyAccent(localStorage.getItem('piAccent') || '');
function applyTheme(id) {
  document.documentElement.dataset.theme = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  localStorage.setItem('piTheme', document.documentElement.dataset.theme);
  $$('.themeCard[data-t]').forEach((c) => c.classList.toggle('sel', c.dataset.t === document.documentElement.dataset.theme));
  refreshTerminalThemes();   // the open terminals follow the page
  const style = getComputedStyle(document.documentElement);
  win.desktopWindow?.setTitleBarTheme({
    background: style.getPropertyValue('--panel').trim(),
    foreground: style.getPropertyValue('--txt').trim(),
  });
}
applyTheme(localStorage.getItem('piTheme') || DEFAULT_THEME);

/* ---------------- views ---------------- */
const BOOTSTRAP_INPUT_KINDS = new Set(['context', 'system', 'append']);
const bootstrapInputKind = (file) => file.kinds.find((kind) => BOOTSTRAP_INPUT_KINDS.has(kind));
const nativeEditorLabel = (short = false, os = platformCaps?.os) => short
  ? 'Open'
  : (os === 'win32' ? 'Open in Notepad' : 'Open in text editor');

function bootstrapFileEditor(file, {
  saveLabel = 'Save',
  promoteId = null,
  promoteLabel = 'Save globally',
  removable = true,
} = {}) {
  const prefilledState = file.prefillSource === 'inherited' ? 'inherited · not overridden' : 'Pi default · not overridden';
  const state = file.symlink ? 'linked · read only' : (file.prefilled ? prefilledState : (!file.exists ? 'new override' : (file.active ? 'passed to agent' : 'saved override')));
  return `<div class="bootstrapEditorCard">
    <div class="bootstrapFileHead">
      <span><b>${esc(file.label)}</b><code title="${esc(file.path)}">${esc(file.path)}</code></span>
      <span class="bootstrapBadges"><span class="badge">${esc(file.scope)}</span><span class="badge ${file.active ? 'ok' : ''}">${state}</span></span>
    </div>
    ${file.tooLarge
      ? '<div class="sys bootstrapNotice">This file is larger than 512 KiB. Open it in the native editor.</div>'
      : `<textarea class="bootstrapEditor" data-bootstrap-editor="${file.id}" rows="8"
           ${file.symlink ? 'readonly' : ''}>${esc(file.content ?? '')}</textarea>`}
    <div class="bootstrapActions">
      ${file.tooLarge || file.symlink ? '' : `<button class="btn teal" data-bootstrap-save="${file.id}">${saveLabel}</button>`}
      ${promoteId && !file.tooLarge && !file.symlink ? `<button class="btn outline" data-bootstrap-promote="${promoteId}" data-bootstrap-source="${file.id}">${promoteLabel}</button>` : ''}
      ${file.exists && platformCaps?.openTextFile ? `<button class="btn outline" data-bootstrap-open="${file.id}">${nativeEditorLabel()}</button>` : ''}
      ${file.tooLarge || file.symlink ? '' : `<button class="btn outline" data-bootstrap-reset="${file.id}">Restore original</button>`}
      ${file.exists && removable && !file.symlink ? `<button class="btn outline danger" data-bootstrap-delete="${file.id}">Remove</button>` : ''}
      <span class="sys" data-bootstrap-message="${file.id}"></span>
    </div>
  </div>`;
}

function bootstrapPromptPreview(prompt, { open = false } = {}) {
  return `<details class="card bootstrapPromptPreview" ${open ? 'open' : ''}>
    <summary><b>Exact initial prompt passed to the agent</b><span class="sys">generated by Pi from tools and loaded resources</span></summary>
    <textarea class="bootstrapEditor" rows="14" readonly>${esc(prompt || '')}</textarea>
  </details>`;
}

function bootstrapResourceList(files) {
  if (!files.length) return '<div class="sys bootstrapEmpty">No file-based resources are loaded in this scope.</div>';
  return files.map((file) => `<div class="bootstrapResource">
    <span><b>${esc(file.path.split(/[\\/]/).pop())}</b><code title="${esc(file.path)}">${esc(file.path)}</code></span>
    <span class="bootstrapResourceActions">
      <span class="bootstrapResourceKinds">${file.kinds.map((kind) => `<span class="badge">${esc(kind)}</span>`).join('')}</span>
      ${platformCaps?.openTextFile ? `<button class="btn outline bootstrapOpen" title="${nativeEditorLabel()}" data-bootstrap-open="${file.id}"><span aria-hidden="true">↗</span>${nativeEditorLabel()}</button>` : ''}
    </span>
  </div>`).join('');
}

function bindBootstrapFileActions(root, { key, refresh }) {
  root.querySelectorAll('[data-bootstrap-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await post('/api/agent-bootstrap/file/open', { id: button.dataset.bootstrapOpen }, { key, followKey: false });
      button.disabled = false;
      if (!result.error) toast(`Opened in ${platformCaps?.os === 'win32' ? 'Notepad' : 'the text editor'}`, true);
    });
  });
  root.querySelectorAll('[data-bootstrap-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.bootstrapSave;
      const editor = root.querySelector(`[data-bootstrap-editor="${id}"]`);
      const message = root.querySelector(`[data-bootstrap-message="${id}"]`);
      button.disabled = true;
      const result = await sendJson('PUT', '/api/agent-bootstrap/file', { id, content: editor?.value ?? '' }, { key, followKey: false });
      button.disabled = false;
      if (result.error) { if (message) message.textContent = result.error; return; }
      toast('Agent input saved');
      await refresh();
    });
  });
  root.querySelectorAll('[data-bootstrap-reset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.bootstrapReset;
      const message = root.querySelector(`[data-bootstrap-message="${id}"]`);
      if (!confirm('Restore this file to the state it had before it was edited here?')) return;
      button.disabled = true;
      const result = await post('/api/agent-bootstrap/file/reset', { id }, { key, followKey: false });
      button.disabled = false;
      if (result.error) { if (message) message.textContent = result.error; return; }
      toast(result.restored ? 'Original agent input restored' : 'Unsaved changes discarded');
      await refresh();
    });
  });
  root.querySelectorAll('[data-bootstrap-promote]').forEach((button) => {
    button.addEventListener('click', async () => {
      const sourceId = button.dataset.bootstrapSource;
      const editor = root.querySelector(`[data-bootstrap-editor="${sourceId}"]`);
      button.disabled = true;
      const result = await sendJson('PUT', '/api/agent-bootstrap/file', {
        id: button.dataset.bootstrapPromote,
        content: editor?.value ?? '',
      }, { key, followKey: false });
      button.disabled = false;
      if (result.error) return;
      toast('Saved globally for other projects');
      await refresh();
    });
  });
  root.querySelectorAll('[data-bootstrap-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Remove this agent input file? This cannot be undone.')) return;
      const result = await sendJson('DELETE', '/api/agent-bootstrap/file', {
        id: button.dataset.bootstrapDelete,
      }, { key, followKey: false });
      if (result.error) return;
      toast('Agent input removed');
      await refresh();
    });
  });
}

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

// settings page sections listed in the sidebar (in place of the chats)
const SETTINGS_SECTIONS = [
  ['analytics', 'Cost analytics'],
  ['sec-agent', 'Agent bootstrap'],
  ['sec-pi', 'pi settings'],
  ['sec-theme', 'Theme'],
  ['sec-usage', 'Account limits'],
  ['sec-session', 'Session'],
  ['sec-enabled', 'Enabled providers and models'],
  ['sec-models', 'Models'],
  ['sec-network', 'Local network'],
  ['sec-chats', 'Chats'],
  ['sec-auth', 'Providers'],
  ['sec-tools', 'Tools'],
  ['sec-paths', 'Paths'],
  ['sec-raw', 'Raw config'],
];
function scrollSettingsSection(id) {
  const section = $(id);
  if (!section) return false;
  const view = $('settingsView');
  const top = view.scrollTop + section.getBoundingClientRect().top
    - view.getBoundingClientRect().top - 16;
  view.scrollTo({ top, behavior: 'smooth' });
  return true;
}
function buildSettingsNav() {
  const nav = $('settingsNav');
  nav.innerHTML = '<div class="snav-label">Settings</div>';
  for (const [id, label] of SETTINGS_SECTIONS) {
    const b = document.createElement('button');
    b.className = 'snavItem';
    b.dataset.target = id;
    b.textContent = label;
    b.addEventListener('click', () => {
      if (!scrollSettingsSection(id)) return;
      nav.querySelectorAll('.snavItem').forEach((x) => x.classList.toggle('on', x === b));
      if (window.matchMedia('(max-width: 768px)').matches) setSidebarCollapsed(true);
    });
    nav.appendChild(b);
  }
}
// highlight in the sidebar the section you are looking at
$('settingsView').addEventListener('scroll', () => {
  const top = $('settingsView').getBoundingClientRect().top;
  let current = null;
  for (const [id] of SETTINGS_SECTIONS) {
    const el = $(id);
    if (el && el.getBoundingClientRect().top - top < 140) current = id;
  }
  $('settingsNav').querySelectorAll('.snavItem').forEach((x) =>
    x.classList.toggle('on', x.dataset.target === current));
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
  renderTerminals();
  if (selection.view === VIEW_TERMINAL) renderTerminalView(selection.resourceId);
  else if (selection.view === VIEW_SETTINGS) renderSettingsView();
}
function renderCachedChatState() {
  renderContextHeader();
  renderModelBtn();
  renderThinking();
  renderStats();
  setRunning(activeChatState().streaming);
  renderQueuedPrompts();
  syncTasks();
  renderUsageWidget();
}
function renderChatView() {
  $('chatView').classList.remove('hide');
  $('settingsView').classList.add('hide');
  hideTerminalView();
  $('navChat').classList.add('on');
  $('navSettings').classList.remove('on');
  $('navDiff').classList.remove('hide');
  $('navTasks').classList.remove('hide');
  $('sidebar').classList.remove('mode-settings');   // the sidebar goes back to the chats
}
function renderSettingsView() {
  $('chatView').classList.add('hide');
  $('settingsView').classList.remove('hide');
  hideTerminalView();
  $('navChat').classList.remove('on');
  $('navSettings').classList.add('on');
  // in settings the diff/tasks panels make no sense: close them and hide the buttons
  $('diffClose').click();
  $('tasksClose').click();
  $('navDiff').classList.add('hide');
  $('navTasks').classList.add('hide');
  $('sidebar').classList.add('mode-settings');      // the sidebar shows the sections
  $('settingsNav').innerHTML = '<div class="snav-label">Settings</div><div class="sys">Loadingâ€¦</div>';
  renderSettings().then(() => {
    if (uiState.selection?.view === VIEW_SETTINGS) buildSettingsNav();
  });
  loadAnalytics();
}

/* ---------------- cost analytics dashboard ---------------- */
const AN_COLORS = ['#2fe0c0', '#a78bfa', '#fb923c', '#f472b6', '#60a5fa', '#facc15', '#4ade80', '#f87171', '#38bdf8', '#c084fc'];
let anData = null;
const anState = { range: '30', model: '__all', project: '__all', gran: 'day', sort: 'cost' };

async function loadAnalytics(force) {
  const box = $('analytics');
  if (!anData || force) {
    box.innerHTML = '<div class="sys">Loading cost analytics…</div>';
    anData = await api('/api/analytics');
  }
  if (!anData || anData.error) {
    box.innerHTML = '<div class="sys">Could not read the session history</div>';
    return;
  }
  renderAnalytics();
}

// Bucket key for the chosen granularity (buckets are stored per day).
function anPeriod(day) {
  if (anState.gran === 'month') return day.slice(0, 7);
  if (anState.gran === 'week') {
    const d = new Date(day + 'T00:00:00Z');
    if (isNaN(d.getTime())) return day;
    const dow = (d.getUTCDay() + 6) % 7; // monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  return day;
}

function anFiltered() {
  let min = null;
  if (anState.range !== 'all') {
    const d = new Date();
    d.setDate(d.getDate() - Number(anState.range));
    min = d.toISOString().slice(0, 10);
  }
  return anData.buckets.filter((b) =>
    b.day !== '?' &&
    (!min || b.day >= min) &&
    (anState.model === '__all' || b.model === anState.model) &&
    (anState.project === '__all' || b.project === anState.project));
}

function renderAnalytics() {
  const rows = anFiltered();

  // totals per model + per period
  const byModel = new Map(), byPeriod = new Map();
  let tot = { cost: 0, tokens: 0, requests: 0, sessions: 0 };
  for (const b of rows) {
    const m = byModel.get(b.model) ?? { model: b.model, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, sessions: 0 };
    for (const k of ['cost', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'sessions']) m[k] += b[k];
    byModel.set(b.model, m);
    const p = anPeriod(b.day);
    const per = byPeriod.get(p) ?? { period: p, cost: 0, models: new Map() };
    per.cost += b.cost;
    per.models.set(b.model, (per.models.get(b.model) ?? 0) + b.cost);
    byPeriod.set(p, per);
    tot.cost += b.cost; tot.tokens += b.tokens; tot.requests += b.requests; tot.sessions += b.sessions;
  }
  const models = [...byModel.values()].sort((a, b) => b[anState.sort] - a[anState.sort]);
  const colorOf = new Map([...byModel.keys()].sort().map((m, i) => [m, AN_COLORS[i % AN_COLORS.length]]));
  const periods = [...byPeriod.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  const top = models[0];

  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const kpi = (k, v) => `<div class="an-kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  $('analytics').innerHTML = `
    <h3>Cost analytics</h3>
    <p class="note">Estimate computed by pi from the API prices at the time of each request, read from the
      session history (${anData.files} files). On a subscription plan it does not match a real spend.</p>
    <div class="an-filters">
      <select id="anRange">
        ${opt('7', 'Last 7 days', anState.range)}${opt('30', 'Last 30 days', anState.range)}
        ${opt('90', 'Last 90 days', anState.range)}${opt('365', 'Last year', anState.range)}
        ${opt('all', 'All history', anState.range)}
      </select>
      <select id="anGran">
        ${opt('day', 'per day', anState.gran)}${opt('week', 'per week', anState.gran)}${opt('month', 'per month', anState.gran)}
      </select>
      <select id="anModel">
        ${opt('__all', 'All models', anState.model)}
        ${anData.models.map((m) => opt(m, m, anState.model)).join('')}
      </select>
      <select id="anProject">
        ${opt('__all', 'All projects', anState.project)}
        ${anData.projects.map((p) => opt(p, p.split(/[\\/]/).pop() || p, anState.project)).join('')}
      </select>
      <span style="flex:1"></span>
      <button class="btn outline" id="anReload">Refresh</button>
    </div>
    <div class="an-kpis">
      ${kpi('Total cost', money(tot.cost))}
      ${kpi('Total tokens', fmt(tot.tokens))}
      ${kpi('Requests', fmt(tot.requests))}
      ${kpi('Sessions', fmt(tot.sessions))}
      ${kpi('Cost / session', tot.sessions ? money(tot.cost / tot.sessions) : '—')}
      ${kpi('Top model', top ? top.model.split('/').pop() : '—')}
    </div>
    ${anChart(periods, colorOf)}
    <div class="an-legend">${[...colorOf].map(([m, c]) => `<span><i style="background:${c}"></i>${esc(m)}</span>`).join('')}</div>
    <table class="an-table">
      <thead><tr>
        <th data-s="model">Model</th><th data-s="input">Input</th><th data-s="output">Output</th>
        <th data-s="cacheWrite">Cache W</th><th data-s="cacheRead">Cache R</th>
        <th data-s="requests">Req</th><th data-s="cost">Cost</th><th>%</th>
      </tr></thead>
      <tbody>
        ${models.map((m) => `<tr>
          <td><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf.get(m.model)};margin-right:.4rem"></i>${esc(m.model)}</td>
          <td>${fmt(m.input)}</td><td>${fmt(m.output)}</td><td>${fmt(m.cacheWrite)}</td><td>${fmt(m.cacheRead)}</td>
          <td>${m.requests}</td><td>${money(m.cost)}</td><td>${tot.cost ? (100 * m.cost / tot.cost).toFixed(1) : '0.0'}%</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--faint)">No data for these filters</td></tr>'}
        ${models.length ? `<tr><td>Total</td><td>${fmt(models.reduce((s, m) => s + m.input, 0))}</td>
          <td>${fmt(models.reduce((s, m) => s + m.output, 0))}</td><td>${fmt(models.reduce((s, m) => s + m.cacheWrite, 0))}</td>
          <td>${fmt(models.reduce((s, m) => s + m.cacheRead, 0))}</td><td>${tot.requests}</td><td>${money(tot.cost)}</td><td>100%</td></tr>` : ''}
      </tbody>
    </table>`;

  for (const [id, key] of [['anRange', 'range'], ['anGran', 'gran'], ['anModel', 'model'], ['anProject', 'project']]) {
    $(id).addEventListener('change', (e) => { anState[key] = e.target.value; renderAnalytics(); });
  }
  $('anReload').addEventListener('click', () => loadAnalytics(true));
  $$('.an-table th[data-s]').forEach((th) => {
    th.addEventListener('click', () => { anState.sort = th.dataset.s; renderAnalytics(); });
  });
}

// Stacked bar chart, plain SVG (no chart library in this project on purpose).
function anChart(periods, colorOf) {
  if (!periods.length) return '<div class="sys" style="padding:1.5rem 0;text-align:center">No data in the selected period</div>';
  const W = 900, H = 190, padL = 46, padB = 22, padT = 8;
  const max = Math.max(...periods.map((p) => p.cost)) || 1;
  const bw = Math.max(2, Math.min(38, (W - padL - 8) / periods.length - 3));
  const step = (W - padL - 8) / periods.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);

  let bars = '';
  periods.forEach((p, i) => {
    const x = padL + i * step + (step - bw) / 2;
    let acc = 0;
    for (const [m, c] of [...p.models].sort()) {
      const h = (H - padT - padB) * (c / max);
      acc += h;
      bars += `<rect x="${x.toFixed(1)}" y="${(H - padB - acc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"
        fill="${colorOf.get(m)}" rx="1"><title>${esc(p.period)} — ${esc(m)}: $${c.toFixed(4)}</title></rect>`;
    }
  });

  const ticks = [0, .5, 1].map((f) => {
    const v = max * f;
    return `<line class="grid" x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}"/>
      <text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">$${v < 1 ? v.toFixed(3) : v.toFixed(1)}</text>`;
  }).join('');

  const every = Math.ceil(periods.length / 12);
  const labels = periods.map((p, i) => i % every === 0
    ? `<text x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(p.period.slice(5))}</text>`
    : '').join('');

  return `<svg class="an-chart" viewBox="0 0 ${W} ${H}">${ticks}${bars}${labels}</svg>`;
}

$('navChat').addEventListener('click', showChat);
$('navSettings').addEventListener('click', showSettings);

async function renderSettings() {
  const body = $('settingsBody');
  body.innerHTML = '<div class="sys">Loading…</div>';
  const [st, c, usageCfg, bootstrap] = await Promise.all([
    api('/api/settings'),
    api('/api/config'),
    api('/api/usage/config'),
    api('/api/agent-bootstrap'),
  ]);
  if (st.error || c.error || bootstrap.error) { body.innerHTML = '<div class="sys">Could not load the configuration</div>'; return; }
  $('agentDir').textContent = st.agentDir ?? c.paths.agentDir;

  /* ---- 1. pi settings, editable where possible ---- */
  const secHtml = st.sections.map((s) => `
    <div class="card" style="padding:.3rem 1rem;margin-bottom:.7rem">
      <h4 style="margin:.7rem 0 .2rem;font-size:.82rem;color:var(--teal);letter-spacing:.04em">${esc(s.name)}</h4>
      ${s.items.map((it) => {
        const id = 'set_' + it.key.replace(/\W/g, '_');
        const val = it.value;
        let ctl;
        if (!it.editable) {
          ctl = `<span class="v" style="font-size:.78rem;color:var(--faint)">${val === null ? 'not set' : esc(JSON.stringify(val))}</span>`;
        } else if (it.type === 'boolean') {
          ctl = `<span class="sw ${val ? 'on' : ''}" id="${id}" data-key="${esc(it.key)}" data-type="boolean" role="switch" tabindex="0"></span>`;
        } else if (it.options && it.options.length > 1) {
          ctl = `<select id="${id}" data-key="${esc(it.key)}" data-type="string">
              <option value="">(default${it.default && it.default !== '-' ? ': ' + esc(it.default) : ''})</option>
              ${it.options.map((o) => `<option ${String(val) === String(o) ? 'selected' : ''} value="${esc(o)}">${esc(o)}</option>`).join('')}
            </select>`;
        } else if (it.type === 'number') {
          ctl = `<input type="number" id="${id}" data-key="${esc(it.key)}" data-type="number" value="${val ?? ''}" placeholder="${esc(it.default)}">`;
        } else {
          ctl = `<input type="text" id="${id}" data-key="${esc(it.key)}" data-type="string" value="${val === null ? '' : esc(val)}" placeholder="${esc(it.default)}">`;
        }
        return `<div class="setRow ${it.editable ? '' : 'ro'}">
          <div>
            <div class="k">${esc(it.key)} <span class="badge">${esc(it.type)}</span>${it.set ? '<span class="badge ok">set</span>' : ''}</div>
            <div class="d">${esc(it.description)}</div>
            ${it.default && it.default !== '-' ? `<div class="def">default: <code>${esc(it.default)}</code></div>` : ''}
          </div>
          <div class="ctl">${ctl}<span class="saved" id="${id}_ok">saved</span></div>
        </div>`;
      }).join('')}
    </div>`).join('');

  applyPlatformCapabilities(c.platform);
  const globalInputs = bootstrap.files.filter((file) => (file.exists || file.prefilled) && file.scope === 'global' && bootstrapInputKind(file));
  const globalResources = bootstrap.files.filter((file) => file.exists && file.active && file.scope === 'global');
  const bootstrapEditors = globalInputs.map((file) => bootstrapFileEditor(file, { removable: Boolean(file.target) })).join('');
  const bootstrapTools = bootstrap.tools.map((tool) => `
    <label class="bootstrapTool" title="${esc(tool.description)}">
      <input type="checkbox" data-bootstrap-tool="${esc(tool.name)}" ${tool.selected ? 'checked' : ''}>
      <span><b>${esc(tool.name)}</b><small>${esc(tool.source)}</small></span>
    </label>`).join('');
  const bootstrapCommands = bootstrap.commands.map((command) => `
    <div class="toolItem"><span class="n">/${esc(command.name)}</span>
      <span class="d">${esc(command.description || command.path || '')}</span><span style="flex:1"></span>
      <span class="badge">${esc(command.source)}</span></div>`).join('');

  body.innerHTML = `
    <div class="sec" id="sec-agent">
      <h3>Agent bootstrap</h3>
      <p class="lead">Global inputs shared by pi and every project. Project-specific inputs are edited from the <b>Agent input</b> menu in each chat.</p>

      ${bootstrapPromptPreview(bootstrap.effectivePrompt, { open: true })}

      <h4 class="bootstrapHeading">Editable global sources</h4>
      <div class="card bootstrapEditors">${bootstrapEditors || '<div class="sys bootstrapEmpty">No global instruction file is currently passed to the agent.</div>'}</div>

      <div class="card bootstrapCatalog">
        <div class="bootstrapCatalogHead"><b>Loaded global resources (${globalResources.length})</b><span class="sys">context, prompts, skills and extensions</span></div>
        <div class="bootstrapResourceList">${bootstrapResourceList(globalResources)}</div>
      </div>

      <h4 class="bootstrapHeading">Tools for agent sessions</h4>
      <div class="card bootstrapTools">
        <div class="bootstrapToolGrid">${bootstrapTools || '<div class="sys">No tools registered</div>'}</div>
        <div class="bootstrapActions">
          <button class="btn teal" id="bootstrapToolsSave">Save selected tools</button>
          <button class="btn outline" id="bootstrapToolsReset">Use pi defaults</button>
          <span class="sys" id="bootstrapToolsMsg">${bootstrap.toolsMode === 'pi-default' ? 'Using pi defaults' : 'Custom selection'}</span>
        </div>
      </div>

      <details class="card bootstrapCatalog">
        <summary><b>Available slash commands (${bootstrap.commands.length})</b><span class="sys">extensions, prompt templates and skills</span></summary>
        <div class="bootstrapResourceList">${bootstrapCommands || '<div class="sys">No slash commands loaded</div>'}</div>
      </details>
    </div>

    <div class="sec" id="sec-pi">
      <h3>pi settings — <span style="color:var(--txt-dim);text-transform:none;letter-spacing:0">${esc(st.path)}</span></h3>
      <p class="lead" style="margin:-.3rem 0 .8rem">Changes are saved to the file right away. Most of them are read by pi at startup: restart the server (⏻) or the CLI to apply them.</p>
      ${secHtml}
      ${st.extras?.length ? `<div class="sys">Keys present in the file but undocumented: ${st.extras.map(esc).join(', ')}</div>` : ''}
    </div>

    <div class="sec" id="sec-theme">
      <h3>Web UI theme</h3>
      <div class="themeGrid">${THEMES.map((t) => `
        <button class="themeCard" data-t="${t.id}">
          <span class="sw-row">${t.cols.map((c2) => `<i style="background:${c2}"></i>`).join('')}</span>
          <span class="nm">${esc(t.name)}</span>
        </button>`).join('')}</div>

      <h4 style="margin:1rem 0 .4rem;font-size:.82rem;color:var(--teal)">Accent colour</h4>
      <div class="accentRow">${ACCENTS.map((a) => `
        <button class="accentDot" data-a="${a.id}" title="${esc(a.name)}">
          ${a.col ? `<i style="background:${a.col}"></i>` : '<i class="none"></i>'}
        </button>`).join('')}</div>

      <h4 style="margin:1rem 0 .4rem;font-size:.82rem;color:var(--teal)">Model logos</h4>
      <div class="themeGrid">${LOGO_STYLES.map((s) => `
        <button class="themeCard logoStyleCard" data-l="${s.id}">
          <span class="prev">${['anthropic', 'openai', 'glm', 'openrouter'].map((p) => providerIconHtml(p, '', 'lg fixed')).join('')}</span>
          <span class="nm">${esc(s.name)}</span>
        </button>`).join('')}</div>
    </div>

    <div class="sec" id="sec-usage">
      <h3>Account limits</h3>
      <p class="lead" style="margin:-.3rem 0 .8rem">OpenAI can reuse the OAuth sign-in already managed by pi. Claude and Kimi use browser session credentials stored only on this machine in <code>~/.pi/agent/web-usage.json</code>. These are private provider endpoints and may change.</p>
      <div class="card" style="padding:.9rem 1rem;margin-bottom:.7rem">
        <div class="setRow">
          <div>
            <div class="k">openaiUsage <span class="badge">boolean</span>${usageCfg.openai?.configured ? '<span class="badge ok">pi OAuth ready</span>' : '<span class="badge no">pi OAuth unavailable</span>'}</div>
            <div class="d">Read Codex subscription windows from OpenAI using pi's <code>openai-codex</code> OAuth. The token and full account ID stay on the server and are never copied into this app's settings.</div>
            <div class="def">default: <code>off</code>. No OpenAI request is made until you enable it</div>
          </div>
          <div class="ctl"><span class="sw ${usageCfg.openai?.enabled ? 'on' : ''}" id="openaiUsageSw" role="switch" tabindex="0"></span><span class="saved" id="openaiUsageMsg"></span></div>
        </div>
      </div>
      <p class="lead" style="margin:.9rem 0 .8rem"><b>Claude and Kimi:</b> copy the matching request from browser DevTools as cURL and paste it below. The saved session expires and then has to be renewed.</p>
      <div class="card" style="padding:.9rem 1rem;margin-bottom:.7rem">
        <h4 style="margin:0 0 .5rem;font-size:.82rem;color:var(--teal)">Claude (claude.ai)
          <span class="badge ${usageCfg.anthropic?.configured ? 'ok' : ''}" id="claudeCfgBadge">${usageCfg.anthropic?.configured ? 'configured' : 'not configured'}</span>
        </h4>
        <ol class="d" style="margin:0 0 .5rem;padding-left:1.2rem;line-height:1.6">
          <li>Open <code>claude.ai</code> and press <b>F12</b> → <b>Network</b> tab (leave it open)</li>
          <li><b>Now</b> go to <b>Settings → Usage</b>: the request only fires when you open that page, before that it is not in Network</li>
          <li>Type <code>usage</code> in the filter and look for the row whose URL looks like:<br><code style="word-break:break-all">https://claude.ai/api/organizations/e44d8396-f752-4390-a998-eea4232dad75/usage</code></li>
          <li>Right-click that row → <b>Copy</b> → <b>Copy as cURL</b> (any variant: POSIX, bash or Windows)</li>
          <li>Paste the <b>whole</b> command below — not just the URL — and press <b>Save and test</b></li>
        </ol>
        <textarea id="claudeCookie" placeholder="curl 'https://claude.ai/api/organizations/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/usage' &#10;  -H 'Cookie: sessionKey=...; cf_clearance=...' &#10;  -H 'Accept: */*' ..." rows="5" style="width:100%;resize:vertical;font:12px var(--font-mono);background:var(--bg-2);border:1px solid var(--line-2);border-radius:8px;color:var(--txt);padding:.5rem"></textarea>
        <details style="margin-top:.4rem"><summary class="sys" style="cursor:pointer">…or paste the cookie by hand</summary>
          <div class="sys" style="margin:.4rem 0">A one-line <code>Cookie</code> header (<code>sessionKey=…; cf_clearance=…</code>) or the DevTools → Application → Cookies table works too. Careful: if you copy from the on-screen panel the long values are <b>truncated</b> with <code>…</code> and will not work. In that case the org id has to be typed in by hand:</div>
          <input id="claudeOrgId" placeholder="org id, e.g. e44d8396-f752-4390-a998-eea4232dad75" value="${esc(usageCfg.anthropic?.orgId ?? '')}">
        </details>
        <div class="row" style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
          <button class="btn teal" id="claudeCfgSave">Save and test</button>
          <button class="btn outline" id="claudeCfgTest">Retry</button>
          <button class="btn outline" id="claudeCfgClear">Remove</button>
          <span class="sys" id="claudeCfgMsg" style="flex:1 0 100%"></span>
        </div>
      </div>
      <div class="card" style="padding:.9rem 1rem">
        <h4 style="margin:0 0 .5rem;font-size:.82rem;color:var(--teal)">Kimi (kimi.com)
          <span class="badge ${usageCfg.kimi?.configured ? 'ok' : ''}" id="kimiCfgBadge">${usageCfg.kimi?.configured ? 'configured' : 'not configured'}</span>
        </h4>
        <ol class="d" style="margin:0 0 .5rem;padding-left:1.2rem;line-height:1.6">
          <li>Open <code>kimi.com/code/console</code> and press <b>F12</b> → <b>Network</b> tab (leave it open)</li>
          <li><b>Now</b> reload the page or open the usage panel: the request only fires there</li>
          <li>Type <code>GetUsages</code> in the filter and look for the row whose URL is:<br><code style="word-break:break-all">https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages</code></li>
          <li>Right-click that row → <b>Copy</b> → <b>Copy as cURL</b> (any variant)</li>
          <li>Paste the <b>whole</b> command below and press <b>Save and test</b></li>
        </ol>
        <textarea id="kimiBearer" placeholder="curl 'https://www.kimi.com/apiv2/.../GetUsages' -H 'Authorization: Bearer eyJ...' ..." rows="4" style="width:100%;resize:vertical;font:12px var(--font-mono);background:var(--bg-2);border:1px solid var(--line-2);border-radius:8px;color:var(--txt);padding:.5rem"></textarea>
        <div class="sys" style="margin-top:.3rem">The bare JWT token also works (the value after <code>Bearer </code>, three dot-separated parts).</div>
        <div class="row" style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
          <button class="btn teal" id="kimiCfgSave">Save and test</button>
          <button class="btn outline" id="kimiCfgTest">Retry</button>
          <button class="btn outline" id="kimiCfgClear">Remove</button>
          <span class="sys" id="kimiCfgMsg" style="flex:1 0 100%"></span>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-network">
      <h3>Local network access</h3>
      <div class="card" style="padding:.9rem 1rem">
        <div class="setRow">
          <div>
            <div class="k">lanAccess <span class="badge">boolean</span></div>
            <div class="d"><b>Warning:</b> this web UI drives an agent that reads, writes and runs commands on <b>your</b> computer. Opening it to the local network means anyone who gets the link (or is on the same Wi-Fi, for instance a guest or a compromised device) can use it with your permissions. Traffic is plain HTTP, not encrypted. Leave it off unless you really need it.</div>
            <div class="def">default: <code>off</code> — the server listens on 127.0.0.1 only. Connected devices must repeat the handshake every 24 hours: the access cookie expires on purpose.</div>
          </div>
          <div class="ctl"><span class="sw" id="lanAccessSw" role="switch" tabindex="0"></span></div>
        </div>
        <div id="lanDetails" class="hide" style="margin-top:.6rem">
          <div class="kv">
            <div class="k">detected address</div><div class="v" id="lanIp">—</div>
            <div class="k">access link</div><div class="v"><code id="lanUrl" style="word-break:break-all">hidden — use the button below</code></div>
          </div>
          <div class="sys" style="margin:.4rem 0">Reveal the link and open it <b>once</b> on the other device: the token is exchanged for a cookie and disappears from the address bar. Do not share it.</div>
          <div class="row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
            <button class="btn outline" id="lanReveal">Show connection URL</button>
            <button class="btn outline" id="lanCopy">Copy link</button>
            <button class="btn outline" id="lanRegen">Regenerate token</button>
            <span class="sys" id="lanMsg" style="flex:1 0 100%"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-chats">
      <h3>Chat archiving</h3>
      <div class="card" style="padding:.9rem 1rem">
        <div class="setRow">
          <div>
            <div class="k">chatArchiving <span class="badge">boolean</span></div>
            <div class="d">Done chats sink to the bottom of the sidebar and look dimmed, so the list stays tidy. Turning the option off makes the sidebar a flat list again: the statuses already saved are not deleted and come back if you turn it on again.</div>
            <div class="def">default: <code>on</code> — on the very first start, chats idle for more than 24 hours are marked done once</div>
          </div>
          <div class="ctl"><span class="sw" id="chatArchivingSw" role="switch" tabindex="0"></span></div>
        </div>
        <div id="chatArchivingDetails" class="hide" style="margin-top:.6rem">
          <div class="row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
            <button class="btn outline" id="archiveNowBtn">Archive chats older than 24 hours</button>
            <span class="sys" id="chatArchivingMsg" style="flex:1 0 100%"></span>
          </div>
        </div>
      </div>

      <h3 style="margin-top:1.2rem">Chat titles</h3>
      <div class="card" style="padding:.9rem 1rem">
        <div class="setRow">
          <div>
            <div class="k">titleGeneration <span class="badge">boolean</span></div>
            <div class="d">The sidebar shows the first message of a chat, cut short. With this on, the title is summarized instead by <code>claude-haiku-4-5</code> using your pi subscription: the first message of the chat leaves your machine and the request is billed to your own quota. With it off nothing is ever sent and the cut stands.</div>
            <div class="def">default: <code>off</code> — turning it on covers the chats you open from now on, never the ones already there</div>
          </div>
          <div class="ctl"><span class="sw" id="titleGenSw" role="switch" tabindex="0"></span></div>
        </div>
        <div class="setRow" style="margin-top:.9rem;padding-top:.9rem;border-top:1px solid var(--line)">
          <div>
            <div class="k">lunaTitleFallback <span class="badge">boolean</span></div>
            <div class="d">If Haiku is unavailable, allow one fallback request to <code>openai-codex/gpt-5.6-luna</code>. The first message then goes to OpenAI and uses your Codex subscription quota. A valid Haiku answer never falls back.</div>
            <div class="def">default: <code>off</code> — separate consent, covering only chats opened after this switch is enabled</div>
          </div>
          <div class="ctl"><span class="sw" id="lunaTitleFallbackSw" role="switch" tabindex="0"></span></div>
        </div>
        <div id="titleGenDetails" class="hide" style="margin-top:.6rem">
          <div class="row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
            <button class="btn outline" id="titleGenBackfillBtn">Generate titles for the existing chats</button>
            <span class="sys" id="titleGenMsg" style="flex:1 0 100%"></span>
          </div>
        </div>
      </div>

      <h3 style="margin-top:1.2rem">Chat search</h3>
      <div class="card" style="padding:.9rem 1rem">
        <div class="setRow">
          <div>
            <div class="k">fullSearch <span class="badge">boolean</span></div>
            <div class="d">Searching the words inside the messages reads the chat files one by one. By default the scan stops at the 300 most recent chats and says so; with this on it reads every chat you have, however long that takes.</div>
            <div class="def">default: <code>off</code> — the 300 most recent chats per search</div>
          </div>
          <div class="ctl"><span class="sw" id="fullSearchSw" role="switch" tabindex="0"></span></div>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-session">
      <h3>Current session</h3>
      <div class="card" style="padding:.9rem 1rem"><div class="kv">
        <div class="k">model</div><div class="v">${c.current ? esc(c.current.provider + '/' + c.current.id) : '—'}</div>
        <div class="k">reasoning</div><div class="v">${esc(c.thinkingLevel)} (available: ${c.thinkingLevels.join(', ')})</div>
        <div class="k">working folder</div><div class="v">${esc(c.cwd)}</div>
        <div class="k">session file</div><div class="v">${esc(c.sessionFile ?? '—')}</div>
        <div class="k">node</div><div class="v">${esc(c.node)}</div>
      </div></div>
    </div>

    <div class="sec" id="sec-enabled">
      <h3>Enabled providers and models</h3>
      <p class="lead" style="margin:-.3rem 0 .8rem">Only the ticked entries show up in the model picker at the top. The list is written to the <code>enabledModels</code> key of settings.json (glob format, shared with the pi CLI): ticking a provider writes <code>provider/*</code>, ticking a model writes its full identifier.</p>
      <div class="card" style="padding:.9rem 1rem">
        <div class="sys" id="enabledHint"></div>
        <h4 style="margin:.7rem 0 .4rem;font-size:.82rem;color:var(--teal);letter-spacing:.04em">Providers</h4>
        <div id="enabledProviders" style="display:flex;gap:.4rem;flex-wrap:wrap"></div>
        <h4 style="margin:1rem 0 .4rem;font-size:.82rem;color:var(--teal);letter-spacing:.04em">Models</h4>
        <div class="search" style="margin-bottom:.5rem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
          <input id="enabledSearch" placeholder="Search model or provider…">
        </div>
        <div id="enabledModelList" style="display:flex;gap:.4rem;flex-wrap:wrap;max-height:320px;overflow:auto"></div>
        <div class="row" style="margin-top:.6rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
          <button class="btn outline" id="enabledClear">Clear the list</button>
          <span class="sys" id="enabledMsg" style="flex:1 0 100%"></span>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-models">
      <h3>Models — click a card to activate the model</h3>
      <div style="display:flex;gap:.5rem;margin-bottom:.7rem;align-items:center;flex-wrap:wrap">
        <div class="search" style="flex:1;min-width:200px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
          <input id="modelSearch" placeholder="Search model or provider…">
        </div>
        <label class="chip" style="cursor:pointer"><input type="checkbox" id="onlyAuth" checked> authenticated only</label>
        <label class="chip" style="cursor:pointer"><input type="checkbox" id="onlyReason"> with reasoning only</label>
        <span class="sys" id="modelCount"></span>
      </div>
      <div class="modelGrid" id="modelGrid"></div>
    </div>

    <div class="sec" id="sec-auth">
      <h3>Providers &amp; authentication</h3>
      <div class="card" style="padding:.9rem 1rem"><div class="kv">${c.providers.filter((p) => p.configured || p.models > 0).map((p) => `
        <div class="k">${esc(p.id)}</div>
        <div class="v">${p.configured ? '<span class="badge ok">authenticated</span>' : '<span class="badge no">not configured</span>'}
          ${p.oauth ? '<span class="badge">oauth</span>' : ''}
          <span class="badge">${p.models} models</span> ${esc(p.detail || '')}</div>`).join('')}</div>
      </div>
    </div>

    <div class="sec" id="sec-tools">
      <h3>Active tools (${(c.tools ?? []).filter((t) => t.active).length}/${(c.tools ?? []).length})</h3>
      <div class="card" style="padding:.5rem 1rem">
        ${(c.tools ?? []).map((t) => `<div class="toolItem"><span class="n">${esc(t.name)}</span>
          <span class="d">${esc(t.description)}</span><span style="flex:1"></span>
          <span class="badge ${t.active ? 'ok' : ''}">${t.active ? 'active' : 'off'}</span></div>`).join('') || '<div class="sys">—</div>'}
      </div>
    </div>

    <div class="sec" id="sec-paths">
      <h3>Paths</h3>
      <div class="card" style="padding:.9rem 1rem"><div class="kv">
        ${Object.entries(c.paths).map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}
      </div></div>
    </div>

    <div class="sec" id="sec-raw">
      <h3>settings.json (raw)</h3>
      <pre class="raw">${esc(JSON.stringify(st.raw ?? {}, null, 2))}</pre>
    </div>

    <div class="sec">
      <h3>models.json (raw)</h3>
      <pre class="raw">${esc(JSON.stringify(c.rawModels ?? {}, null, 2))}</pre>
    </div>`;

  /* ---- LAN access ---- */
  function drawNetwork(net) {
    if (net.error) { $('lanMsg').textContent = net.error; return; }
    $('lanAccessSw').classList.toggle('on', net.lanAccess);
    $('lanDetails').classList.toggle('hide', !net.lanAccess);
    $('lanIp').textContent = net.ip ?? 'no network interface';
    // The status response never carries the URL: hide it again on every redraw.
    $('lanUrl').textContent = 'hidden — use the button below';
    $('lanMsg').textContent = net.restartRequired
      ? 'Restart the server (⏻) to listen on the new interface.'
      : '';
  }
  drawNetwork(await api('/api/network'));
  const setLanAccess = async (body) => drawNetwork(await post('/api/network', body));
  const lanSw = $('lanAccessSw');
  const toggleLan = () => setLanAccess({ lanAccess: !lanSw.classList.contains('on') });
  lanSw.addEventListener('click', toggleLan);
  lanSw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLan(); }
  });
  $('lanRegen').addEventListener('click', () => setLanAccess({ regenerate: true }));
  $('lanReveal').addEventListener('click', async () => {
    const res = await post('/api/network', { reveal: true });
    if (res.error) { $('lanMsg').textContent = res.error; return; }
    $('lanUrl').textContent = res.url;
  });
  $('lanCopy').addEventListener('click', async () => {
    const url = $('lanUrl').textContent;
    if (!url.startsWith('http')) { $('lanMsg').textContent = 'reveal the URL first'; return; }
    await navigator.clipboard.writeText(url).catch(() => {});
    $('lanMsg').textContent = 'link copied';
  });

  /* ---- chat archiving ---- */
  function drawArchiving(cfg, msg = '') {
    if (cfg.error) return;
    applyChatArchiving(cfg.enabled);
    $('chatArchivingSw').classList.toggle('on', chatArchiving);
    $('chatArchivingDetails').classList.toggle('hide', !chatArchiving);
    $('chatArchivingMsg').textContent = msg;
  }
  drawArchiving(await api('/api/archiving'));
  const toggleArchiving = async () => {
    drawArchiving(await sendJson('PUT', '/api/archiving', { enabled: !chatArchiving }));
    loadSessions();
  };
  $('chatArchivingSw').addEventListener('click', toggleArchiving);
  $('chatArchivingSw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleArchiving(); }
  });
  $('archiveNowBtn').addEventListener('click', async () => {
    const r = await post('/api/archiving/sweep');
    if (r.error) { $('chatArchivingMsg').textContent = r.error; return; }
    drawArchiving(r, `${r.archived} chats archived`);
    loadSessions();
  });

  /* ---- generated chat titles ---- */
  let titleGen = false;
  let lunaTitleFallback = false;
  function drawTitleGen(cfg, msg = '') {
    if (cfg.error) return;
    titleGen = cfg.enabled === true;
    lunaTitleFallback = cfg.lunaTitleFallback === true;
    $('titleGenSw').classList.toggle('on', titleGen);
    $('lunaTitleFallbackSw').classList.toggle('on', lunaTitleFallback);
    // The backfill button lives behind the switch: turning the feature on is
    // the first consent, clicking the button the second one.
    $('titleGenDetails').classList.toggle('hide', !titleGen);
    $('titleGenMsg').textContent = msg;
  }
  drawTitleGen(await api('/api/title-generation'));
  const toggleTitleGen = async () => {
    drawTitleGen(await sendJson('PUT', '/api/title-generation', { enabled: !titleGen }));
  };
  $('titleGenSw').addEventListener('click', toggleTitleGen);
  $('titleGenSw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTitleGen(); }
  });
  const toggleLunaTitleFallback = async () => {
    drawTitleGen(await sendJson('PUT', '/api/title-generation', {
      lunaTitleFallback: !lunaTitleFallback,
    }));
  };
  $('lunaTitleFallbackSw').addEventListener('click', toggleLunaTitleFallback);
  $('lunaTitleFallbackSw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLunaTitleFallback(); }
  });
  $('titleGenBackfillBtn').addEventListener('click', async () => {
    const r = await post('/api/title-generation/backfill');
    if (r.error) { $('titleGenMsg').textContent = r.error; return; }
    drawTitleGen(r, r.queued
      ? `${r.queued} chats queued — their titles appear as the summaries come back`
      : 'every chat already has a title');
  });

  /* ---- full chat search ---- */
  let fullSearch = false;
  function drawFullSearch(cfg) {
    if (cfg.error) return;
    fullSearch = cfg.enabled === true;
    $('fullSearchSw').classList.toggle('on', fullSearch);
  }
  drawFullSearch(await api('/api/full-search'));
  const toggleFullSearch = async () => {
    drawFullSearch(await sendJson('PUT', '/api/full-search', { enabled: !fullSearch }));
  };
  $('fullSearchSw').addEventListener('click', toggleFullSearch);
  $('fullSearchSw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFullSearch(); }
  });

  /* ---- usage credentials handlers ---- */
  let openAIUsageEnabled = usageCfg.openai?.enabled === true;
  const openAIUsageSw = $('openaiUsageSw');
  const toggleOpenAIUsage = async () => {
    const next = !openAIUsageEnabled;
    const result = await post('/api/usage/config', { provider: 'openai-codex', enabled: next });
    if (result.error) {
      $('openaiUsageMsg').textContent = result.error;
      return;
    }
    openAIUsageEnabled = result.status?.openai?.enabled === true;
    openAIUsageSw.classList.toggle('on', openAIUsageEnabled);
    $('openaiUsageMsg').textContent = 'saved';
    setTimeout(() => { if ($('openaiUsageMsg')) $('openaiUsageMsg').textContent = ''; }, 2500);
    refreshUsage(true);
  };
  openAIUsageSw.addEventListener('click', toggleOpenAIUsage);
  openAIUsageSw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpenAIUsage(); }
  });

  function cfgMsg(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.style.color = kind === 'ok' ? 'var(--teal)' : kind === 'err' ? 'var(--red, #e5534b)' : '';
  }
  // The verdict on the credentials belongs next to the fields the user just
  // filled in, so the failures of this endpoint are shown inline and toasted
  // by nobody.
  const TEST_USAGE_QUIET = ['credentials_missing', 'usage_check_failed', 'unknown_provider'];
  async function testUsage(provider, msgId) {
    cfgMsg(msgId, 'checking…', '');
    const r = await post('/api/usage/test', { provider }, { quiet: TEST_USAGE_QUIET });
    if (r.error || !r.ok) { cfgMsg(msgId, '✗ ' + (r.error || 'not working'), 'err'); return false; }
    cfgMsg(msgId, '✓ works — data received from ' + (provider === 'anthropic' ? 'claude.ai' : 'kimi.com'), 'ok');
    return true;
  }
  // provider credentials badge: same two states for every provider
  function setCfgBadge(id, configured) {
    const badge = $(id);
    badge.textContent = configured ? 'configured' : 'not configured';
    badge.classList.toggle('ok', configured);
  }
  $('claudeCfgSave').addEventListener('click', async () => {
    const orgId = $('claudeOrgId').value.trim();
    const paste = $('claudeCookie').value.trim();
    if (!paste && !orgId) { cfgMsg('claudeCfgMsg', 'paste the cURL command copied from DevTools', 'err'); return; }
    const r = await post('/api/usage/config', { provider: 'anthropic', paste, ...(orgId ? { orgId } : {}) });
    if (r.error) { cfgMsg('claudeCfgMsg', '✗ ' + r.error, 'err'); return; }
    setCfgBadge('claudeCfgBadge', true);
    $('claudeOrgId').value = r.status?.anthropic?.orgId ?? orgId;
    $('claudeCookie').value = '';
    await testUsage('anthropic', 'claudeCfgMsg');
    refreshUsage();
  });
  $('claudeCfgTest').addEventListener('click', () => testUsage('anthropic', 'claudeCfgMsg'));
  $('kimiCfgTest').addEventListener('click', () => testUsage('kimi', 'kimiCfgMsg'));
  $('claudeCfgClear').addEventListener('click', async () => {
    await api('/api/usage/credentials/anthropic', { method: 'DELETE' });
    setCfgBadge('claudeCfgBadge', false);
    $('claudeOrgId').value = ''; $('claudeCookie').value = ''; cfgMsg('claudeCfgMsg', '', '');
    refreshUsage();
  });
  $('kimiCfgSave').addEventListener('click', async () => {
    const paste = $('kimiBearer').value.trim();
    if (!paste) { cfgMsg('kimiCfgMsg', 'paste the cURL command copied from DevTools', 'err'); return; }
    const r = await post('/api/usage/config', { provider: 'kimi', paste });
    if (r.error) { cfgMsg('kimiCfgMsg', '✗ ' + r.error, 'err'); return; }
    setCfgBadge('kimiCfgBadge', true);
    $('kimiBearer').value = '';
    await testUsage('kimi', 'kimiCfgMsg');
    refreshUsage();
  });
  $('kimiCfgClear').addEventListener('click', async () => {
    await api('/api/usage/credentials/kimi', { method: 'DELETE' });
    setCfgBadge('kimiCfgBadge', false);
    $('kimiBearer').value = ''; cfgMsg('kimiCfgMsg', '', '');
    refreshUsage();
  });

  /* ---- agent bootstrap ---- */
  bindBootstrapFileActions(body, {
    key: renderedChatKey,
    refresh: async () => {
      await renderSettings();
      $('sec-agent')?.scrollIntoView({ block: 'start' });
    },
  });
  $('bootstrapToolsSave').addEventListener('click', async () => {
    const tools = $$('[data-bootstrap-tool]:checked', body).map((input) => input.dataset.bootstrapTool);
    const result = await sendJson('PUT', '/api/agent-bootstrap/tools', { tools });
    if (result.error) return;
    $('bootstrapToolsMsg').textContent = 'Saved · empty drafts reloaded';
  });
  $('bootstrapToolsReset').addEventListener('click', async () => {
    const result = await sendJson('PUT', '/api/agent-bootstrap/tools', { tools: null });
    if (result.error) return;
    await renderSettings();
    $('sec-agent')?.scrollIntoView({ block: 'start' });
  });
  /* ---- save handlers ---- */
  async function saveSetting(key, value, okEl) {
    const r = await post('/api/settings', { key, value });
    if (r.error) return false;
    if (okEl) { okEl.textContent = r.restart ? 'saved · restart' : 'saved'; okEl.classList.add('show'); setTimeout(() => okEl.classList.remove('show'), 2500); }
    return true;
  }
  body.querySelectorAll('.sw[data-key]').forEach((sw) => {
    const toggle = async () => {
      const next = !sw.classList.contains('on');
      if (await saveSetting(sw.dataset.key, next, $(sw.id + '_ok'))) sw.classList.toggle('on', next);
    };
    sw.addEventListener('click', toggle);
    sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  body.querySelectorAll('select[data-key]').forEach((sel) => {
    sel.addEventListener('change', () => saveSetting(sel.dataset.key, sel.value === '' ? null : sel.value, $(sel.id + '_ok')));
  });
  body.querySelectorAll('input[data-key]').forEach((inp) => {
    const save = () => saveSetting(inp.dataset.key,
      inp.value === '' ? null : (inp.dataset.type === 'number' ? Number(inp.value) : inp.value),
      $(inp.id + '_ok'));
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  });

  /* ---- themes ---- */
  body.querySelectorAll('.themeCard[data-t]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.t)));
  body.querySelectorAll('.accentDot[data-a]').forEach((b) => b.addEventListener('click', () => applyAccent(b.dataset.a)));
  body.querySelectorAll('.logoStyleCard').forEach((b) => b.addEventListener('click', () => applyLogoStyle(b.dataset.l)));
  applyLogoStyle(localStorage.getItem('piLogoStyle') || 'brand');
  applyTheme(document.documentElement.dataset.theme);
  applyAccent(localStorage.getItem('piAccent') || '');

  /* ---- enabledModels: allow-list per provider and per model ---- */
  // An empty list is pi's default and means "everything enabled": it must not be
  // confused with "nothing enabled".
  const providerPattern = (provider) => `${provider}/*`;
  const modelPattern = (m) => `${m.provider}/${m.id}`;
  const authedModels = c.models.filter((m) => m.authed);
  const authedProviders = [...new Set(authedModels.map((m) => m.provider))].sort();
  let enabledPatterns = c.options?.enabledModels ?? [];

  const checkbox = (pattern, label, on, provider, modelId = '') =>
    `<label class="chip" style="cursor:pointer"><input type="checkbox" data-pattern="${esc(pattern)}" ${on ? 'checked' : ''}>${providerIconHtml(provider, modelId)} ${esc(label)}</label>`;

  function drawEnabled() {
    const on = new Set(enabledPatterns);
    $('enabledHint').textContent = enabledPatterns.length
      ? `${enabledPatterns.length} active patterns: ${enabledPatterns.join(', ')}`
      : 'Empty list: every model of the authenticated providers is enabled.';
    $('enabledProviders').innerHTML = authedProviders
      .map((p) => checkbox(providerPattern(p), p, on.has(providerPattern(p)), p)).join('')
      || '<div class="sys">No authenticated provider</div>';
    const q = $('enabledSearch').value.trim().toLowerCase();
    const list = authedModels.filter((m) => !q
      || `${m.provider} ${m.id} ${m.name ?? ''}`.toLowerCase().includes(q));
    $('enabledModelList').innerHTML = list
      .map((m) => checkbox(modelPattern(m), modelPattern(m), on.has(modelPattern(m)), m.provider, m.id)).join('')
      || '<div class="sys">No model matches the search</div>';
  }

  async function saveEnabled(patterns) {
    const r = await post('/api/settings', { key: 'enabledModels', value: patterns });
    if (r.error) { $('enabledMsg').textContent = '✗ ' + r.error; drawEnabled(); return; }
    enabledPatterns = r.value ?? [];
    $('enabledMsg').textContent = 'saved';
    drawEnabled();
    loadModels({ force: true });   // explicit invalidation: the global picker changed
  }

  const onEnabledToggle = (e) => {
    const box = e.target.closest('input[data-pattern]');
    if (!box) return;
    const pattern = box.dataset.pattern;
    saveEnabled(box.checked
      ? [...new Set([...enabledPatterns, pattern])]
      : enabledPatterns.filter((p) => p !== pattern));
  };
  $('enabledProviders').addEventListener('change', onEnabledToggle);
  $('enabledModelList').addEventListener('change', onEnabledToggle);
  $('enabledSearch').addEventListener('input', drawEnabled);
  $('enabledClear').addEventListener('click', () => saveEnabled([]));
  drawEnabled();

  /* ---- model grid with filters (1000+ models registered) ---- */
  const grid = $('modelGrid');
  function drawGrid() {
    const q = $('modelSearch').value.trim().toLowerCase();
    const list = c.models
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => (!$('onlyAuth').checked || m.authed)
        && (!$('onlyReason').checked || m.reasoning)
        && (!q || `${m.provider} ${m.id} ${m.name ?? ''}`.toLowerCase().includes(q)))
      .slice(0, 180);
    $('modelCount').textContent = `${list.length} shown out of ${c.models.length}`;
    grid.innerHTML = list.map(({ m, i }) => `
      <button class="modelCard ${c.current && m.provider === c.current.provider && m.id === c.current.id ? 'sel' : ''} ${m.authed ? '' : 'off'}" data-i="${i}" ${m.authed ? '' : 'disabled title="provider not authenticated"'}>
        <div class="h">${providerIconHtml(m.provider, m.id, 'lg')}
          <div style="min-width:0"><div class="nm">${esc(m.name || m.id)}</div><div class="pv">${esc(m.provider)}/${esc(m.id)}</div></div>
        </div>
        <div class="row">
          ${m.contextWindow ? `<span class="badge">ctx ${fmt(m.contextWindow)}</span>` : ''}
          ${m.reasoning ? `<span class="badge ok">effort: ${m.thinkingLevels.filter((l) => l !== 'off').join(' · ') || 'yes'}</span>` : '<span class="badge">no reasoning</span>'}
          ${m.input != null ? `<span class="badge">${m.input}/M in</span>` : ''}
          ${m.output != null ? `<span class="badge">${m.output}/M out</span>` : ''}
          ${m.authed ? '' : '<span class="badge no">no auth</span>'}
        </div>
      </button>`).join('') || '<div class="sys">No model matches the filters</div>';
    grid.querySelectorAll('.modelCard[data-i]').forEach((b) => b.addEventListener('click', () => {
      const m = c.models[+b.dataset.i];
      if (m.authed) selectModel(m.provider, m.id);
    }));
  }
  $('modelSearch').addEventListener('input', drawGrid);
  $('onlyAuth').addEventListener('change', drawGrid);
  $('onlyReason').addEventListener('change', drawGrid);
  drawGrid();
}


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
window.addEventListener('resize', autoGrow);
input.addEventListener('input', () => {
  const key = activeChatKey();
  if (key) chatCache.setDraft(key, input.value);
  autoGrow();
  updateCmdMenu();
});
input.addEventListener('click', updateCmdMenu);
input.addEventListener('blur', () => setTimeout(closeCmdMenu, 150));
let composerSubmitting = false;
function setComposerSubmitting(value) {
  composerSubmitting = value;
  $('sendBtn').disabled = value;
  $('queueActions').querySelectorAll('button').forEach((button) => { button.disabled = value; });
}
function appendMessageImage(body, { src, alt = 'Attached image', title = alt }) {
  let media = body.querySelector(':scope > .media');
  if (!media) {
    media = document.createElement('div');
    media.className = 'media';
    body.appendChild(media);
  }
  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  image.title = `${title} — click to enlarge`;
  media.appendChild(image);
  return image;
}
function acceptedUserTurn(text, attachments) {
  const turn = document.createElement('div');
  turn.className = 'turn user';
  turn.dataset.sig = 'user';
  const body = document.createElement('div');
  body.className = 'body';
  if (attachments.length) {
    const media = document.createElement('div');
    media.className = 'media';
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        const image = document.createElement('img');
        image.src = attachment.url;
        image.alt = attachment.name;
        image.title = attachment.name + ' — click to enlarge';
        media.appendChild(image);
      } else {
        const file = document.createElement('span');
        file.className = 'filechip';
        file.textContent = '📄 ' + attachment.name;
        media.appendChild(file);
      }
    }
    body.appendChild(media);
  }
  if (text) {
    const skill = skillInvocationFromCommand(text, commandsCache());
    if (skill) {
      body.appendChild(skillInvocationElement(skill));
    } else {
      const message = document.createElement('div');
      message.className = 'msg user';
      message.textContent = text;
      body.appendChild(message);
    }
  }
  turn.appendChild(body);
  return turn;
}
function clearAcceptedComposer(entry, draft, attachments) {
  if (entry.composer.draft === draft) chatCache.setDraft(entry.key, '');
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
  chatCache.setDraft(key, draft);
  entry.composer.attachments = pending;

  const images = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => ({ data: attachment.data, mimeType: attachment.mimeType }));
  let payload = text;
  for (const attachment of attachments.filter((item) => item.kind === 'file')) {
    payload += `\n\n--- attached file: ${attachment.name} ---\n\`\`\`\n${attachment.text}\n\`\`\``;
  }
  const anchor = chat.lastElementChild;
  setComposerSubmitting(true);
  try {
    const body = { text: payload, images };
    if (queueType) body.type = queueType;
    const result = await post('/api/prompt', body, { key, guardChat: true });
    if (result.error) return;

    clearAcceptedComposer(entry, draft, attachments);
    // HTTP confirms acceptance, not current queue membership. A newer SSE
    // dispatch/cancel may already have removed this item before HTTP arrives.
    if (result.queued) return;

    uiState.chatState(entry.key).started = true;
    if (entry.key === activeChatKey() && entry.key === renderedChatKey) {
      const hero = $('hero');
      const insertionAnchor = anchor === hero ? null : anchor;
      hero?.remove();
      setHeroMode(false);
      const turn = acceptedUserTurn(text, attachments);
      if (insertionAnchor?.parentNode === chat) insertionAnchor.after(turn);
      else chat.prepend(turn);
      scrollDown();
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
    autoGrow();
    return true;
  }
  const next = num ? String(Number(num) + 1) + (punc || '.') : marker;
  const insert = '\n' + indent + next + ws;
  input.value = before + insert + rest;
  input.selectionStart = input.selectionEnd = before.length + insert.length;
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
chat.addEventListener('click', async (e) => {
  const queueRemove = e.target.closest('[data-queue-remove]');
  if (queueRemove) {
    await cancelQueuedPrompt(queueRemove.dataset.queueRemove);
    return;
  }
  const copyBtn = e.target.closest('.codeCopyBtn');
  if (copyBtn) {
    const pre = copyBtn.closest('.codeBox')?.querySelector('pre');
    const codeEl = pre?.querySelector('code');
    await copyToClipboard(codeEl ? codeEl.innerText : pre?.innerText, copyBtn);
    return;
  }
  const runBtn = e.target.closest('.codeRunBtn');
  if (runBtn) {
    const r = await post('/api/type-command', { command: runBtn.dataset.command });
    if (!r.error) toast('Command typed in a new terminal — press Enter there to run it', true);
    return;
  }
  const link = e.target.closest('.md a');
  if (link && isLocalLink(link.getAttribute('href'))) {
    e.preventDefault();
    const r = await post('/api/open-local-path', { href: link.getAttribute('href') }, {
      key: activeChatKey(), guardChat: true,
    });
    if (!r.error) toast('Opened ' + r.path, true);
    return;
  }
  const img = e.target.closest('.media img, .msg img');
  if (img) openLightbox(img.src, img.alt);
});
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
  const result = await post('/api/abort');
  if (!result.error) closeResponseSpinner();
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
async function refreshGit({ key = activeChatKey() ?? renderedChatKey, projectCwd = projectScopeForChat(key)?.cwd } = {}) {
  if (!key || !projectCwd) return;
  const owner = uiState.projectState(projectCwd);
  const g = await api('/api/git', undefined, {
    key,
    guard: () => isProjectScopeActive(owner.cwd),
  });
  if (g.error) return;
  owner.git = g;
  if (isProjectScopeActive(owner.cwd)) renderGit(owner);
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
      await Promise.all([refreshGit(), loadFiles()]);
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
(async () => {
  if (renderedChatKey) restoreChatView(renderedChatKey);
  connect();
  await loadState();
  // Global catalogs load once at bootstrap. Ordinary chat/tab switches only
  // synchronize the selected chat, its project and the global session list.
  await Promise.all([loadModels(), loadCommands(), loadRecentCwds()]);
  await loadSessions();
  await loadTerminals();
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
// git branch / pending changes — light poll (the server caches for 5s)
setInterval(() => { if (!document.hidden) refreshGit(); }, 20000);
