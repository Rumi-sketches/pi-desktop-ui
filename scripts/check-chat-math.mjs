// Real renderer check: electron scripts/check-chat-math.mjs
// Exercises the production assets/CSP without booting agents or reading Pi state.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouter, PAGE_ROUTES, VENDOR_ROUTE } from '../src/http/http.mjs';
import { THREAD_FORMULAS } from '../test/fixtures/chat-math.mjs';

const MARKDOWN = [
  THREAD_FORMULAS,
  '**Markdown still works**; plans cost $200/mo and $100/mo.',
  '`\\(literal_code\\)`',
  '```tex\n\\[literal_fence\\]\n```',
  String.raw`Invalid \(\notACommand{x}\) then **still readable**.`,
  String.raw`Untrusted \(\href{javascript:alert(1)}{click}\), \(\htmlClass{injected}{x}\), \(\includegraphics{https://example.invalid/image.png}\).`,
  '<img src="missing" onerror="window.mathUnsafe=true"><script>window.mathUnsafe=true</script>',
  `$$${Array(100).fill('x_i').join('+')}$$`,
].join('\n\n');

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-chat-math-renderer-'));
  app.setPath('userData', path.join(directory, 'profile'));
  let window, server;
  try {
    const router = createRouter({ routes: PAGE_ROUTES, prefixRoutes: [VENDOR_ROUTE] });
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          // Keep the real head, local libraries and CSP, but omit app.js and
          // substitute only transcript roots. No real session/config endpoints.
          const index = /** @type {(bag: any) => Promise<void>} */ (PAGE_ROUTES.find(([, pathname]) => pathname === '/')[2]);
          await index({ res: {
            writeHead(code, headers) { res.writeHead(code, headers); },
            end(html) { res.end(html.replace(/<body>[\s\S]*/, '<body><div id="chatWrap"><main id="chat"></main></div><div id="formDock"></div></body></html>')); },
          } });
          return;
        }
        const route = router(url.pathname, 'GET');
        if (!route || 'allow' in route) { res.writeHead(404).end(); return; }
        await route.handler({ req, res, url });
      } catch { res.writeHead(500).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await app.whenReady();
    window = new BrowserWindow({ width: 900, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(`http://127.0.0.1:${port}/`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
      const { createChatView } = await import('/chat-view.js');
      const { createChatCache } = await import('/chat-cache.js');
      const key = 'math-fixture', cache = createChatCache();
      cache.ensure(key);
      const state = { queuedPrompts: [], pendingAssistantMeta: null };
      const view = createChatView({
        cache, getKey: () => key, getChatState: () => state,
        post: async () => ({}), toast() {}, setAwaitingInput() {}, setHeroMode() {}, forkFrom() {},
        cancelQueuedPrompt() {}, openImage() {}, requestHistoryPage: async () => ({ messages: [] }), isActiveKey: () => true,
      });
      view.start();
      const markdown = ${JSON.stringify(MARKDOWN)};
      const chat = document.getElementById('chat');
      function inspect() {
        return {
          math: chat.querySelectorAll('.katex').length,
          display: chat.querySelectorAll('.katex-display').length,
          mathml: chat.querySelectorAll('math').length,
          fractions: chat.querySelectorAll('mfrac').length,
          cases: chat.querySelectorAll('mtable').length,
          literalCode: [...chat.querySelectorAll('code')].map((node) => node.textContent),
          prices: chat.textContent.includes('$200/mo and $100/mo'),
          bold: chat.querySelector('strong')?.textContent,
          scripts: chat.querySelectorAll('script').length,
          eventHandlers: chat.querySelectorAll('[onerror]').length,
          unsafe: Boolean(window.mathUnsafe),
          trustedHtml: chat.querySelectorAll('a[href^="javascript:"], .injected, img[src^="https://example.invalid"]').length,
        };
      }
      view.renderHistory({ key, messages: [{ role: 'assistant', text: markdown }], replace: true });
      const history = inspect();
      await document.fonts.ready;
      view.renderHistory({ key, messages: [], replace: true });
      // Force projections at partial delimiter/TeX boundaries, not just completion.
      for (let offset = 0; offset < markdown.length; offset += 17) {
        view.applyStreamEvent({ kind: 'text', delta: markdown.slice(offset, offset + 17) }, state);
        view.finalizeStreamingMarkdown();
      }
      const streaming = inspect();
      await document.fonts.ready;
      const fonts = [...document.fonts].filter((font) => font.family.startsWith('KaTeX') && font.status === 'loaded').length;
      const fontResources = performance.getEntriesByType('resource').filter((item) => item.name.includes('/katex/dist/fonts/')).map((item) => item.name);
      window.mathFixture = { view, inspect };
      return { history, streaming, fonts, fontResources, violations, sanitizerSupported: DOMPurify.isSupported };
    })()`);
    assert.equal(result.sanitizerSupported, true);
    assert.deepEqual(result.streaming, result.history, 'history and partial streaming converge');
    assert.equal(result.history.math, 10);
    assert.equal(result.history.display, 5);
    assert.equal(result.history.mathml, 10, 'accessible MathML survives sanitization');
    assert.ok(result.history.fractions > 0);
    assert.ok(result.history.cases > 0);
    assert.deepEqual(result.history.literalCode, [String.raw`\(literal_code\)`, '\\[literal_fence\\]\n']);
    assert.equal(result.history.prices, true);
    assert.equal(result.history.bold, 'Markdown still works');
    assert.equal(result.history.scripts, 0);
    assert.equal(result.history.eventHandlers, 0);
    assert.equal(result.history.unsafe, false);
    assert.equal(result.history.trustedHtml, 0);
    assert.ok(result.fonts > 0, 'local math fonts loaded');
    assert.ok(result.fontResources.length > 0);
    assert.deepEqual(result.violations, []);
    window.setSize(420, 900);
    const layout = await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const display = [...document.querySelectorAll('.katex-display')].at(-1);
      resolve({ pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        equationWidth: display.scrollWidth, boxWidth: display.clientWidth, overflow: getComputedStyle(display).overflowX });
    })))`);
    assert.ok(layout.equationWidth > layout.boxWidth, 'wide math needs scrolling');
    assert.equal(layout.overflow, 'auto');
    assert.ok(layout.pageWidth <= layout.viewport, 'wide math must not widen the chat');
    if (process.env.PI_MATH_SCREENSHOT) {
      window.setSize(900, 900);
      await writeFile(process.env.PI_MATH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    console.log('Math renderer regression passed: thread formulas in history/streaming; local fonts and CSP; MathML; literal code/prices; injection blocked; narrow-screen equation scrolling.');
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
main().catch((error) => { console.error(error); app.exit(1); });
