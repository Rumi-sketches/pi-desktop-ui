// Real page, browser modules and local assets; only HTTP/SSE responses are fixtures.
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRouter, PAGE_ROUTES, VENDOR_ROUTE } from '../../src/http/http.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'profile'));
const key = 'chat-ui-fixture';
const cwd = '/fixture-project';
const model = { provider: 'fixture', id: 'fixture-model' };
const metrics = { total: { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 },
  byModel: {}, sessionWork: null, context: null };
const platform = { os: 'linux', osName: 'Linux', pickFolder: false, openFolder: false, openTerminal: false, typeInTerminal: false };
const wideText = 'W'.repeat(500);
const tableRow = (value) => `| ${Array(30).fill(value).join(' | ')} |`;
const markdown = ['```text', wideText, '```', '', tableRow('Column'), tableRow('---'), tableRow('Wide cell'), '',
  '<mark>Highlighted</mark>', '', '> [!TIP]', '> Theme-aware advice', '',
  '<details><summary>More information</summary>Hidden explanation</details>'].join('\n');
const messages = [
  { role: 'user', text: 'USER'.repeat(250), entryId: 'user', timestamp: '2026-01-01T12:00:00.000Z' },
  { role: 'assistant', text: markdown, timestamp: '2026-01-01T12:01:05.000Z', durationMs: 65000,
    blocks: [{ type: 'text', text: markdown }, { type: 'tool', id: 'read-fixture', name: 'read', status: 'end',
      args: { path: 'README.md' }, output: 'Tool output survives expansion', isError: false }] },
];
const responses = {
  '/api/state': { key, sessionFile: key, cwd, thinkingLevels: ['off'], current: model, thinkingLevel: 'off',
    totals: { input: 0, output: 0, cost: 0, requests: 0 }, metrics, streaming: false, runStartedAt: null,
    awaitingInput: false, queuedPrompts: [], platform, chatArchiving: false },
  '/api/models': { current: model, thinkingLevel: 'off', thinkingLevels: ['off'],
    models: [{ ...model, name: 'Fixture model', thinkingLevels: ['off'] }] },
  '/api/commands': { commands: [] }, '/api/recent-cwds': { recent: [] },
  '/api/sessions': { current: key, cwd, scope: 'all', running: [], open: [key], sessions: [{ path: key, id: key, cwd,
    name: '', firstMessage: 'Layout fixture', title: 'Layout fixture', messageCount: 2,
    modified: '2026-01-01T12:01:05.000Z', favorite: false, status: 'active', provider: model.provider, model: model.id }] },
  '/api/history': { key, messages, start: 0, total: 2, before: null, live: [], streaming: false,
    awaitingInput: false, runStartedAt: null, turnModel: model },
  '/api/files': { files: [] }, '/api/git': { repo: false }, '/api/usage': {},
  '/api/terminals': { terminals: [] }, '/api/debates': { debates: [], before: null },
};

