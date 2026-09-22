import { terminalHeaderState } from './navigation.js';

/**
 * @typedef {object} TerminalViewDependencies
 * @property {any} state
 * @property {(url: string, options?: object, requestOptions?: object) => Promise<any>} api
 * @property {(url: string, body?: object, requestOptions?: object) => Promise<any>} post
 * @property {(url: string, options?: object) => Promise<any>} fetchImpl
 * @property {(url: string) => any} createEventSource
 * @property {() => any} getTerminalConstructor
 * @property {() => any} getFitAddonConstructor
 * @property {() => any} getSelection
 * @property {() => string|null} getActiveProjectCwd
 * @property {(terminal: any) => void} selectTerminal
 * @property {() => void} restoreSelection
 * @property {() => any} getPlatformCapabilities
 * @property {(message: string, good?: boolean) => void} toast
 * @property {Document} [documentRef]
 * @property {Window} [windowRef]
 * @property {Navigator} [navigatorRef]
 */

/**
 * Owns terminal DOM, xterm instances, streams, actions and their lifecycle.
 * Importing this module does not register listeners, start requests or create
 * terminal resources. Navigation selection remains with the caller.
 *
 * @param {TerminalViewDependencies} dependencies
 */
export function createTerminalView({
  state,
  api,
  post,
  fetchImpl,
  createEventSource,
  getTerminalConstructor,
  getFitAddonConstructor,
  getSelection,
  getActiveProjectCwd,
  selectTerminal,
  restoreSelection,
  getPlatformCapabilities,
  toast,
  documentRef = document,
  windowRef = window,
  navigatorRef = navigator,
}) {
  /** @type {(id: string) => any} */
  const $ = (id) => documentRef.getElementById(id);
  const panes = new Map();
  const pendingRestarts = new Set();
  let started = false;
  let fitTimer = null;
  let colorProbe;

  const list = () => [...state.terminals.values()];
  const activeId = () => getSelection()?.view === 'terminal' ? getSelection().resourceId : null;
  const hasExited = (terminal) => terminal.exited !== null && terminal.exited !== undefined;
  const projectName = (cwd) => (cwd || '').split(/[\\/]/).filter(Boolean).pop() || cwd;

  function colorProbeContext() {
    if (colorProbe === undefined) {
      try {
        const canvas = documentRef.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        colorProbe = canvas.getContext('2d', { willReadFrequently: true }) || null;
      } catch { colorProbe = null; }
    }
    return colorProbe;
  }

  function cssColorToRgba(value, fallback) {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    const context = colorProbeContext();
    if (!context) return fallback;
    try {
      context.fillStyle = '#000000';
      context.fillStyle = raw;
      const onBlack = context.fillStyle;
      context.fillStyle = '#ffffff';
      context.fillStyle = raw;
      if (onBlack !== context.fillStyle) return fallback;
      context.globalCompositeOperation = 'copy';
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
    } catch {
      return fallback;
    }
  }

  function theme() {
    const css = windowRef.getComputedStyle(documentRef.documentElement);
    const value = (name, fallback) => cssColorToRgba(css.getPropertyValue(name), fallback);
    const foreground = value('--txt', 'rgba(233, 237, 243, 1)');
    const background = value('--bg', 'rgba(11, 13, 17, 1)');
    return {
      background,
      foreground,
      cursor: value('--teal', foreground),
      cursorAccent: background,
      selectionBackground: value('--teal-dim', 'rgba(47, 224, 192, 0.2)'),
    };
  }

  function refreshTheme() {
    const next = theme();
    for (const entry of panes.values()) entry.term.options.theme = next;
  }

  function sendInput(id, data) {
    fetchImpl(`/api/terminals/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }).catch((error) => console.error('terminal input', error));
  }

  function clipboardOrWarn() {
    if (navigatorRef.clipboard) return navigatorRef.clipboard;
    toast('Clipboard unavailable (the browser only allows it over https or on localhost)');
    return null;
  }

  function copySelection(term) {
    const selection = term.getSelection();
    if (!selection) return false;
    clipboardOrWarn()?.writeText(selection)
      .then(() => term.clearSelection())
      .catch((error) => console.error('terminal copy', error));
    return true;
  }

  function paste(id, term) {
    if (panes.get(id)?.exited) return;
    clipboardOrWarn()?.readText()
      .then((text) => { if (text) term.paste(text); })
      .catch((error) => console.error('terminal paste', error));
  }

  function fit(id) {
    const entry = panes.get(id);
    if (!entry || entry.pane.classList.contains('hide')) return;
    try { entry.fit.fit(); } catch { return; }
    const { cols, rows } = entry.term;
    if (cols === entry.cols && rows === entry.rows) return;
    entry.cols = cols;
    entry.rows = rows;
    fetchImpl(`/api/terminals/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    }).catch((error) => console.error('terminal resize', error));
  }

  function renderHeader(selection = getSelection()) {
    const terminal = selection?.view === 'terminal' ? state.terminals.get(selection.resourceId) : null;
    const capabilities = getPlatformCapabilities() ?? {};
    const header = terminalHeaderState(selection, terminal, {
      canOpenFolder: capabilities.openFolder,
      canCopyPath: Boolean(navigatorRef.clipboard) || typeof documentRef.execCommand === 'function',
    });
    $('terminalHeader').classList.toggle('hide', !header);
    if (!header) return;
    $('terminalFolder').textContent = header.folder || 'Terminal';
    $('terminalPath').textContent = header.cwd;
    $('terminalPath').title = header.cwd;
    $('terminalKind').textContent = header.kind;
    $('terminalStatus').textContent = header.status;
    $('terminalStatus').classList.toggle('running', header.running);
    $('terminalStatus').classList.toggle('exited', !header.running);
    $('terminalOpenFolderBtn').disabled = !header.canOpenFolder;
    $('terminalOpenFolderBtn').title = header.canOpenFolder
      ? `Open ${header.cwd}`
      : 'Opening folders is unavailable on this system';
    $('terminalCopyPathBtn').disabled = !header.canCopyPath;
    $('terminalCopyPathBtn').title = header.canCopyPath
      ? `Copy ${header.cwd}`
      : 'Clipboard unavailable; select the path and use the browser menu';
    const restarting = pendingRestarts.has(header.id);
    $('terminalRestartBtn').disabled = restarting;
    $('terminalRestartBtn').textContent = restarting ? 'Restarting…' : 'Restart';
    $('terminalCloseBtn').disabled = restarting;
  }

  function markExited(id, code) {
    const entry = panes.get(id);
    if (!entry || entry.exited) return;
    entry.exited = true;
    entry.term.options.disableStdin = true;
    entry.term.options.cursorBlink = false;
    entry.term.write(`\r\n[process exited (code ${code}) — close this terminal with ×]\r\n`);
    const terminal = state.terminals.get(id);
    if (terminal) terminal.exited = code;
    renderHeader();
  }

  function openPane(id) {
    const existing = panes.get(id);
    if (existing) return existing;
    const Terminal = getTerminalConstructor();
    const FitAddon = getFitAddonConstructor();
    if (!Terminal || !FitAddon) {
      toast('xterm.js did not load: the terminal cannot be shown');
      return null;
    }
    const pane = documentRef.createElement('div');
    pane.className = 'termPane hide';
    pane.dataset.id = id;
    $('termHost').appendChild(pane);

    const css = windowRef.getComputedStyle(documentRef.documentElement);
    const term = new Terminal({
      theme: theme(),
      fontFamily: css.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(pane);
    const inputSubscription = term.onData((data) => sendInput(id, data));

    pane.addEventListener('contextmenu', (event) => {
      if (!navigatorRef.clipboard) return;
      event.preventDefault();
      if (!copySelection(term)) paste(id, term);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === 'c') { copySelection(term); return false; }
      if (key === 'v') { paste(id, term); return false; }
      return true;
    });

    const stream = createEventSource(`/api/terminals/${encodeURIComponent(id)}/stream`);
    stream.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.reset === true) term.reset();
      if (typeof message.data === 'string') term.write(message.data);
      if (typeof message.exited === 'number') markExited(id, message.exited);
    };
    stream.onerror = () => {};

    const entry = {
      pane,
      term,
      fit: fitAddon,
      stream,
      inputSubscription,
      cols: 0,
      rows: 0,
      exited: false,
    };
    panes.set(id, entry);
    return entry;
  }

  function disposePane(id) {
    const entry = panes.get(id);
    if (!entry) return;
    try { entry.stream.close(); } catch {}
    try { entry.inputSubscription?.dispose(); } catch {}
    try { entry.term.dispose(); } catch {}
    entry.pane.remove();
    panes.delete(id);
  }

  function show(id) {
    if (!state.terminals.has(id)) return false;
    const entry = openPane(id);
    if (!entry) return false;
    $('chatView').classList.add('hide');
    $('settingsView').classList.add('hide');
    $('termView').classList.remove('hide');
    $('navChat').classList.remove('on');
    $('navSettings').classList.remove('on');
    for (const [paneId, candidate] of panes) candidate.pane.classList.toggle('hide', paneId !== id);
    fit(id);
    entry.term.focus();
    return true;
  }

  function hide() {
    $('termView').classList.add('hide');
  }

  function terminalItem(terminal) {
    const row = documentRef.createElement('div');
    const dead = hasExited(terminal);
    row.className = 'sessionItem termItem'
      + (terminal.id === activeId() ? ' active' : '') + (dead ? ' done' : '');
    row.innerHTML = `<div class="acts"><button class="killBtn" title="Close this terminal">×</button></div>
      <div class="title"><span class="termIcon">${terminal.kind === 'pi' ? 'π' : '▢'}</span>${dead ? '' : '<span class="liveDot"></span>'}<span class="lbl"></span></div>
      <div class="meta">${dead ? '<span class="exited">exited</span>' : `<span>${terminal.kind === 'pi' ? 'pi' : 'powershell'}</span>`}</div>`;
    row.querySelector('.lbl').textContent = projectName(terminal.cwd) || '(no folder)';
    row.title = terminal.cwd || '';
    row.querySelector('.killBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      close(terminal.id);
    });
    row.addEventListener('click', () => selectTerminal(terminal));
    return row;
  }

  function renderChip() {
    const running = list().filter((terminal) => !hasExited(terminal));
    const dropdown = $('termsDd');
    const menu = $('termsMenu');
    dropdown.classList.toggle('hide', running.length === 0);
    if (running.length === 0) dropdown.classList.remove('open');
    $('termsCount').textContent = running.length;
    menu.innerHTML = '<div class="dd-group">Running terminals</div>';
    for (const terminal of running) {
      const row = documentRef.createElement('div');
      row.className = 'termRow' + (terminal.id === activeId() ? ' sel' : '');
      row.innerHTML = `<button class="dd-item go"><span class="termIcon">${terminal.kind === 'pi' ? 'π' : '▢'}</span><span class="col"><span class="nm"></span><span class="pth"></span></span></button>
        <button class="btn icon kill" title="Close this terminal">×</button>`;
      row.querySelector('.nm').textContent = projectName(terminal.cwd) || '(no folder)';
      row.querySelector('.pth').textContent = terminal.cwd || '';
      row.querySelector('.go').addEventListener('click', () => {
        dropdown.classList.remove('open');
        selectTerminal(terminal);
      });
      row.querySelector('.kill').addEventListener('click', () => close(terminal.id));
      menu.appendChild(row);
    }
  }

  function render() {
    const cwd = (getActiveProjectCwd() || '').toLowerCase();
    const shown = cwd
      ? list().filter((terminal) => (terminal.cwd || '').toLowerCase() === cwd)
      : list();
    const container = $('termList');
    const empty = shown.length === 0;
    $('termLabel').classList.toggle('hide', empty);
    container.classList.toggle('hide', empty);
    $('termCount').textContent = shown.length;

    const alive = new Set(list().map((terminal) => terminal.id));
    const selected = activeId();
    const selectionGone = selected !== null && !alive.has(selected) && !pendingRestarts.has(selected);
    for (const id of [...panes.keys()]) if (!alive.has(id)) disposePane(id);
    container.innerHTML = '';
    for (const terminal of shown) container.appendChild(terminalItem(terminal));
    renderChip();
    renderHeader();
    if (selectionGone) restoreSelection();
  }

  function update(payload) {
    state.applyTerminalsPayload(payload);
    render();
    return list();
  }

  async function load() {
    let payload;
    try {
      const response = await fetchImpl('/api/terminals');
      payload = response.ok ? await response.json() : { terminals: [] };
    } catch {
      payload = { terminals: [] };
    }
    return update(payload);
  }

  async function open(kind) {
    const result = await post('/api/terminals', { kind });
    if (result.error) return false;
    await load();
    const terminal = state.terminals.get(result.id);
    if (terminal) selectTerminal(terminal);
    return Boolean(terminal);
  }

  async function openFolder() {
    const terminal = state.terminals.get(activeId());
    if (!terminal) return;
    const button = $('terminalOpenFolderBtn');
    button.disabled = true;
    try {
      const result = await api(`/api/terminals/${encodeURIComponent(terminal.id)}/open-folder`, {
        method: 'POST',
      }, { key: null, followKey: false });
      if (!result.error) toast(`Opened ${result.cwd}`, true);
    } finally {
      renderHeader();
    }
  }

  async function writePath(text) {
    if (navigatorRef.clipboard) return navigatorRef.clipboard.writeText(text);
    const input = documentRef.createElement('input');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    documentRef.body.appendChild(input);
    input.select();
    try {
      if (!documentRef.execCommand('copy')) throw new Error('copy command refused');
    } finally {
      input.remove();
    }
  }

  async function copyPath() {
    const terminal = state.terminals.get(activeId());
    if (!terminal) return;
    try {
      await writePath(terminal.cwd);
      toast('Terminal path copied', true);
    } catch {
      toast('Copy failed (browser clipboard permissions)');
    }
  }

  async function restart() {
    const id = activeId();
    if (!id || pendingRestarts.has(id)) return;
    pendingRestarts.add(id);
    renderHeader();
    try {
      const result = await api(`/api/terminals/${encodeURIComponent(id)}/restart`, {
        method: 'POST',
      }, { key: null, followKey: false });
      if (result.error) return;
      const wasSelected = activeId() === id;
      update({
        terminals: [
          ...list().filter((terminal) => terminal.id !== id && terminal.id !== result.terminal.id),
          result.terminal,
        ],
      });
      disposePane(id);
      if (wasSelected) selectTerminal(result.terminal);
      toast('Terminal restarted', true);
    } finally {
      pendingRestarts.delete(id);
      render();
    }
  }

  async function close(id) {
    const result = await api(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
      key: null,
      followKey: false,
    });
    if (result.error) return false;
    const wasSelected = activeId() === id;
    state.applyTerminalsPayload({ terminals: list().filter((terminal) => terminal.id !== id) });
    disposePane(id);
    if (wasSelected) restoreSelection();
    render();
    return true;
  }

  function onResize() {
    clearTimeout(fitTimer);
    fitTimer = windowRef.setTimeout(() => {
      const id = activeId();
      if (id) fit(id);
    }, 120);
  }

  function closeSelected() {
    const id = activeId();
    if (id) close(id);
  }

  function start() {
    if (started) return;
    $('terminalOpenFolderBtn').addEventListener('click', openFolder);
    $('terminalCopyPathBtn').addEventListener('click', copyPath);
    $('terminalRestartBtn').addEventListener('click', restart);
    $('terminalCloseBtn').addEventListener('click', closeSelected);
    windowRef.addEventListener('resize', onResize);
    windowRef.addEventListener('pagehide', dispose);
    started = true;
  }

  function dispose() {
    clearTimeout(fitTimer);
    fitTimer = null;
    if (started) {
      $('terminalOpenFolderBtn').removeEventListener('click', openFolder);
      $('terminalCopyPathBtn').removeEventListener('click', copyPath);
      $('terminalRestartBtn').removeEventListener('click', restart);
      $('terminalCloseBtn').removeEventListener('click', closeSelected);
      windowRef.removeEventListener('resize', onResize);
      windowRef.removeEventListener('pagehide', dispose);
      started = false;
    }
    for (const id of [...panes.keys()]) disposePane(id);
  }

  return {
    start,
    show,
    hide,
    update,
    load,
    open,
    render,
    renderHeader,
    refreshTheme,
    dispose,
    has: (id) => state.terminals.has(id),
    firstForProject: (cwd) => list().find((terminal) => !cwd
      || terminal.cwd.toLowerCase() === cwd.toLowerCase()) ?? null,
  };
}
