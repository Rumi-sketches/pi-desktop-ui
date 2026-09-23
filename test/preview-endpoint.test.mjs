import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

let root;
let server;
let url;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const html = '<h1>Preview</h1><script>window.top.alert(1)</script>';
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
  const imageResponse = await fetch(`${url}image-call`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await fetch(`${url}failed-call`)).status, 404);
  assert.equal((await fetch(`${url}missing-call`)).status, 404);
  assert.equal((await fetch(url)).status, 400);
  const history = await fetch(url.replace('/api/preview?', '/api/history?'));
  assert.equal(history.status, 200);
  const body = await history.text();
  assert.equal(body.includes(html), false);
  assert.equal(body.includes(image), false);
  assert.match(body, /"previewReady":true/);
});
