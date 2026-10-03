import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

let root;
let server;
let url;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const HTML_BODY_SENTINEL = 'SECRET_HTML_PREVIEW_BODY';
const html = `<button onclick="this.textContent='Clicked'">${HTML_BODY_SENTINEL}</button><script>document.title="Preview"</script>`;
const image = png.toString('base64');
const entry = (id, parentId, message) => ({
  type: 'message', id, parentId, timestamp: new Date().toISOString(),
  message: message.role === 'assistant'
    ? { ...message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    : message,
});

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pi-preview-endpoint-'));
  process.env.PI_WEB_UI_TEST = '1';
  process.env.PI_WEB_UI_AGENT_DIR = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const dir = path.join(root, 'sessions', 'project');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'preview.jsonl');
  const records = [
    { type: 'session', version: 3, id: 'preview-fixture', cwd: process.cwd(), timestamp: new Date().toISOString() },
    entry('user', null, { role: 'user', content: [{ type: 'text', text: 'Show examples' }] }),
    entry('html', 'user', { role: 'assistant', content: [{ type: 'toolCall', id: 'html-call', name: 'show_html', arguments: { html } }] }),
    entry('html-result', 'html', { role: 'toolResult', toolCallId: 'html-call', toolName: 'show_html', isError: false, content: [{ type: 'text', text: 'HTML preview available in the chat.' }] }),
    entry('image', 'html-result', { role: 'assistant', content: [{ type: 'toolCall', id: 'image-call', name: 'show_image', arguments: { data: image, mimeType: 'image/png' } }] }),
    entry('image-result', 'image', { role: 'toolResult', toolCallId: 'image-call', toolName: 'show_image', isError: false, content: [{ type: 'text', text: 'Image preview available in the chat.' }] }),
    entry('failed', 'image-result', { role: 'assistant', content: [{ type: 'toolCall', id: 'failed-call', name: 'show_html', arguments: { html: 'secret-failed-html' } }] }),
    entry('failed-result', 'failed', { role: 'toolResult', toolCallId: 'failed-call', toolName: 'show_html', isError: true, content: [{ type: 'text', text: 'failed' }] }),
  ];
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const { startServer } = await import('../server.mjs');
  server = await startServer({ port: 0 });
  url = `${server.url.replace(/\/$/, '')}/api/preview?s=${encodeURIComponent(file)}&call=`;
});

after(async () => {
  await server?.stop();
  await rm(root, { recursive: true, force: true });
});

test('preview route serves only completed branch calls and never embeds payloads in history', async () => {
  const htmlResponse = await fetch(`${url}html-call`);
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-type'), /^text\/plain/);
  assert.equal(htmlResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await htmlResponse.text(), html);
  const viewResponse = await fetch(`${url}html-call&view=1`);
  assert.equal(viewResponse.status, 200);
  assert.match(viewResponse.headers.get('content-type'), /^text\/html/);
  assert.equal(viewResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(viewResponse.headers.get('cache-control'), 'no-store');
  assert.equal(await viewResponse.text(), html);
  const csp = viewResponse.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.equal((await fetch(`${url}failed-call&view=1`)).status, 404);
  const page = await fetch(url.replace('/api/preview?', '/?'));
  assert.match(page.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);
  const imageResponse = await fetch(`${url}image-call`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await fetch(`${url}image-call&view=1`)).status, 404);
  assert.equal((await fetch(`${url}failed-call`)).status, 404);
  assert.equal((await fetch(`${url}missing-call`)).status, 404);
  assert.equal((await fetch(url)).status, 400);
  const history = await fetch(url.replace('/api/preview?', '/api/history?'));
  assert.equal(history.status, 200);
  const body = await history.json();
  // A plain sentinel survives JSON escaping; raw JSON.includes(html) does not.
  const exposed = JSON.stringify(body);
  assert.equal(exposed.includes(HTML_BODY_SENTINEL), false);
  assert.equal(exposed.includes('secret-failed-html'), false);
  assert.equal(exposed.includes(image), false);
  const tools = body.messages.flatMap((message) => message.blocks)
    .filter((block) => block.type === 'tool');
  assert.deepEqual(tools, [
    { type: 'tool', id: 'html-call', name: 'show_html', args: {}, summary: 'Chat preview',
      status: 'end', output: 'HTML preview available in the chat.', isError: false, previewReady: true },
    { type: 'tool', id: 'image-call', name: 'show_image', args: {}, summary: 'Chat preview',
      status: 'end', output: 'Image preview available in the chat.', isError: false, previewReady: true },
    { type: 'tool', id: 'failed-call', name: 'show_html', args: {}, summary: 'Chat preview',
      status: 'end', output: 'failed', isError: true, previewReady: false },
  ]);
});
