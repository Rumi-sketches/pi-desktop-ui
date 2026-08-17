// Page logic of pi desktop ui, extracted from index.html so the page can ship
// a CSP without 'unsafe-inline'. ES module: it runs deferred, after parsing.

// highlight.js ships only as ES modules; syntax highlighting kicks in as soon
// as this module runs, and every call site already guards on win.hljs.
// @ts-expect-error the specifier is a server route, not a path the checker can
// resolve on disk: /vendor/ is served from node_modules at runtime.
import hljs from "/vendor/highlight.js/es/common.js";

// The vendored libraries (marked, DOMPurify) load as classic scripts and land
// on `window` with no declarations of their own; hljs is put there for them.
// One untyped view of the global object, instead of a cast per call site.
const win = /** @type {any} */ (window);
win.hljs = hljs;

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
const state = { cwd: '', model: null, thinking: 'off', thinkingLevels: ['off'], streaming: false, turnModel: null };

/* ---------------- per-tab chat binding ----------------
   Every tab is bound to ONE chat (its "session key" = the session file path).
   It lives in sessionStorage (per-tab) and in the URL hash, so a tab can be
   duplicated/reopened on the same chat.
   The server keeps the chat alive even when no tab is watching it: leaving a
   chat no longer interrupts anything. */
let sessionKey = null;
try {
  const h = new URLSearchParams(location.hash.slice(1)).get('s');
  sessionKey = h || sessionStorage.getItem('piSessionKey') || null;
} catch { sessionKey = null; }
function setSessionKey(k, { reconnect = true } = {}) {
  if (!k || k === sessionKey) { if (k) currentSessionPath = k; return; }
  sessionKey = k;
  currentSessionPath = k;
  resetTasks();                    // background tasks are per-chat
  try { sessionStorage.setItem('piSessionKey', k); } catch {}
  history.replaceState(null, '', '#s=' + encodeURIComponent(k));
  if (reconnect) connect();
}

if (win.marked) win.marked.setOptions({ breaks: true, gfm: true });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n ?? 0));
// amounts below $1 need 4 decimals to stay readable, above it 2 are enough
const money = (n) => { const v = n ?? 0; return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2)); };
const atBottom = () => chatWrap.scrollHeight - chatWrap.scrollTop - chatWrap.clientHeight < 90;
const scrollDown = () => { chatWrap.scrollTop = chatWrap.scrollHeight; };

