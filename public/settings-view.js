import { providerIconHtml } from './provider-icons.js';

/**
 * @typedef {object} SettingsDependencies
 * @property {(url: string, options?: object, requestOptions?: object) => Promise<any>} api
 * @property {(url: string, body?: object, requestOptions?: object) => Promise<any>} post
 * @property {(method: string, url: string, body?: object, requestOptions?: object) => Promise<any>} sendJson
 * @property {(value: unknown) => string} escapeHtml
 * @property {(value: number) => string} formatNumber
 * @property {(value: number) => string} formatMoney
 * @property {(caps: any) => void} applyPlatformCapabilities
 * @property {(enabled: boolean) => void} applyChatArchiving
 * @property {() => boolean} getChatArchiving
 * @property {() => boolean} getChatNotifications
 * @property {(enabled: boolean) => void} setChatNotifications
 * @property {() => Promise<any>} loadSessions
 * @property {(provider: string, id: string) => Promise<any>} selectModel
 * @property {(force?: boolean) => Promise<any>} refreshUsage
 * @property {(options?: { force?: boolean }) => Promise<any>} loadModels
 * @property {(id: string) => void} applyTheme
 * @property {(id: string) => void} applyAccent
 * @property {(id: string) => void} applyLogoStyle
 * @property {any[]} themes
 * @property {any[]} accents
 * @property {any[]} logoStyles
 * @property {any} agentInputs
 * @property {() => string|null} getRenderedChatKey
 * @property {(collapsed: boolean) => void} setSidebarCollapsed
 */

/**
 * Owns the settings DOM, its internal navigation, analytics and persistence
 * interactions. Importing the module performs no requests or DOM registration.
 *
 * @param {SettingsDependencies} dependencies
 */
export function createSettingsView({
  api: requestApi,
  post: requestPost,
  sendJson: requestSendJson,
  escapeHtml: esc,
  formatNumber: fmt,
  formatMoney: money,
  applyPlatformCapabilities,
  applyChatArchiving,
  getChatArchiving,
  getChatNotifications,
  setChatNotifications,
  loadSessions,
  refreshUsage,
  loadModels,
  applyTheme,
  applyAccent,
  applyLogoStyle,
  themes: THEMES,
  accents: ACCENTS,
  logoStyles: LOGO_STYLES,
  agentInputs,
  getRenderedChatKey,
  setSidebarCollapsed,
}) {
  /** @type {(id: string) => any} */
  const $ = (id) => document.getElementById(id);
  /** @type {(selector: string, root?: ParentNode) => any[]} */
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const {
    inputKind: bootstrapInputKind,
    fileEditor: bootstrapFileEditor,
    promptPreview: bootstrapPromptPreview,
    resourceList: bootstrapResourceList,
    bindFileActions: bindBootstrapFileActions,
  } = agentInputs;

  let started = false;
  let requestGeneration = 0;
  let abortController = null;
  let showPromise = null;
  const withSignal = (options = {}) => ({ ...options, signal: abortController?.signal });
  const api = (url, options, requestOptions) => requestApi(url, options, withSignal(requestOptions));
  const post = (url, body, requestOptions) => requestPost(url, body, withSignal(requestOptions));
  const sendJson = (method, url, body, requestOptions) => requestSendJson(method, url, body, withSignal(requestOptions));

// settings page sections listed in the sidebar (in place of the chats)
const SETTINGS_SECTIONS = [
  ['analytics', 'Cost analytics'],
  ['sec-agent', 'Agent bootstrap'],
  ['sec-pi', 'pi settings'],
  ['sec-theme', 'Theme'],
  ['sec-usage', 'Account limits'],
  ['sec-session', 'Session'],
  ['sec-models', 'Models & providers'],
  ['sec-network', 'Local network'],
  ['sec-chats', 'Chats'],
  ['sec-tools', 'Tools'],
  ['sec-paths', 'Paths'],
  ['sec-raw', 'Raw config'],
];
let activeSettingsSection = 'analytics';
let preferredProvider = null;
function showSettingsSection(id) {
  const section = $(id);
  if (!section) return false;
  activeSettingsSection = id;
  $('settingsBody').querySelectorAll('.sec').forEach((el) => { el.hidden = el !== section; });
  $('analytics').hidden = id !== 'analytics';
  $('settingsView').scrollTop = 0;
  $('settingsNav').querySelectorAll('.snavItem').forEach((el) =>
    el.classList.toggle('on', el.dataset.target === id));
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
      if (!showSettingsSection(id)) return;
      if (window.matchMedia('(max-width: 768px)').matches) setSidebarCollapsed(true);
    });
    nav.appendChild(b);
  }
  showSettingsSection(activeSettingsSection);
}