async function main() {
  const streams = new Set();
  const failures = [];
  const requested = new Set();
  const router = createRouter({ routes: PAGE_ROUTES, prefixRoutes: [VENDOR_ROUTE] });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n'); streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (Object.hasOwn(responses, url.pathname)) {
        requested.add(url.pathname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses[url.pathname]));
        return;
      }
      const route = router(url.pathname, req.method);
      if (!route || 'allow' in route) {
        failures.push(`Unexpected request: ${req.method} ${url.pathname}`);
        res.writeHead(404).end(); return;
      }
      await route.handler({ req, res, url });
    } catch (error) { failures.push(error.stack); res.writeHead(500).end(); }
  });
  let window;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await app.whenReady();
    window = new BrowserWindow({ width: 900, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') failures.push(details.message);
    });
    const run = (code) => window.webContents.executeJavaScript(code);
    async function wait(expression) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await run(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const state = await run(`JSON.stringify({ chat: document.querySelector('#chat')?.innerHTML.slice(0, 1500),
        models: document.querySelector('#modelMenu')?.textContent, input: document.querySelector('#input')?.value,
        tables: document.querySelectorAll('.msg.md table').length, tools: document.querySelectorAll('.toolHead').length })`);
      throw new Error(`Renderer did not reach ${expression}: ${failures.join('\n')}\nRequests: ${[...requested]}\n${state}`);
    }
    const nextFrame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await window.loadURL(`http://127.0.0.1:${port}/`);
    await wait("document.querySelector('.msg.md table') && document.querySelector('.toolHead') && document.querySelector('#modelMenu').textContent.includes('fixture')");
    // Let the full bootstrap finish before observing input scheduling.
    const bootDeadline = Date.now() + 15000;
    while (!requested.has('/api/debates') || !requested.has('/api/usage')) {
      if (failures.length || Date.now() >= bootDeadline) throw new Error(`Bootstrap incomplete: ${failures.join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await wait("document.querySelector('#connTxt').textContent === 'connected'");
    await nextFrame();
    const scheduling = await run(`(async () => {
      const input = document.querySelector('#input');
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      let heightReads = 0;
      Object.defineProperty(input, 'scrollHeight', { configurable: true, get() {
        heightReads++; return descriptor.get.call(this);
      } });
      async function type(value, count) {
        heightReads = 0;
        input.value = value;
        for (let index = 0; index < count; index++) input.dispatchEvent(new Event('input', { bubbles: true }));
        const beforeFrame = heightReads;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const afterFrame = heightReads;
        const fits = input.clientHeight >= Math.min(input.scrollHeight, Math.round(innerHeight * 0.4)) - 2;
        return { beforeFrame, afterFrame, fits };
      }
      try {
        const single = await type(Array(12).fill('Composer line').join('\\n'), 1);
        const burst = await type('Keep this draft', 12);
        return { single, burst };
      } finally { delete input.scrollHeight; }
    })()`);

    window.setSize(420, 900);
    await nextFrame();
    const layout = await run(`(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const wrap = document.querySelector('#chatWrap');
      const message = document.querySelector('.msg.user');
      const metadata = document.querySelector('.turn.user .msgMeta');
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        wrap: rect(wrap), message: rect(message), messageScrollWidth: message.scrollWidth, messageWidth: message.clientWidth,
        metadata: rect(metadata), metadataChild: rect(metadata.lastElementChild),
        wide: [...document.querySelectorAll('.msg.md pre, .msg.md table')].map(element => ({
          tag: element.tagName, box: rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          overflow: getComputedStyle(element).overflowX,
          code: element.querySelector('code') ? { clientWidth: element.querySelector('code').clientWidth,
            scrollWidth: element.querySelector('code').scrollWidth, overflow: getComputedStyle(element.querySelector('code')).overflowX } : null })),
        duration: document.querySelector('.runDuration')?.textContent };
    })()`);
    const tool = await run(`(() => {
      const head = document.querySelector('.toolHead'), body = document.querySelector('.toolBody');
      const collapsed = getComputedStyle(body).display === 'none';
      head.click();
      const expanded = getComputedStyle(body).display !== 'none' && body.textContent.includes('Tool output survives expansion');
      head.click();
      return { collapsed, expanded, collapsedAgain: getComputedStyle(body).display === 'none' };
    })()`);
    const accents = await run(`(() => {
      const root = document.documentElement;
      const values = [];
      for (const theme of ['paseo', 'daylight']) {
        root.dataset.theme = theme;
        const mark = getComputedStyle(document.querySelector('.msg.md mark'));
        const alert = getComputedStyle(document.querySelector('.mdAlert'));
        const details = getComputedStyle(document.querySelector('.msg.md details'));
        values.push({ mark: mark.backgroundColor, alert: alert.borderLeftColor, detailsBorder: details.borderTopWidth });
      }
      return values;
    })()`);
    window.setSize(900, 900); await nextFrame();
    const emit = (event) => {
      if (!streams.size) throw new Error('No active SSE viewer');
      for (const stream of streams) stream.write(`data: ${JSON.stringify({ key, ...event })}\n\n`);
    };
    emit({ kind: 'status', status: 'running', runStartedAt: Date.now() - 65000, model });
    await wait("!document.querySelector('#responseSpinner').classList.contains('hide') && !document.querySelector('#queueActions').classList.contains('hide')");
    emit({ kind: 'text', delta: 'An answer has started.' });
    await wait("document.querySelectorAll('.msg.assistant').length > 1");
    emit({ kind: 'error', message: 'Recoverable fixture error' });
    await wait("document.querySelector('.msg.sys.err')");
    const active = await run(`({ visible: !document.querySelector('#responseSpinner').classList.contains('hide'),
      elapsed: document.querySelector('#responseElapsed').textContent,
      actions: [...document.querySelectorAll('#queueActions button')].map(button => ({ label: button.textContent.trim(), type: button.dataset.queueType })) })`);
    emit({ kind: 'tool', id: 'form-ui', name: 'request_form', status: 'start',
      args: { title: 'Question', fields: [{ id: 'name', label: 'Name', type: 'text' }] } });
    await wait("document.querySelector('#composer').classList.contains('hide')");
    const paused = await run(`({ spinnerHidden: document.querySelector('#responseSpinner').classList.contains('hide'),
      sendHidden: document.querySelector('#sendBtn').classList.contains('hide'),
      queueHidden: document.querySelector('#queueActions').classList.contains('hide') })`);
    emit({ kind: 'tool', id: 'form-ui', name: 'request_form', status: 'end', output: '{"status":"skipped"}' });
    emit({ kind: 'status', status: 'idle' });
    await wait("!document.querySelector('#composer').classList.contains('hide') && !document.querySelector('#sendBtn').classList.contains('hide')");
    const settled = await run("document.querySelector('#responseSpinner').classList.contains('hide')");
    const draft = await run(`(() => {
      const input = document.querySelector('#input');
      input.value = 'Draft flushed at pagehide';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const stored = () => JSON.parse(sessionStorage.getItem('piComposerDrafts') ?? '{}')[${JSON.stringify(key)}] ?? null;
      const beforeHide = stored();
      window.dispatchEvent(new Event('pagehide'));
      return { beforeHide, afterHide: stored() };
    })()`);
    const reloaded = once(window.webContents, 'did-finish-load');
    window.reload();
    await reloaded;
    await wait("document.querySelector('.msg.md table') && document.querySelector('.toolHead') && document.querySelector('#modelMenu').textContent.includes('fixture')");
    draft.restored = await run("document.querySelector('#input').value");
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ scheduling, layout, tool, accents, active, paused, settled, draft, failures }));
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