const TOAST_LIFETIME_MS = 6000;
function toast(msg, ok = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : '');
  t.textContent = msg;
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
const withKey = (url) =>
  sessionKey ? url + (url.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(sessionKey) : url;
async function api(url, opts, { quiet = [] } = {}) {
  try {
    const r = await fetch(url.startsWith('/api/') ? withKey(url) : url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      const err = errorInfo(d, `${url}: HTTP ${r.status}`);
      if (!quiet.includes(err.code)) toast(err.message);
      return { error: err.message, code: err.code };
    }
    if (d.key) setSessionKey(d.key, { reconnect: d.key !== sessionKey && !!sessionKey });
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

/* ---------------- provider logos ----------------
   Minimal glyphs on a 24x24 grid, all with the same optical weight.
   The colour is never baked into the SVG (currentColor + inline background), so
   the "mono" theme in settings can turn brand colours off via CSS. */
const LOGOS = {
  anthropic: { bg: '#d97757', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.6 5h-3.2L5.2 19h2.9l1.1-3.1h5.6L15.9 19h2.9zM10.1 13.4 12 8.2l1.9 5.2z"/></svg>' },
  // official OpenAI logo (knot), path from Simple Icons
  openai:    { bg: '#0b0b0b', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>' },
  google:    { bg: '#f4f6fa', fg: '#4285f4', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2c.6 4.4 4.4 8.2 8.8 8.8-4.4.6-8.2 4.4-8.8 8.8-.6-4.4-4.4-8.2-8.8-8.8 4.4-.6 8.2-4.4 8.8-8.8z"/></svg>' },
  kimi:      { bg: '#0f0f0f', fg: '#00e5a0', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5v14"/><path d="M17 5.5 8.6 12 17 18.5"/></svg>' },
  moonshot:  { bg: '#0f0f0f', fg: '#00e5a0', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.4 14.6A8.4 8.4 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11z"/></svg>' },
  deepseek:  { bg: '#4d6bfe', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12c4 0 6-1.9 7.5-5 1.5 3.1 3.5 5 7.5 5-4 0-6 1.9-7.5 5-1.5-3.1-3.5-5-7.5-5z"/></svg>' },
  xai:       { bg: '#0b0b0b', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4.5h3.2l9.3 15h-3.2zM5.6 19.5l4.9-6 1.7 2.7-2.2 3.3z"/></svg>' },
  mistral:   { bg: '#ff7000', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 5h3.6v3.6H3.5zm6.7 0h3.6v3.6h-3.6zm6.7 0h3.6v3.6h-3.6zM3.5 10.2h17v3.6h-17zM3.5 15.4h3.6V19H3.5zm13.4 0h3.6V19h-3.6z"/></svg>' },
  meta:      { bg: '#0866ff', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3.6 15.4c1.2-5.6 3.1-7.8 5-7.8 1.9 0 3 1.9 4.2 4.1 1.2 2.2 2.2 3.7 3.7 3.7 1.6 0 2.6-1.6 2.6-4.1 0-2.5-1-3.9-2.3-3.9"/></svg>' },
  ollama:    { bg: '#f4f6fa', fg: '#111', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6.5 14c0-3 2.4-5 5.5-5s5.5 2 5.5 5-2.4 5.5-5.5 5.5S6.5 17 6.5 14z"/><path d="M7.3 9.4C6.6 7.2 6.8 4.6 8 4.4c1.2-.2 2.1 1.6 2.2 3.6M16.7 9.4c.7-2.2.5-4.8-.7-5-1.2-.2-2.1 1.6-2.2 3.6"/></svg>' },
  groq:      { bg: '#f55036', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.4 3 6 13.2h4.6L9.8 21l7.6-10.4h-4.7z"/></svg>' },
  openrouter:{ bg: '#151515', fg: '#8ab4ff', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12h4l3 5h6.5"/><path d="M3.5 12h4l3-5h6.5"/><path d="M15.5 4.5 19.5 7l-4 2.5zM15.5 14.5 19.5 17l-4 2.5z"/></svg>' },
  github:    { bg: '#24292e', fg: '#fff', svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.6-.2.6-.5v-1.8c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6 0-.6 0-.6 1 .1 1.5 1 1.5 1 .8 1.4 2.2 1 2.7.8.1-.6.3-1 .6-1.3-2.1-.2-4.3-1.1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a8.9 8.9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z"/></svg>' },
  _:         { bg: '#1a2130', fg: '#8d97a8', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7.5"/><path d="M12 8.2v7.6M8.2 12h7.6"/></svg>' },
};
function logoFor(provider, id = '') {
  const k = (provider + ' ' + id).toLowerCase();
  for (const name of Object.keys(LOGOS)) if (name !== '_' && k.includes(name)) return LOGOS[name];
  if (k.includes('claude') || k.includes('fable') || k.includes('opus') || k.includes('sonnet') || k.includes('haiku')) return LOGOS.anthropic;
  if (k.includes('gpt') || k.match(/\bo[34]\b/)) return LOGOS.openai;
  if (k.includes('gemini')) return LOGOS.google;
  if (k.includes('k2') || k.includes('k3')) return LOGOS.kimi;
  if (k.includes('llama')) return LOGOS.meta;
  if (k.includes('grok')) return LOGOS.xai;
  return LOGOS._;
}
const logoHtml = (p, id, cls = '') => {
  const l = logoFor(p, id);
  return `<span class="logo ${cls}" style="background:${l.bg};color:${l.fg}">${l.svg}</span>`;
};
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
const modelDd = setupDd('modelDd', 'modelBtn');
const thinkDd = setupDd('thinkDd', 'thinkBtn');
const cwdDd = setupDd('cwdDd', 'cwdChip');
setupDd('statsDd', 'stats');
const filterDd = setupDd('filterDd', 'filterBtn');
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
  });
});
renderFilterMenu();
document.addEventListener('click', () => {
  closeFlyouts();
  document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
});

/* ---------------- chat rendering (everything left-aligned, no bubbles) ---------------- */
function renderMarkdown(div) {
  // The model's markdown can carry attacker-influenced content (files, tool
  // output, fetched pages): sanitize before it ever touches innerHTML.
  div.innerHTML = win.marked && win.DOMPurify
    ? win.DOMPurify.sanitize(win.marked.parse(div.dataset.raw ?? ''))
    : esc(div.dataset.raw ?? '');
  if (win.hljs) $$('pre code', div).forEach((el) => hljs.highlightElement(el));
  addCopyButtons(div);
}

/* ---- copy-to-clipboard: whole messages and single code/context blocks ---- */
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
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
  setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('copied'); delete btn.dataset.flashing; }, 1200);
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
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const codeEl = pre.querySelector('code');
      copyToClipboard(codeEl ? codeEl.innerText : pre.innerText, btn);
    });
    wrap.appendChild(btn);
  });
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
  copyBtn.addEventListener('click', () => copyToClipboard(div.dataset.raw ?? div.textContent, copyBtn));
  bar.appendChild(copyBtn);
  if (entryId) {
    const forkBtn = document.createElement('button');
    forkBtn.type = 'button';
    forkBtn.className = 'msgActionBtn';
    forkBtn.title = 'New chat from here';
    forkBtn.innerHTML = ICON_FORK;
    forkBtn.addEventListener('click', () => forkFrom(entryId));
    bar.appendChild(forkBtn);
  }
  body.appendChild(bar);
}
async function forkFrom(entryId) {
  const r = await post(sessionPath(sessionKey, 'fork'), { entryId });
  if (r.error) return;
  setSessionKey(r.key);
  await refreshAll();
  toast('New chat created from this point', true);
}
function newTurn(role, model = null) {
  $('hero')?.remove();
  // Consecutive messages from the same speaker (same model, for the assistant)
  // stay in the same turn: avatar and name show up once, until the other side
  // answers.
  const last = chat.lastElementChild;
  if (last?.classList.contains('turn') && last.classList.contains(role)) {
    const m = role === 'user' ? null : (model ?? state.turnModel ?? state.model);
    const sig = role === 'user' ? 'user' : `${m?.provider ?? ''}/${m?.id ?? m?.model ?? ''}`;
    if (last.dataset.sig === sig) return last.querySelector('.body');
  }
  const t = document.createElement('div');
  t.className = 'turn ' + role;
  if (role === 'user') {
    t.dataset.sig = 'user';
    t.innerHTML = `<div class="avatar">TU</div>
      <div class="body"><div class="who">Tu</div></div>`;
  } else {
    // the assistant turn is labeled with the model that produced it (it can
    // change mid-chat): provider logo as avatar + model name instead of "pi"
    const m = model ?? state.turnModel ?? state.model;
    const pid = m?.provider ?? '';
    const mid = m ? (m.id ?? m.model ?? '') : '';
    const pretty = m?.name || modelsCache.find((x) => x.provider === pid && x.id === mid)?.name || mid;
    t.dataset.sig = `${pid}/${mid}`;
    t.innerHTML = m
      ? `<div class="avatar hasLogo" title="${esc(pid)}/${esc(mid)}">${logoHtml(pid, mid)}</div>
         <div class="body"><div class="who">${esc(pretty)} <span class="mprov">${esc(pid)}</span></div></div>`
      : `<div class="avatar">π</div>
         <div class="body"><div class="who">pi</div></div>`;
  }
  chat.appendChild(t);
  return t.querySelector('.body');
}
function bubble(cls, text = '', body = null) {
  const stick = atBottom();
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  if (cls === 'assistant') { div.classList.add('md'); div.dataset.raw = text; renderMarkdown(div); }
  else div.textContent = text;
  (body ?? newTurn(cls === 'user' ? 'user' : 'pi')).appendChild(div);
  if (stick) scrollDown();
  return div;
}
function appendMd(div, delta) {
  const stick = atBottom();
  div.dataset.raw = (div.dataset.raw ?? '') + delta;
  renderMarkdown(div);
  if (stick) scrollDown();
}
// plain-text streaming (thinking): same stickiness rule as markdown, otherwise
// during reasoning the view stays put and the text scrolls out of sight
function appendText(div, delta) {
  const stick = atBottom();
  div.textContent += delta;
  if (stick) scrollDown();
}
/* ---- tool calls: expandable card showing exactly what the model is doing ---- */
const toolCards = new Map(); // toolCallId -> element
function renderTool(ev) {
  if (!currentTurn) currentTurn = newTurn('pi');
  let card = ev.id ? toolCards.get(ev.id) : null;
  if (!card) {
    const stick = atBottom();
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
    card.querySelector('.toolHead').addEventListener('click', () => card.classList.toggle('open'));
    currentTurn.appendChild(card);
    if (ev.id) toolCards.set(ev.id, card);
    addCopyButtons(card);
    if (stick) scrollDown();
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
}

const SUGG = [
  { t: 'Explore', c: '#2fe0c0', d: 'Give me an overview of this project', p: 'Give me an overview of this project structure and of what it does.' },
  { t: 'Debug', c: '#f8a5a5', d: 'Find and fix a bug', p: 'Analyse the code and point out possible bugs or problems.' },
  { t: 'Refactor', c: '#a5b4fc', d: 'Improve the existing code', p: 'Suggest a refactoring of the main files of this project.' },
];
function showHero() {
  if (chat.children.length) return;
  const h = document.createElement('div');
  h.id = 'hero';
  h.innerHTML = `<h1>Hi 👋<br><span class="dim">What are we building today?</span></h1>
    <p>Working folder: <code>${esc(state.cwd || '…')}</code></p>
    <div class="cards">${SUGG.map((s, i) => `
      <button class="sugg" data-i="${i}">
        <span class="tag" style="background:${s.c}22;color:${s.c}">${s.t}</span>
        <div class="d">${esc(s.d)}</div>
      </button>`).join('')}</div>`;
  chat.appendChild(h);
  $$('.sugg', h).forEach((b) => b.addEventListener('click', () => {
    $('input').value = SUGG[+b.dataset.i].p;
    autoGrow(); $('input').focus();
  }));
}
// Counter shows *this chat only*: fresh tokens per turn (prompt + cache writes +
// output). Cache reads are excluded because they re-count context already paid for.
let lastByModel = {};   // provider/model -> {tokens,cost,requests,...} for this chat
let lastChat = null;    // last known chat totals, to resync without an 'usage' event
function renderStats(chat, context, byModel) {
  const c = chat ?? lastChat ?? { tokens: 0, cost: 0, requests: 0 };
  lastChat = c;
  if (byModel) lastByModel = byModel;
  $('stats').textContent = `${fmt(c.tokens)} token · $${(c.cost ?? 0).toFixed(4)}`;
  $('stats').title =
    `tokens in this chat: ${fmt(c.tokens)}\n` +
    `  input: ${fmt(c.input)} · output: ${fmt(c.output)} · cache write: ${fmt(c.cacheWrite)}\n` +
    `  (cache read excluded: ${fmt(c.cacheRead)}, it is context already counted)\n` +
    `requests: ${c.requests} · estimated cost: $${(c.cost ?? 0).toFixed(4)}\n` +
    `click for the per-model breakdown`;
  renderStatsMenu(c);
  if (context?.window > 0) {
    const pct = Math.min(100, 100 * context.used / context.window);
    $('ctxFill').style.width = pct + '%';
    $('ctxFill').className = pct > 85 ? 'crit' : pct > 60 ? 'warn' : '';
    $('ctxBar').title = `context: ${fmt(context.used)} / ${fmt(context.window)} tokens (${pct.toFixed(1)}%)`;
    $('composerCtx').textContent = `${state.model ? state.model.id : 'pi'} · context ${pct.toFixed(0)}%`;
  }
}
// counter popover: one row per LLM used in this chat
// (switching model mid-chat no longer mixes the counts)
function renderStatsMenu(c) {
  const rows = Object.entries(lastByModel ?? {}).sort((a, b) => b[1].cost - a[1].cost);
  let html = '<div class="dd-group">Tokens and cost of this chat, per model</div>';
  if (!rows.length) html += '<div class="sys" style="padding:.4rem .55rem">no answer yet</div>';
  for (const [key, m] of rows) {
    const slash = key.indexOf('/');
    const p = slash > 0 ? key.slice(0, slash) : '';
    const id = slash > 0 ? key.slice(slash + 1) : key;
    html += `<div class="statsRow">${logoHtml(p, id)}<span class="nm" title="${esc(key)}">${esc(id)}</span>
      <span class="vals">${fmt(m.tokens)} tok · <b>${money(m.cost)}</b> · ${m.requests} req</span></div>`;
  }
  if (rows.length > 1) {
    html += `<div class="statsRow total"><span class="nm">Chat total</span>
      <span class="vals">${fmt(c.tokens)} tok · <b>${money(c.cost)}</b> · ${c.requests} req</span></div>`;
  }
  $('statsMenu').innerHTML = html;
}
function setRunning(on) {
  state.streaming = on;
  $('runState').classList.toggle('on', on);
  if (!on) { currentAssistant = currentThinking = currentTurn = null; }
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
function setUsageBar(pct, severityOrWarnCrit, barId) {
  const bar = $(barId ?? 'usageWidgetBar');
  const i = bar.querySelector('i');
  const p = Math.max(0, Math.min(100, pct ?? 0));
  i.style.width = p + '%';
  bar.classList.remove('warn', 'crit');
  if (severityOrWarnCrit === 'critical' || p > 90) bar.classList.add('crit');
  else if (severityOrWarnCrit === 'warning' || p > 70) bar.classList.add('warn');
}
// second widget bar: usage of the long window (weekly/period), hidden when the
// provider does not expose it
function setUsageBar2(pct, severityOrWarnCrit, text) {
  const txt = $('usageWidgetTxt2');
  $('usageWidgetBar2').classList.remove('hide');
  txt.classList.remove('hide');
  setUsageBar(pct, severityOrWarnCrit, 'usageWidgetBar2');
  txt.textContent = text;
}
function hideUsageBar2() {
  $('usageWidgetBar2').classList.add('hide');
  $('usageWidgetTxt2').classList.add('hide');
}
let usageCache = null;
async function refreshUsage(force) {
  usageCache = await api('/api/usage' + (force ? '?force=1' : ''));
  renderUsageWidget();
}
function renderUsageWidget() {
  const w = $('usageWidget'), label = $('usageWidgetLabel'), txt = $('usageWidgetTxt');
  const u = usageCache;
  const provider = state.model?.provider;
  if (!u || u.error || !provider) { w.classList.remove('show'); return; }

  if (provider === 'anthropic' && u.anthropic?.configured) {
    w.classList.add('show');
    label.textContent = 'Claude';
    txt.classList.remove('err');
    if (u.anthropic.error) {
      txt.textContent = u.anthropic.error; txt.classList.add('err'); setUsageBar(0);
      hideUsageBar2();
      w.title = u.anthropic.error;
    } else {
      const fh = u.anthropic.fiveHour;
      const sd = u.anthropic.sevenDay;
      const sev = u.anthropic.limits?.[0]?.severity;
      setUsageBar(fh?.percent, sev);
      txt.textContent = fh ? `${Math.round(fh.percent)}%` : 'n/a';
      // remaining weekly allowance: claude.ai calls it "seven_day", shown nowhere
      // else in the official UI
      if (sd && typeof sd.percent === 'number') {
        const sevSev = u.anthropic.limits?.find((l) => l.kind === 'seven_day')?.severity;
        setUsageBar2(sd.percent, sevSev, `week ${Math.round(sd.percent)}%`);
      } else {
        hideUsageBar2();
      }
      w.title = [
        fh ? `Claude — 5h: ${Math.round(fh.percent)}% · ${fmtCountdown(fh.resetsAt)}` : 'Claude — 5h data unavailable',
        sd && typeof sd.percent === 'number' ? `week: ${Math.round(sd.percent)}% · ${fmtCountdown(sd.resetsAt)}` : null,
      ].filter(Boolean).join('\n');
    }
    return;
  }

  if (provider === 'kimi-coding' && u.kimi?.configured) {
    w.classList.add('show');
    label.textContent = 'Kimi';
    txt.classList.remove('err');
    if (u.kimi.error) {
      txt.textContent = u.kimi.error; txt.classList.add('err'); setUsageBar(0);
      hideUsageBar2();
      w.title = u.kimi.error;
    } else {
      const coding = u.kimi.usages?.find((x) => x.scope === 'FEATURE_CODING') ?? u.kimi.usages?.[0];
      const win5h = coding?.windows?.find((x) => x.durationMinutes === 300) ?? coding?.windows?.[0];
      const period = coding?.period;
      const periodPct = period?.limit ? 100 * period.used / period.limit : null;
      if (period && Number.isFinite(periodPct)) {
        setUsageBar2(periodPct, null, `sett ${Math.round(periodPct)}%`);
      } else {
        hideUsageBar2();
      }
      if (win5h) {
        const pct = win5h.limit ? 100 * win5h.used / win5h.limit : 0;
        setUsageBar(pct);
        txt.textContent = `${Math.round(pct)}%`;
        const periodTxt = period ? ` · period: ${period.used}/${period.limit} (${fmtCountdown(period.resetsAt)})` : '';
        w.title = `Kimi — 5h window: ${win5h.used}/${win5h.limit} · ${fmtCountdown(win5h.resetsAt)}${periodTxt}`;
      } else if (period) {
        const pct = periodPct ?? 0;
        setUsageBar(pct);
        txt.textContent = `${period.used}/${period.limit}`;
        w.title = `Kimi — ${period.used}/${period.limit} · ${fmtCountdown(period.resetsAt)}`;
        hideUsageBar2();
      } else {
        txt.textContent = 'n/a'; setUsageBar(0); hideUsageBar2(); w.title = 'Kimi — data unavailable';
      }
    }
    return;
  }

  w.classList.remove('show');
}

/* ---------------- SSE (with reconnect + refresh fallback) ---------------- */
let es = null;
function connect() {
  if (es) { try { es.close(); } catch {} }
  es = new EventSource(withKey('/api/events'));
  es.onopen = () => { $('conn').classList.remove('off'); $('connTxt').textContent = 'connesso'; };
  es.onerror = () => { $('conn').classList.add('off'); $('connTxt').textContent = 'reconnecting…'; };
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    try { handleEvent(ev); } catch (err) { console.error(err); toast('UI: ' + err.message); }
  };
}
function handleEvent(ev) {
  // global events: they are about the OTHER open chats, not this one
  if (ev.scope === 'global') {
    if (ev.kind === 'running') {
      if (ev.running) runningKeys.add(ev.key); else runningKeys.delete(ev.key);
      if (ev.key !== sessionKey) {
        renderSessions();
        if (!ev.running) {
          const s = allSessions.find((x) => x.path === ev.key);
          toast('Chat finished: ' + (s?.name || s?.firstMessage || '(background chat)'), true);
        }
      }
    } else if (ev.kind === 'sessions') {
      loadSessions();
    }
    return;
  }
  switch (ev.kind) {
    case 'attached':
      setSessionKey(ev.key, { reconnect: false });
      setRunning(!!ev.running);
      if (ev.running && !agentTask) setAgentTask(true, state.turnModel);
      break;
    case 'text':
      // a new text segment after thinking/tool must be appended AFTER them, in order: drop the
      // stale thinking reference so the next 'thinking' event (if any) starts a fresh bubble below
      currentThinking = null;
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
      renderTool(ev); taskFromTool(ev); break;
    case 'usage': renderStats(ev.chat, ev.context, ev.chatByModel); break;
    case 'status':
      if (ev.status === 'running') {
        setChatStarted(true);  // it is running ⇒ the chat exists
        if (ev.model) state.turnModel = ev.model;  // model answering right now (it can change mid-chat)
        setAgentTask(true, ev.model);
      } else {
        state.turnModel = null;
        setAgentTask(false);
        refreshGit();  // the agent may have touched files / branches
      }
      setRunning(ev.status === 'running'); break;
    case 'cwd':
      state.cwd = ev.path; setCwdLabel(ev.path);
      activeFile = null; refreshAll(); break;
    case 'file': loadFiles(); break;
    case 'error': bubble('sys err', (ev.aborted ? '⏹ ' : '⚠ ') + ev.message); toast(ev.message); break;
  }
}

/* ---------------- models + dynamic effort ---------------- */
let modelsCache = [];
async function loadModels() {
  const res = await api('/api/models');
  if (res.error) return;
  modelsCache = res.models ?? [];
  state.model = res.current;
  state.thinking = res.thinkingLevel ?? 'off';
  state.thinkingLevels = res.thinkingLevels?.length ? res.thinkingLevels : ['off'];
  renderModelBtn(); renderModelMenu(); renderThinking();
}
const modelMeta = () => state.model ? modelsCache.find((m) => m.provider === state.model.provider && m.id === state.model.id) : null;
function renderModelBtn() {
  const m = state.model;
  $('modelLogo').outerHTML = m
    ? logoHtml(m.provider, m.id).replace('class="logo ', 'id="modelLogo" class="logo ')
    : '<span class="logo" id="modelLogo"></span>';
  $('modelName').textContent = m ? (modelMeta()?.name || m.id) : 'no model';
  $('modelBtn').title = m ? `${m.provider}/${m.id}` : 'no authenticated model';
}
async function selectModel(provider, id) {
  const r = await post('/api/model', { provider, id });
  if (r.error) return;
  state.model = { provider, id };
  state.thinking = r.thinkingLevel ?? state.thinking;
  state.thinkingLevels = r.thinkingLevels?.length ? r.thinkingLevels : ['off'];
  renderModelBtn(); renderModelMenu(); renderThinking(); renderUsageWidget();
  // the context window depends on the model: resync bar/composer right away
  // instead of waiting for the next message (which is when it used to update)
  if (r.context) renderStats(lastChat, r.context, lastByModel);
  if (!$('settingsView').classList.contains('hide')) renderSettings();
  toast(`Model: ${id}`, true);
}
// Shift+M: cycle through the available/authenticated models
async function cycleModel() {
  if (!modelsCache.length) { toast('No model available'); return; }
  let idx = modelsCache.findIndex((m) => state.model && m.provider === state.model.provider && m.id === state.model.id);
  idx = (idx + 1) % modelsCache.length;
  const m = modelsCache[idx];
  await selectModel(m.provider, m.id);
}
// Two-level menu: providers first, models show up in a side flyout on hover
// (or on click/keyboard, for accessibility).
function renderModelMenu() {
  const menu = $('modelMenu');
  menu.innerHTML = '';
  document.querySelectorAll('body > .dd-flyout').forEach((f) => f.remove());  // flyouts of the previous render
  if (!modelsCache.length) { menu.innerHTML = '<div class="dd-group">no active model</div>'; return; }
  const byProv = {};
  for (const m of modelsCache) (byProv[m.provider] ??= []).push(m);
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
    // glued to the provider menu edge (the two borders overlap by 1px)
    const flip = menuBox.right - 1 + w > window.innerWidth - 8;
    fly.classList.toggle('flip', flip);
    fly.style.left = (flip ? Math.max(8, menuBox.left + 1 - w) : menuBox.right - 1) + 'px';
    fly.style.top = Math.max(8, Math.min(headBox.top - 5, window.innerHeight - 8 - h)) + 'px';
  };
  const closeSub = (sub) => { sub.classList.remove('open'); sub._fly.classList.remove('on'); };
  for (const [prov, list] of Object.entries(byProv)) {
    const hasSel = state.model && state.model.provider === prov;
    // `_fly` below is an expando: the flyout lives in <body>, not inside the
    // sub-menu, so the pairing has to be carried on the node itself.
    const sub = /** @type {any} */ (document.createElement('div'));
    sub.className = 'dd-sub';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dd-item' + (hasSel ? ' hasSel' : '');
    head.innerHTML = `${logoHtml(prov, hasSel ? state.model.id : list[0]?.id ?? '')}<span class="col">
      <span>${esc(prov)}</span>
      <span class="desc">${list.length} model${list.length === 1 ? '' : 's'}${hasSel ? ' · in use' : ''}</span></span>
      <svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;
    const fly = document.createElement('div');
    fly.className = 'dd-flyout';
    for (const m of list) {
      const sel = state.model && state.model.provider === m.provider && state.model.id === m.id;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-item' + (sel ? ' sel' : '');
      b.innerHTML = `${logoHtml(m.provider, m.id)}<span class="col">
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
  const levels = state.thinkingLevels?.length ? state.thinkingLevels : ['off'];
  if (!levels.includes(state.thinking)) state.thinking = levels[0];
  const only = levels.length === 1;
  $('thinkName').textContent = only && levels[0] === 'off' ? 'no reasoning' : state.thinking;
  $('thinkBtn').style.opacity = only ? '.55' : '1';
  const menu = $('thinkMenu');
  menu.innerHTML = `<div class="dd-group">Effort levels available for ${esc(state.model?.id ?? 'this model')}</div>`;
  for (const lv of levels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dd-item' + (lv === state.thinking ? ' sel' : '');
    b.innerHTML = `<span class="col"><span>${lv}</span><span class="desc">${THINK_DESC[lv] ?? ''}</span></span>`;
    b.addEventListener('click', async () => {
      thinkDd.classList.remove('open');
      const r = await post('/api/thinking', { level: lv });
      state.thinking = r.thinkingLevel ?? lv;
      renderThinking();
    });
    menu.appendChild(b);
  }
}
// Shift+T: cycle through the reasoning effort levels of the current model
async function cycleThinking() {
  const levels = state.thinkingLevels?.length ? state.thinkingLevels : ['off'];
  if (levels.length <= 1) { toast('No other effort level available for this model'); return; }
  let idx = levels.indexOf(state.thinking);
  idx = (idx + 1) % levels.length;
  const lv = levels[idx];
  const r = await post('/api/thinking', { level: lv });
  state.thinking = r.thinkingLevel ?? lv;
  renderThinking();
  toast(`Effort: ${state.thinking}`, true);
}

/* ---------------- working directory ---------------- */
function setCwdLabel(p) {
  const parts = (p || '').split(/[\\/]/).filter(Boolean);
  $('cwdLabel').textContent = parts.slice(-2).join('/') || p || '—';
  $('cwdChip').title = 'Working folder: ' + p;
  $('cwdInput').value = p;
}
/* An "empty" chat does not exist: it is just the home screen, a chat is born
   with its first prompt. While we are there the folder can be changed freely;
   as soon as the chat starts the path is part of it and the picker becomes
   read-only. */
let chatStarted = false;
function setChatStarted(v) {
  v = !!v;
  if (v === chatStarted) return;
  chatStarted = v;
  $('cwdInput').readOnly = v;
  $('cwdEditRow').style.display = v ? 'none' : '';
  $('cwdHint').textContent = v
    ? 'Chat already started: the folder can no longer be changed. Open a new chat to work somewhere else.'
    : 'Working folder: the agent reads and edits the files inside it. You pick it here before starting the chat.';
}
async function changeCwd(p) {
  if (chatStarted) { toast('This chat has already started: the folder cannot be changed.'); return; }
  p = (p ?? $('cwdInput').value).trim().replace(/^["']|["']$/g, '');
  if (!p) return;
  $('cwdMsg').textContent = 'setting…';
  const r = await post('/api/cwd', { path: p });
  $('cwdMsg').textContent = '';
  if (r.error) return; // toast already shown, chat untouched
  cwdDd.classList.remove('open');
  state.cwd = r.cwd ?? p;
  setCwdLabel(state.cwd);
  await refreshAll();               // reload sessions and projects for the new folder
  loadRecentCwds();
  toast('Folder set: the chat will start in ' + state.cwd, true);
}
$('cwdApply').addEventListener('click', () => changeCwd());
$('cwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); changeCwd(); } });
$('browseBtn').addEventListener('click', async () => {
  const btn = $('browseBtn');
  btn.disabled = true;
  try {
    // closing the dialog answers 409 `cancelled`: a choice, not a failure, so
    // it stays silent instead of raising a toast
    const d = await api('/api/pick-folder', { method: 'POST' }, { quiet: ['cancelled'] });
    if (d.error) return;
    if (d.path) await changeCwd(d.path);
  } finally { btn.disabled = false; }
});
// opens the working folder in the system file manager (changes neither chat nor folder)
$('explorerBtn').addEventListener('click', async () => {
  const r = await post('/api/open-explorer');
  if (!r.error) cwdDd.classList.remove('open');
});
// opens a terminal in the working folder and runs "pi" there
$('terminalBtn').addEventListener('click', async () => {
  const r = await post('/api/open-terminal');
  if (!r.error) toast('Terminal opened: starting pi…', true);
});

// The three native features do not exist everywhere (no picker without zenity
// on Linux, and so on): the server says what it can do and we hide the rest, so
// no button promises something that would end in an error.
function applyPlatformCapabilities(caps) {
  if (!caps) return;
  $('browseBtn').classList.toggle('hide', !caps.pickFolder);
  $('explorerBtn').parentElement.classList.toggle('hide', !caps.openFolder);
  $('terminalBtn').classList.toggle('hide', !caps.openTerminal);
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
    const cur = state.cwd && p.toLowerCase() === state.cwd.toLowerCase();
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
let allSessions = [], currentSessionPath = null;
const runningKeys = new Set();   // chats currently working (also in other tabs)
// Chat lists sort on `modified`, an ISO string: parsed once and compared as a
// number, which is what subtracting two Dates was already doing.
const modifiedAt = (s) => new Date(s.modified).getTime();
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}
async function loadSessions() {
  // no per-project filter any more: the sidebar always shows every chat,
  // "By project" grouping plus search are enough to find your way
  const res = await api('/api/sessions?scope=all');
  if (res.error) return;
  allSessions = res.sessions ?? [];
  currentSessionPath = sessionKey ?? res.current;
  runningKeys.clear();
  for (const k of res.running ?? []) runningKeys.add(k);
  renderSessions();
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
function passesSessionFilter(s) {
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
function renderSessions() {
  const q = $('sessionSearch').value.trim().toLowerCase();
  const list = allSessions.filter((s) => passesSessionFilter(s) && (!q || `${s.name || ''} ${s.firstMessage || ''} ${s.cwd || ''}`.toLowerCase().includes(q)));
  const sort = $('sortFilter').value;
  const groupBy = $('groupFilter').value;
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
  $('sessionCount').textContent = list.length;
  const el = $('sessionList');
  el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<div class="sys" style="padding:.8rem">No chat</div>'; return; }
  // grouping (independent from sorting): day / project / model.
  // By day the date order is already enough; in the other cases a stable pass is
  // needed to make the groups contiguous without touching the inner order.
  if (groupBy === 'project' || groupBy === 'model') {
    list.sort((a, b) => (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0)
      || (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)
      || groupOf(a, groupBy).localeCompare(groupOf(b, groupBy)));
  }
  let lastGroup = null;
  for (const s of list) {
    if (groupBy !== 'none') {
      const g = isDone(s) ? 'Done' : s.favorite ? 'Favorites' : groupOf(s, groupBy);
      if (g !== lastGroup) {
        lastGroup = g;
        const h = document.createElement('div');
        h.className = 'sessGroup';
        h.textContent = g;
        el.appendChild(h);
      }
    }
    const div = document.createElement('div');
    const done = isDone(s);
    div.className = 'sessionItem' + (s.path === currentSessionPath ? ' active' : '') + (done ? ' done' : '');
    const label = s.name || s.firstMessage || '(empty)';
    const proj = (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const running = runningKeys.has(s.path);
    div.innerHTML = `<div class="acts">
      ${chatArchiving ? `<button class="doneBtn${done ? ' on' : ''}" title="${done ? 'Move back to active' : 'Mark as done'}">${done ? '↺' : '✓'}</button>` : ''}
      <button class="fav${s.favorite ? ' on' : ''}" title="${s.favorite ? 'Remove from favorites' : 'Add to favorites'}">${s.favorite ? '♥' : '♡'}</button>
      </div><div class="title">${running ? '<span class="runDot"></span>' : done ? '' : '<span class="liveDot"></span>'}<span class="lbl"></span>
      ${chatArchiving && s.status === 'reopened' ? '<span class="reopened">reopened</span>' : ''}
      ${s.favorite ? '<span class="favMark">♥</span>' : ''}</div><div class="meta">
      ${s.model || s.provider ? `<span title="${esc((s.provider || '') + '/' + (s.model || ''))}">${logoHtml(s.provider || '', s.model || '')}</span>` : ''}
      ${proj ? `<span class="proj" title="${esc(s.cwd)}">${esc(proj)}</span><span>·</span>` : ''}
      <span>${s.messageCount} msg</span><span>·</span><span>${fmtDate(s.modified)}</span>
      ${running ? '<span>·</span><span style="color:var(--teal)">running</span>' : ''}</div>`;
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
      const r = await post('/api/status', { path: s.path, status: next });
      if (r.error) return;
      s.status = r.status ?? next;
      renderSessions();
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
    el.appendChild(div);
  }
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
async function openSession(s) {
  showChat();
  const r = await post(sessionPath(s.path, 'activate'), { cwd: s.cwd || undefined });
  if (r.error) return;
  setSessionKey(r.key ?? s.path);   // reattach the SSE to the new chat
  await refreshAll();               // never rely on the SSE event alone
}
async function newChat() {
  showChat();
  const r = await post('/api/sessions');
  if (r.error) return;
  setSessionKey(r.key);
  await refreshAll();
  $('input').focus();
}
$('newSessionBtn').addEventListener('click', newChat);
$('sessionSearch').addEventListener('input', renderSessions);
$('sortFilter').addEventListener('change', renderSessions);
$('groupFilter').addEventListener('change', () => {
  localStorage.setItem('piGroupBy', $('groupFilter').value);
  renderSessions();
});
$('groupFilter').value = localStorage.getItem('piGroupBy') || 'none';
// Shift+P: cycle through projects, opening the latest chat of each
async function cycleProject() {
  const opts = [...new Set(allSessions.map((s) => s.cwd).filter(Boolean))].sort();
  if (opts.length < 2) { toast('No other project available'); return; }
  let idx = opts.indexOf(state.cwd);
  idx = (idx + 1) % opts.length;
  const proj = opts[idx];
  const sessions = allSessions.filter((s) => s.cwd === proj).sort((a, b) => modifiedAt(b) - modifiedAt(a));
  if (sessions.length) await openSession(sessions[0]);
  else toast('No chat for project: ' + proj);
}
function setSidebarCollapsed(v) {
  $('sidebar').classList.toggle('collapsed', v);
  // with the sidebar closed the chat text gets even wider (see body.sb-closed)
  document.body.classList.toggle('sb-closed', v);
}
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
async function refreshChat() {
  chat.innerHTML = '';
  toolCards.clear();
  currentAssistant = currentThinking = currentTurn = null;
  await loadHistory();
}
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadState();
    await Promise.all([loadModels(), loadFiles(), loadCommands()]);
    await loadSessions();
    await refreshChat();
  } finally { refreshing = false; }
}

/* ---------------- history ---------------- */
async function loadHistory() {
  const res = await api('/api/history');
  if (res.error) return;
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
  if (res.turnModel) state.turnModel = res.turnModel;
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
      taskFromTool({ ...seg.tool, status: 'start' });
      if (seg.tool.status === 'end') { renderTool({ ...seg.tool, status: 'end' }); taskFromTool({ ...seg.tool, status: 'end' }); }
      else if (seg.tool.output) renderTool({ ...seg.tool, status: 'update' });
    }
  }
  // the folder can still be chosen only if the chat never started
  setChatStarted((res.messages ?? []).length > 0 || (res.live ?? []).length > 0);
  setRunning(!!res.streaming);
  if (res.streaming && !agentTask) setAgentTask(true, res.turnModel);
  else if (!res.streaming && agentTask && !agentTask.t1) setAgentTask(false);
  if (!chat.children.length) showHero();
  scrollDown();
}

/* ---------------- diff panel ---------------- */
let activeFile = null;
const dlines = (cls, t) => t.split('\n').map((l) => `<div class="diffline ${cls}">${esc(l) || ' '}</div>`).join('');
async function loadFiles() {
  const r = await api('/api/files');
  const files = r.files ?? [];
  $('diffCount').textContent = files.length;
  $('diffCount').classList.toggle('hide', !files.length);
  const list = $('fileList');
  list.innerHTML = '';
  for (const f of files) {
    const div = document.createElement('div');
    div.className = 'fileItem' + (f.path === activeFile ? ' active' : '');
    div.innerHTML = `<span title="${esc(f.path)}">${esc(f.path.split(/[\\/]/).pop())}</span><span class="b">${f.changes}</span>`;
    div.addEventListener('click', () => showDiff(f.path));
    list.appendChild(div);
  }
}
async function showDiff(p) {
  activeFile = p;
  await loadFiles();
  const d = await api('/api/files/diff?path=' + encodeURIComponent(p));
  if (d.error) return;
  let html = '';
  if (d.write) html += '<div class="hunk">' + dlines('add', d.write.content) + '</div>';
  for (const h of d.hunks) html += '<div class="hunk">' + dlines('del', h.oldText) + dlines('add', h.newText) + '</div>';
  $('diffBody').innerHTML = html || '<div class="sys" style="padding:.5rem">(no change)</div>';
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
   One entry for the agent turn (while it is running) and one for every
   long-running tool (bash, task/agent, web) started in this chat. The list is
   bound to the current chat: switching chat clears it and rebuilds it from the
   server events/replay. */
const tasks = new Map();          // toolCallId → { name, summary, t0, t1, error }
const TASK_TOOLS = /^(bash|shell|task|agent|subagent|dispatch_agent|web_search|web_fetch|fetch)$/i;
let agentTask = null;             // the agent turn currently running on this chat

function resetTasks() { tasks.clear(); agentTask = null; syncTasks(); }
function taskFromTool(ev) {
  if (!TASK_TOOLS.test(ev.name || '')) return;
  if (ev.status === 'start') {
    tasks.set(ev.id, { name: ev.name, summary: ev.summary || '', t0: Date.now(), t1: null, error: false });
  } else if (ev.status === 'end') {
    const t = tasks.get(ev.id);
    if (t) { t.t1 = Date.now(); t.error = !!ev.isError; }
  }
  syncTasks();
}
function setAgentTask(on, model) {
  if (on) agentTask = { name: 'Agent', summary: model?.name || model?.id || '', t0: Date.now(), t1: null, error: false };
  else if (agentTask) agentTask.t1 = Date.now();
  syncTasks();
}
function taskList() {
  const all = [...tasks.values()];
  if (agentTask) all.push(agentTask);
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
  // "Clear": drop the finished tasks, keep only the running ones
  for (const [id, t] of tasks) if (t.t1) tasks.delete(id);
  if (agentTask?.t1) agentTask = null;
  syncTasks(); renderTasks();
});
$('tasksClose').addEventListener('click', () => {
  $('tasksPanel').classList.remove('open');
  $('navTasks').classList.remove('on');
});

/* ---------------- web UI themes ---------------- */
const THEMES = [
  { id: 'noir', name: 'Teal Noir', cols: ['#05070a', '#0e131b', '#2fe0c0'] },
  { id: 'violet', name: 'Violet Dusk', cols: ['#07050d', '#120e22', '#a78bfa'] },
  { id: 'ember', name: 'Ember', cols: ['#0a0705', '#17100b', '#fb923c'] },
  { id: 'nord', name: 'Nord Ice', cols: ['#090e15', '#131e2b', '#7dd3fc'] },
  { id: 'rose', name: 'Rosé', cols: ['#0c060f', '#1b1121', '#f472b6'] },
  { id: 'daylight', name: 'Daylight (light)', cols: ['#f6f7f9', '#e3e7ee', '#0d9488'] },
];
function applyTheme(id) {
  document.documentElement.dataset.theme = THEMES.some((t) => t.id === id) ? id : 'noir';
  localStorage.setItem('piTheme', document.documentElement.dataset.theme);
  $$('.themeCard[data-t]').forEach((c) => c.classList.toggle('sel', c.dataset.t === document.documentElement.dataset.theme));
}
applyTheme(localStorage.getItem('piTheme') || 'noir');

/* ---------------- views ---------------- */
// settings page sections listed in the sidebar (in place of the chats)
const SETTINGS_SECTIONS = [
  ['analytics', 'Cost analytics'],
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
function buildSettingsNav() {
  const nav = $('settingsNav');
  nav.innerHTML = '<div class="snav-label">Settings</div>';
  for (const [id, label] of SETTINGS_SECTIONS) {
    const b = document.createElement('button');
    b.className = 'snavItem';
    b.dataset.target = id;
    b.textContent = label;
    b.addEventListener('click', () => {
      $(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
function showChat() {
  $('chatView').classList.remove('hide');
  $('settingsView').classList.add('hide');
  $('navChat').classList.add('on');
  $('navSettings').classList.remove('on');
  $('navDiff').classList.remove('hide');
  $('navTasks').classList.remove('hide');
  $('sidebar').classList.remove('mode-settings');   // the sidebar goes back to the chats
}
function showSettings() {
  $('chatView').classList.add('hide');
  $('settingsView').classList.remove('hide');
  $('navChat').classList.remove('on');
  $('navSettings').classList.add('on');
  // in settings the diff/tasks panels make no sense: close them and hide the buttons
  $('diffClose').click();
  $('tasksClose').click();
  $('navDiff').classList.add('hide');
  $('navTasks').classList.add('hide');
  $('sidebar').classList.add('mode-settings');      // the sidebar shows the sections
  buildSettingsNav();
  renderSettings();
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
  const [st, c, usageCfg] = await Promise.all([api('/api/settings'), api('/api/config'), api('/api/usage/config')]);
  if (st.error || c.error) { body.innerHTML = '<div class="sys">Could not load the configuration</div>'; return; }
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

  body.innerHTML = `
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

      <h4 style="margin:1rem 0 .4rem;font-size:.82rem;color:var(--teal)">Model logos</h4>
      <div class="themeGrid">${LOGO_STYLES.map((s) => `
        <button class="themeCard logoStyleCard" data-l="${s.id}">
          <span class="prev">${['anthropic', 'openai', 'google', 'kimi'].map((p) => logoHtml(p, '', 'lg fixed')).join('')}</span>
          <span class="nm">${esc(s.name)}</span>
        </button>`).join('')}</div>
    </div>

    <div class="sec" id="sec-usage">
      <h3>Real account limits (claude.ai / kimi.com)</h3>
      <p class="lead" style="margin:-.3rem 0 .8rem">This is not a public API: it replays what the browser sees on the usage pages of the two accounts. It needs your browser session — <b>it stays on this machine only</b>, in <code>~/.pi/agent/web-usage.json</code>, never committed. It has to be renewed when it expires.<br><b>Nothing to figure out:</b> copy the request with <b>Copy as cURL</b> and paste it below, the rest is derived from it.</p>
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

  /* ---- usage credentials handlers ---- */
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
  body.querySelectorAll('.logoStyleCard').forEach((b) => b.addEventListener('click', () => applyLogoStyle(b.dataset.l)));
  applyLogoStyle(localStorage.getItem('piLogoStyle') || 'brand');
  applyTheme(document.documentElement.dataset.theme);

  /* ---- enabledModels: allow-list per provider and per model ---- */
  // An empty list is pi's default and means "everything enabled": it must not be
  // confused with "nothing enabled".
  const providerPattern = (provider) => `${provider}/*`;
  const modelPattern = (m) => `${m.provider}/${m.id}`;
  const authedModels = c.models.filter((m) => m.authed);
  const authedProviders = [...new Set(authedModels.map((m) => m.provider))].sort();
  let enabledPatterns = c.options?.enabledModels ?? [];

  const checkbox = (pattern, label, on) =>
    `<label class="chip" style="cursor:pointer"><input type="checkbox" data-pattern="${esc(pattern)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;

  function drawEnabled() {
    const on = new Set(enabledPatterns);
    $('enabledHint').textContent = enabledPatterns.length
      ? `${enabledPatterns.length} active patterns: ${enabledPatterns.join(', ')}`
      : 'Empty list: every model of the authenticated providers is enabled.';
    $('enabledProviders').innerHTML = authedProviders
      .map((p) => checkbox(providerPattern(p), p, on.has(providerPattern(p)))).join('')
      || '<div class="sys">No authenticated provider</div>';
    const q = $('enabledSearch').value.trim().toLowerCase();
    const list = authedModels.filter((m) => !q
      || `${m.provider} ${m.id} ${m.name ?? ''}`.toLowerCase().includes(q));
    $('enabledModelList').innerHTML = list
      .map((m) => checkbox(modelPattern(m), modelPattern(m), on.has(modelPattern(m)))).join('')
      || '<div class="sys">No model matches the search</div>';
  }

  async function saveEnabled(patterns) {
    const r = await post('/api/settings', { key: 'enabledModels', value: patterns });
    if (r.error) { $('enabledMsg').textContent = '✗ ' + r.error; drawEnabled(); return; }
    enabledPatterns = r.value ?? [];
    $('enabledMsg').textContent = 'saved';
    drawEnabled();
    loadModels();   // the picker at the top must reflect the list right away
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
        <div class="h">${logoHtml(m.provider, m.id, 'lg')}
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
function addFiles(files) {
  for (const file of files) {
    if (!file) continue;
    if (file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        pending.push({ kind: 'image', name: file.name || 'image', url, data: url.split(',')[1], mimeType: file.type });
        renderAttachments();
      };
      r.readAsDataURL(file);
    } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || !file.type) {
      if (file.size > 512 * 1024) { toast(`${file.name}: too large (max 512 KB)`); continue; }
      const r = new FileReader();
      r.onload = () => { pending.push({ kind: 'file', name: file.name, text: String(r.result) }); renderAttachments(); };
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
let commandsCache = [];
async function loadCommands() {
  const r = await api('/api/commands');
  commandsCache = r.commands ?? [];
}
const CMD_SOURCE_LABEL = { extension: 'extension', prompt: 'prompt', skill: 'skill' };
let cmdMenuOpen = false, cmdMenuItems = [], cmdMenuIndex = 0, cmdMenuRange = null;
// only triggers for a "/" at the start of the current line, with no space typed
// yet after it — exactly like a console command
function slashToken() {
  const el = $('input');
  const v = el.value, pos = el.selectionStart;
  if (pos !== el.selectionEnd) return null;
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const line = v.slice(lineStart, pos);
  const m = /^\/([a-zA-Z0-9_:.-]*)$/.exec(line);
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: lineStart, end: pos };
}
function updateCmdMenu() {
  const tok = slashToken();
  if (!tok || !commandsCache.length) { closeCmdMenu(); return; }
  cmdMenuRange = tok;
  cmdMenuItems = commandsCache
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
  const insert = '/' + c.name + ' ';
  const v = input.value;
  input.value = v.slice(0, start) + insert + v.slice(end);
  input.selectionStart = input.selectionEnd = start + insert.length;
  closeCmdMenu();
  autoGrow();
  input.focus();
}

/* ---------------- composer (Enter = new line, Ctrl+Enter = send) ---------------- */
const input = $('input');
function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; }
input.addEventListener('input', () => { autoGrow(); updateCmdMenu(); });
input.addEventListener('click', updateCmdMenu);
input.addEventListener('blur', () => setTimeout(closeCmdMenu, 150));
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  closeCmdMenu();
  const text = input.value.trim();
  if (!text && !pending.length) return;
  const images = pending.filter((a) => a.kind === 'image').map((a) => ({ data: a.data, mimeType: a.mimeType }));
  let payload = text;
  for (const d of pending.filter((a) => a.kind === 'file')) {
    payload += `\n\n--- attached file: ${d.name} ---\n\`\`\`\n${d.text}\n\`\`\``;
  }
  const body = newTurn('user');
  // attachments BEFORE the text: images sit at the top of the message, as
  // thumbnails, and the typed text stays below
  if (pending.length) {
    const media = document.createElement('div');
    media.className = 'media';
    for (const a of pending) {
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = a.url; img.alt = a.name; img.title = a.name + ' — click to enlarge';
        media.appendChild(img);
      } else { const c = document.createElement('span'); c.className = 'filechip'; c.textContent = '📄 ' + a.name; media.appendChild(c); }
    }
    body.appendChild(media);
  }
  if (text) bubble('user', text, body);
  input.value = ''; autoGrow();
  pending = []; renderAttachments();
  scrollDown();
  const r = await post('/api/prompt', { text: payload, images });
  if (!r.error) { setChatStarted(true); setRunning(true); }
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
chat.addEventListener('click', (e) => {
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
  [['Shift', 'M'], 'Switch model (cycle)'],
  [['Shift', 'T'], 'Switch reasoning level'],
  [['Shift', 'P'], 'Switch project / folder'],
  [['Shift', 'N'], 'New chat'],
  [['Shift', 'S'], 'Open settings'],
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
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const target = /** @type {any} */ (e.target);
  const tag = (target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  if (typing) return; // do not steal Shift+letter while the user is typing
  switch (e.key.toLowerCase()) {
    case 'm': e.preventDefault(); cycleModel(); break;      // Shift+M: cycle models
    case 't': e.preventDefault(); cycleThinking(); break;   // Shift+T: cycle effort
    case 'p': e.preventDefault(); cycleProject(); break;    // Shift+P: cycle projects
    case 's': e.preventDefault(); showSettings(); break;    // Shift+S: settings
    case 'n': e.preventDefault(); newChat(); break;         // Shift+N: new chat
  }
});
$('abort').addEventListener('click', () => post('/api/abort'));
$('quit').addEventListener('click', async () => {
  if (!confirm('Shut down the pi desktop ui server?\nThis page will stop working until you start it again with `npm start`.')) return;
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch {}
  document.body.innerHTML = '<div style="margin:auto;padding:40px;text-align:center;color:#8d97a8">pi desktop ui server stopped.<br><br>Start it again with <code>npm start</code>.</div>';
});
$('restartBtn').addEventListener('click', async () => {
  if (!confirm('Restart the pi desktop ui server?\nThe chat stays saved; the page reloads by itself as soon as the server is ready again.')) return;
  try { await fetch('/api/restart', { method: 'POST' }); } catch {}
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
let gitInfo = null;
async function refreshGit() {
  const g = await api('/api/git');
  if (g.error) return;
  gitInfo = g;
  renderGit();
}
function renderGit() {
  const chip = $('gitChip');
  if (!gitInfo?.repo) { chip.classList.add('hide'); return; }
  chip.classList.remove('hide');
  $('gitBranch').textContent = gitInfo.branch;
  const n = gitInfo.changed ?? 0;
  const count = $('gitCount');
  count.textContent = n;
  count.classList.toggle('hide', !n);
  count.classList.toggle('warn', (gitInfo.staged ?? 0) > 0);
  const sync = [];
  if (gitInfo.ahead) sync.push(`↑ ${gitInfo.ahead} commits to push`);
  if (gitInfo.behind) sync.push(`↓ ${gitInfo.behind} commits to pull`);
  chip.title = `branch: ${gitInfo.branch}\n` +
    `pending changes: ${n} (staged ${gitInfo.staged} · unstaged ${gitInfo.unstaged} · new ${gitInfo.untracked})\n` +
    (sync.length ? sync.join(' · ') : 'in sync with the remote');
}

/* ---------------- boot ---------------- */
async function loadState() {
  const s = await api('/api/state');
  if (s.error) return;
  state.cwd = s.cwd;
  state.model = s.current ?? state.model;
  applyPlatformCapabilities(s.platform);
  applyChatArchiving(s.chatArchiving);
  setCwdLabel(s.cwd);
  renderStats(s.chat, s.context, s.chatByModel);
  setRunning(!!s.streaming);
  renderUsageWidget();
  refreshGit();
}
(async () => {
  connect();
  await loadState();
  await Promise.all([loadModels(), loadFiles(), loadCommands(), loadRecentCwds()]);
  await loadSessions();
  await refreshChat();
  await refreshUsage();
})();
// safety net: if SSE dies the sidebar must never go stale
setInterval(() => { if (!document.hidden && es?.readyState === 2) { es.close(); connect(); } }, 5000);
// real account usage limits (claude.ai / kimi.com) — poll, don't hammer
setInterval(() => { if (!document.hidden) refreshUsage(); }, 30000);
// git branch / pending changes — light poll (the server caches for 5s)
setInterval(() => { if (!document.hidden) refreshGit(); }, 20000);
