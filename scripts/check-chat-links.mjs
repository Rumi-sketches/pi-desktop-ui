// Real-renderer regression: electron scripts/check-chat-links.mjs
// Loads the actual chat view, Marked and DOMPurify. No agent, provider or OS opener.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = [
  { label: 'skill', href: 'C:/Users/Mimmo/.claude/skills/code-review/SKILL.md', local: true },
  { label: 'folder', href: 'd:/Projects/folder with spaces/', local: true },
  { label: 'report', href: 'C:/Projects/report (final).html', local: true },
  { label: 'backslashes', href: String.raw`C:\Users\Mimmo\file.md`, local: true },
  { label: 'encoded backslashes', href: 'C:%5CUsers%5CMimmo%5Cfile.md', local: true },
  { label: 'encoded slashes', href: 'C:%2FUsers%2FMimmo%2Ffile.md', local: true },
  { label: 'file URL', href: 'file:///C:/Users/Mimmo/file%20with%20spaces.md', local: true },
  { label: 'prefixed drive', href: '/C:/Users/Mimmo/file.md', local: true },
  { label: 'relative', href: './README.md:42:7', local: true },
  { label: 'parent', href: '../docs/notes.html#L12', local: true },
  { label: 'web', href: 'https://example.com/docs', local: false },
  { label: 'email', href: 'mailto:reader@example.com', local: false },
  { label: 'section', href: '#section', local: false },
];
const UNSAFE_HREFS = ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,bad', 'custom-app:run'];
const MARKDOWN = [
  ...FIXTURES.map(({ label, href }) => `Read [${label}](<${href}>) here.`),
  ...UNSAFE_HREFS.map((href, index) => `[unsafe ${index}](<${href}>)`),
  '<script>window.chatLinkUnsafe = true</script>',
  '<img src="missing" onerror="window.chatLinkUnsafe = true">',
].join('\n\n');

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-chat-link-renderer-'));
  app.setPath('userData', path.join(directory, 'profile'));
  let window, server;
  try {
    // Serve only fixture assets; never boot the app server or load user Pi state.
    const assets = new Map([
      ['/marked.js', path.join(ROOT, 'node_modules/marked/lib/marked.umd.js')],
      ['/purify.js', path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js')],
    ]);
    for (const name of ['chat-view.js', 'chat-cache.js', 'chat-previews.js', 'transport.js']) {
      assets.set(`/${name}`, path.join(ROOT, 'public', name));
    }
    server = createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'");
        res.end('<!doctype html><div id="chatWrap"><main id="chat"></main></div><div id="formDock"></div><script src="/marked.js"></script><script src="/purify.js"></script>');
        return;
      }
      const asset = assets.get(req.url);
      if (!asset) { res.writeHead(404).end(); return; }
      try {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(await readFile(asset));
      } catch { res.writeHead(500).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(`http://127.0.0.1:${port}/`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { createChatView } = await import('/chat-view.js');
      const { createChatCache } = await import('/chat-cache.js');
      const key = 'link-fixture';
      const cache = createChatCache();
      cache.ensure(key);
      const state = { queuedPrompts: [], pendingAssistantMeta: null };
      const calls = [], clicks = [];
      const view = createChatView({
        cache, getKey: () => key, getChatState: () => state,
        post: async (...args) => { calls.push(args); return { path: 'fixture' }; },
        toast() {}, setAwaitingInput() {}, setHeroMode() {}, forkFrom() {},
        cancelQueuedPrompt() {}, openImage() {},
        requestHistoryPage: async () => ({ messages: [] }), isActiveKey: () => true,
      });
      view.start();
      const chat = document.getElementById('chat');
      // Observe delegated routing, then prevent external navigation in this test.
      chat.addEventListener('click', (event) => {
        if (!event.target.closest('a')) return;
        clicks.push(event.defaultPrevented);
        event.preventDefault();
      });
      function inspect() {
        const links = [...chat.querySelectorAll('.md a')].map((a) => ({
          label: a.textContent, href: a.getAttribute('href'),
        }));
        for (const a of chat.querySelectorAll('.md a[href]')) a.click();
        return { links, calls: calls.splice(0), clicks: clicks.splice(0),
          scripts: chat.querySelectorAll('script').length,
          eventHandlers: chat.querySelectorAll('[onerror]').length,
          unsafeExecuted: window.chatLinkUnsafe === true };
      }
      const markdown = ${JSON.stringify(MARKDOWN)};
      view.renderHistory({ key, messages: [{ role: 'assistant', text: markdown }], replace: true });
      const history = inspect();
      view.renderHistory({ key, messages: [], replace: true });
      for (let start = 0; start < markdown.length; start += 23) {
        view.applyStreamEvent({ kind: 'text', delta: markdown.slice(start, start + 23) }, state);
        view.finalizeStreamingMarkdown();
      }
      const streaming = inspect();
      view.dispose();
      return { history, streaming, sanitizerSupported: DOMPurify.isSupported };
    })()`);
    assert.equal(result.sanitizerSupported, true);
    for (const [mode, rendered] of Object.entries({ history: result.history, streaming: result.streaming })) {
      for (const fixture of FIXTURES) {
        const link = rendered.links.find(({ label }) => label === fixture.label);
        assert.ok(link?.href, `${mode}: missing destination for ${fixture.label}`);
        assert.equal(decodeURIComponent(link.href), decodeURIComponent(fixture.href), `${mode}: ${fixture.label}`);
      }
      for (const label of UNSAFE_HREFS.map((_href, index) => `unsafe ${index}`)) {
        assert.equal(rendered.links.find((link) => link.label === label)?.href, null, `${mode}: ${label}`);
      }
      assert.deepEqual(rendered.clicks, FIXTURES.map(({ local }) => local), `${mode}: delegated click routing`);
      const localLinks = rendered.links.filter((link) => FIXTURES.find((fixture) => fixture.label === link.label)?.local);
      assert.deepEqual(rendered.calls, localLinks.map(({ href }) =>
        ['/api/open-local-path', { href }, { key: 'link-fixture', guardChat: true }]), `${mode}: guarded requests`);
      assert.equal(rendered.scripts, 0);
      assert.equal(rendered.eventHandlers, 0);
      assert.equal(rendered.unsafeExecuted, false);
    }
    console.log(`Chat link renderer regression passed: ${FIXTURES.length} link forms in history and streaming; guarded local clicks; unsafe protocols and script/event injection blocked.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    app.exit(Number(process.exitCode || 0));
  }
}
// Electron emits ready only after ESM evaluation finishes.
main().catch((error) => { console.error(error); app.exit(1); });