/* ---------------- cost analytics dashboard ---------------- */
const AN_COLORS = ['#2fe0c0', '#a78bfa', '#fb923c', '#f472b6', '#60a5fa', '#facc15', '#4ade80', '#f87171', '#38bdf8', '#c084fc'];
let anData = null;
const anState = { range: '30', model: '__all', project: '__all', gran: 'day', sort: 'cost' };

async function loadAnalytics(force) {
  const generation = requestGeneration;
  const box = $('analytics');
  if (!anData || force) {
    box.innerHTML = '<div class="sys">Loading cost analytics…</div>';
    const loaded = await api('/api/analytics');
    if (generation !== requestGeneration) return;
    anData = loaded;
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


async function renderSettings() {
  const generation = requestGeneration;
  const isObsolete = () => generation !== requestGeneration;
  const body = $('settingsBody');
  body.innerHTML = '<div class="sys">Loading…</div>';
  const [st, c, usageCfg, bootstrap] = await Promise.all([
    api('/api/settings'),
    api('/api/config'),
    api('/api/usage/config'),
    api('/api/agent-bootstrap'),
  ]);
  if (isObsolete()) return;
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
      <div class="card settingsCard settingsCardSpaced">
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
      <div class="card settingsCard settingsCardSpaced">
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
        <textarea id="claudeCookie" placeholder="curl 'https://claude.ai/api/organizations/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/usage' &#10;  -H 'Cookie: sessionKey=...; cf_clearance=...' &#10;  -H 'Accept: */*' ..." rows="5" class="usageCredentialInput"></textarea>
        <details style="margin-top:.4rem"><summary class="sys" style="cursor:pointer">…or paste the cookie by hand</summary>
          <div class="sys" style="margin:.4rem 0">A one-line <code>Cookie</code> header (<code>sessionKey=…; cf_clearance=…</code>) or the DevTools → Application → Cookies table works too. Careful: if you copy from the on-screen panel the long values are <b>truncated</b> with <code>…</code> and will not work. In that case the org id has to be typed in by hand:</div>
          <input id="claudeOrgId" placeholder="org id, e.g. e44d8396-f752-4390-a998-eea4232dad75" value="${esc(usageCfg.anthropic?.orgId ?? '')}">
        </details>
        <div class="row settingsActionRow settingsActions">
          <button class="btn teal" id="claudeCfgSave">Save and test</button>
          <button class="btn outline" id="claudeCfgTest">Retry</button>
          <button class="btn outline" id="claudeCfgClear">Remove</button>
          <span class="sys settingsMessage" id="claudeCfgMsg"></span>
        </div>
      </div>
      <div class="card settingsCard">
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
        <textarea id="kimiBearer" placeholder="curl 'https://www.kimi.com/apiv2/.../GetUsages' -H 'Authorization: Bearer eyJ...' ..." rows="4" class="usageCredentialInput"></textarea>
        <div class="sys" style="margin-top:.3rem">The bare JWT token also works (the value after <code>Bearer </code>, three dot-separated parts).</div>
        <div class="row settingsActionRow settingsActions">
          <button class="btn teal" id="kimiCfgSave">Save and test</button>
          <button class="btn outline" id="kimiCfgTest">Retry</button>
          <button class="btn outline" id="kimiCfgClear">Remove</button>
          <span class="sys settingsMessage" id="kimiCfgMsg"></span>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-network">
      <h3>Local network access</h3>
      <div class="card settingsCard">
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
          <div class="row settingsActionRow">
            <button class="btn outline" id="lanReveal">Show connection URL</button>
            <button class="btn outline" id="lanCopy">Copy link</button>
            <button class="btn outline" id="lanRegen">Regenerate token</button>
            <span class="sys settingsMessage" id="lanMsg"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="sec" id="sec-chats">
      ${/** @type {any} */ (window).desktopWindow?.isWindows ? `<h3>Windows notifications</h3>
      <div class="card settingsCard">
        <div class="setRow">
          <div>
            <div class="k">Chat finished</div>
            <div class="d">Show a Windows notification with the chat title when a model finishes a request and this window is not in focus. Click it to open the chat.</div>
            <div class="def">default: <code>off</code></div>
          </div>
          <div class="ctl"><span class="sw" id="chatNotificationsSw" role="switch" tabindex="0" aria-label="Windows chat notifications"></span></div>
        </div>
      </div>` : ''}
      <h3>Chat archiving</h3>
      <div class="card settingsCard">
        <div class="setRow">
          <div>
            <div class="k">chatArchiving <span class="badge">boolean</span></div>
            <div class="d">Done chats sink to the bottom of the sidebar and look dimmed, so the list stays tidy. Turning the option off makes the sidebar a flat list again: the statuses already saved are not deleted and come back if you turn it on again.</div>
            <div class="def">default: <code>on</code> — on the very first start, chats idle for more than 24 hours are marked done once</div>
          </div>
          <div class="ctl"><span class="sw" id="chatArchivingSw" role="switch" tabindex="0"></span></div>
        </div>
        <div id="chatArchivingDetails" class="hide" style="margin-top:.6rem">
          <div class="row settingsActionRow">
            <button class="btn outline" id="archiveNowBtn">Archive chats older than 24 hours</button>
            <span class="sys settingsMessage" id="chatArchivingMsg"></span>
          </div>
        </div>
      </div>

      <h3 style="margin-top:1.2rem">Chat titles</h3>
      <div class="card settingsCard">
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
          <div class="row settingsActionRow">
            <button class="btn outline" id="titleGenBackfillBtn">Generate titles for the existing chats</button>
            <span class="sys settingsMessage" id="titleGenMsg"></span>
          </div>
        </div>
      </div>

      <h3 style="margin-top:1.2rem">Chat search</h3>
      <div class="card settingsCard">
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
      <div class="card settingsCard"><div class="kv">
        <div class="k">model</div><div class="v">${c.current ? esc(c.current.provider + '/' + c.current.id) : '—'}</div>
        <div class="k">reasoning</div><div class="v">${esc(c.thinkingLevel)} (available: ${c.thinkingLevels.join(', ')})</div>
        <div class="k">working folder</div><div class="v">${esc(c.cwd)}</div>
        <div class="k">session file</div><div class="v">${esc(c.sessionFile ?? '—')}</div>
        <div class="k">node</div><div class="v">${esc(c.node)}</div>
      </div></div>
    </div>

    <div class="sec" id="sec-models">
      <div class="modelsPageHeader"><div><h3>Models &amp; providers</h3><p class="lead">Choose a provider on the left, then pick its models on the right.</p></div>
        <button class="btn outline" id="refreshCatalog" type="button">Refresh providers &amp; models</button></div>
      <p class="sys" id="refreshMsg" role="status"></p>
      <div class="modelsWorkspace">
        <div class="modelsProviderPane">
          <div class="search"><input id="providerSearch" type="search" placeholder="Search providers…" aria-label="Search providers"></div>
          <div id="providerList" class="providerList"></div>
        </div>
        <div class="modelsDetailPane">
          <h4>Models for <span id="selectedProviderName"></span></h4>
          <p class="sys" id="enabledMsg" role="status"></p>
          <div class="modelsToolbar">
            <div class="search"><input id="modelSearch" type="search" placeholder="Search models…" aria-label="Search models"></div>
            <label class="chip"><input type="checkbox" id="onlyReason"> with reasoning only</label>
            <span class="sys" id="modelCount"></span>
          </div>
          <div class="modelGrid" id="modelGrid"></div>
        </div>
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
      <div class="card settingsCard"><div class="kv">
        ${Object.entries(c.paths).map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}
      </div></div>
    </div>

    <div class="sec" id="sec-raw">
      <h3>settings.json (raw)</h3>
      <pre class="raw">${esc(JSON.stringify(st.raw ?? {}, null, 2))}</pre>
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
  const network = await api('/api/network');
  if (isObsolete()) return;
  drawNetwork(network);
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

  /* ---- Windows chat notifications ---- */
  const notificationsSwitch = $('chatNotificationsSw');
  if (notificationsSwitch) {
    const drawNotifications = () => {
      notificationsSwitch.classList.toggle('on', getChatNotifications());
      notificationsSwitch.setAttribute('aria-checked', String(getChatNotifications()));
    };
    drawNotifications();
    const toggleNotifications = () => {
      setChatNotifications(!getChatNotifications());
      drawNotifications();
    };
    notificationsSwitch.addEventListener('click', toggleNotifications);
    notificationsSwitch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNotifications(); }
    });
  }

  /* ---- chat archiving ---- */
  function drawArchiving(cfg, msg = '') {
    if (cfg.error) return;
    applyChatArchiving(cfg.enabled);
    $('chatArchivingSw').classList.toggle('on', getChatArchiving());
    $('chatArchivingDetails').classList.toggle('hide', !getChatArchiving());
    $('chatArchivingMsg').textContent = msg;
  }
  const archiving = await api('/api/archiving');
  if (isObsolete()) return;
  drawArchiving(archiving);
  const toggleArchiving = async () => {
    drawArchiving(await sendJson('PUT', '/api/archiving', { enabled: !getChatArchiving() }));
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
  const titleGeneration = await api('/api/title-generation');
  if (isObsolete()) return;
  drawTitleGen(titleGeneration);
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
  const fullSearchState = await api('/api/full-search');
  if (isObsolete()) return;
  drawFullSearch(fullSearchState);
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
    const result = await api('/api/usage/credentials/anthropic', { method: 'DELETE' });
    if (result.error) { cfgMsg('claudeCfgMsg', '✗ ' + result.error, 'err'); return; }
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
    const result = await api('/api/usage/credentials/kimi', { method: 'DELETE' });
    if (result.error) { cfgMsg('kimiCfgMsg', '✗ ' + result.error, 'err'); return; }
    setCfgBadge('kimiCfgBadge', false);
    $('kimiBearer').value = ''; cfgMsg('kimiCfgMsg', '', '');
    refreshUsage();
  });

  /* ---- agent bootstrap ---- */
  bindBootstrapFileActions(body, {
    key: getRenderedChatKey(),
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

  /* ---- Provider visibility and per-model selection (pi's enabledModels allow-list) ---- */
  const providers = c.providers.filter((p) => p.models > 0).sort((a, b) => a.id.localeCompare(b.id));
  let selectedProvider = providers.find((p) => p.id === preferredProvider)?.id
    ?? providers.find((p) => p.configured)?.id ?? providers[0]?.id;
  let enabledPatterns = c.options?.enabledModels ?? [];
  let saving = false;
  const keyFor = (m) => `${m.provider}/${m.id}`;
  const providerModels = (id) => c.models.filter((m) => m.provider === id);
  const active = (m) => enabledPatterns.length === 0
    ? m.authed : enabledPatterns.includes(`${m.provider}/*`) || enabledPatterns.includes(keyFor(m));
  const activeProvider = (id) => providerModels(id).some(active);

  function drawProviders() {
    const q = $('providerSearch').value.trim().toLowerCase();
    $('providerList').innerHTML = providers.filter((p) => p.id.toLowerCase().includes(q))
      .sort((a, b) => Number(activeProvider(b.id) && b.configured) - Number(activeProvider(a.id) && a.configured)
        || a.id.localeCompare(b.id)).map((p) => `
      <div class="providerRow ${selectedProvider === p.id ? 'selected' : ''}">
        <button class="providerChoose" data-provider="${esc(p.id)}" aria-pressed="${selectedProvider === p.id}">
          ${providerIconHtml(p.id)} <span><strong>${esc(p.id)}</strong>
          <small>${p.configured ? `${providerModels(p.id).filter(active).length} models selected` : 'Access needed'}</small></span>
        </button>
        <label class="providerSwitch"><input type="checkbox" aria-label="Show ${esc(p.id)} in picker" data-toggle-provider="${esc(p.id)}" ${activeProvider(p.id) && p.configured ? 'checked' : ''} ${p.configured ? '' : 'disabled'}></label>
      </div>`).join('') || '<p class="sys">No providers match the search</p>';
    $('selectedProviderName').textContent = selectedProvider ?? '—';
  }

  function drawGrid() {
    const q = $('modelSearch').value.trim().toLowerCase();
    const models = providerModels(selectedProvider).filter((m) =>
      (!$('onlyReason').checked || m.reasoning)
      && (!q || `${m.id} ${m.name ?? ''}`.toLowerCase().includes(q)));
    $('modelCount').textContent = `${models.length} models`;
    $('modelGrid').innerHTML = models.map((m) => `
      <label class="modelCard ${active(m) && m.authed ? 'sel' : ''}">
        <input type="checkbox" data-model="${esc(keyFor(m))}" ${active(m) && m.authed ? 'checked' : ''} ${m.authed ? '' : 'disabled'}>
        <span class="modelIdentity"><strong>${esc(m.name || m.id)}</strong><small>${esc(keyFor(m))}</small></span>
        ${m.contextWindow ? `<span class="badge">ctx ${fmt(m.contextWindow)}</span>` : ''}
        ${m.reasoning ? '<span class="badge ok">reasoning</span>' : ''}
      </label>`).join('') || '<p class="sys">No models match the filters</p>';
  }
  const draw = () => { drawProviders(); drawGrid(); };
  // An empty list means ALL authenticated models in pi, not none. Materialize
  // the current selection before the first edit, preserving other providers.
  function explicitPatterns() {
    if (enabledPatterns.length) return [...enabledPatterns];
    return c.models.filter((m) => m.authed).map(keyFor);
  }
  async function saveEnabled(patterns) {
    if (saving) return;
    if (!patterns.length) {
      $('enabledMsg').textContent = 'At least one model must remain enabled: an empty pi list means all models.';
      draw();
      return;
    }
    saving = true;
    const r = await post('/api/settings', { key: 'enabledModels', value: [...new Set(patterns)] });
    saving = false;
    if (r.error) { $('enabledMsg').textContent = r.error; draw(); return; }
    enabledPatterns = r.value ?? patterns;
    $('enabledMsg').textContent = 'Saved';
    draw();
    loadModels({ force: true });
  }
  $('providerList').addEventListener('click', (e) => {
    const button = e.target.closest('[data-provider]');
    if (!button) return;
    selectedProvider = button.dataset.provider;
    preferredProvider = selectedProvider;
    draw();
  });
  $('providerList').addEventListener('change', (e) => {
    const id = e.target.dataset.toggleProvider;
    if (!id) return;
    const patterns = explicitPatterns().filter((p) => p !== `${id}/*` && !p.startsWith(`${id}/`));
    saveEnabled(e.target.checked ? [...patterns, `${id}/*`] : patterns);
  });
  $('modelGrid').addEventListener('change', (e) => {
    const key = e.target.dataset.model;
    if (!key) return;
    const id = key.slice(0, key.indexOf('/'));
    let patterns = explicitPatterns();
    if (patterns.includes(`${id}/*`)) {
      patterns = patterns.filter((p) => p !== `${id}/*`);
      patterns.push(...providerModels(id).filter((m) => m.authed).map(keyFor));
    }
    saveEnabled(e.target.checked ? [...patterns, key] : patterns.filter((p) => p !== key));
  });
  $('providerSearch').addEventListener('input', drawProviders);
  $('refreshCatalog').addEventListener('click', async () => {
    const button = $('refreshCatalog');
    button.disabled = true;
    $('refreshMsg').textContent = 'Refreshing providers and models…';
    const refreshed = await post('/api/config/refresh');
    if (isObsolete()) return;
    if (refreshed.error) {
      button.disabled = false;
      $('refreshMsg').textContent = refreshed.error;
      return;
    }
    await renderSettings();
    if (isObsolete()) return;
    buildSettingsNav();
    $('refreshMsg').textContent = refreshed.ok ? 'Providers and models updated.'
      : `Update incomplete${refreshed.aborted ? ' (timed out)' : ''}. Retry to refresh all providers.`;
    loadModels({ force: true });
  });
  $('modelSearch').addEventListener('input', drawGrid);
  $('onlyReason').addEventListener('change', drawGrid);
  draw();

}

  function start() {
    if (started) return;
    started = true;
  }

  function stop() {
    if (!started) return;
    started = false;
  }

  async function show() {
    start();
    if (showPromise) return showPromise;
    abortController?.abort();
    abortController = new AbortController();
    const generation = ++requestGeneration;
    $('settingsNav').innerHTML = '<div class="snav-label">Settings</div><div class="sys">Loading…</div>';
    const pending = Promise.all([renderSettings(), loadAnalytics()]).then(() => {
      if (generation === requestGeneration) buildSettingsNav();
    });
    showPromise = pending;
    try { await pending; }
    finally { if (showPromise === pending) showPromise = null; }
  }

  function hide() {
    requestGeneration += 1;
    abortController?.abort();
    abortController = null;
    showPromise = null;
    stop();
  }

  return { show, hide };
}
