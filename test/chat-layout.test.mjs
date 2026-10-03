import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

let result;
let directory;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pi-chat-ui-test-'));
  const fixture = fileURLToPath(new URL('./fixtures/chat-ui-renderer.mjs', import.meta.url));
  // CI runs Chromium under Xvfb; this flag applies only to the isolated fixture.
  const args = [fixture, directory, ...(process.env.CI ? ['--no-sandbox'] : [])];
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  const { code, output } = await new Promise((resolve, reject) => {
    // Under Node the electron package exports its executable path, not Electron's main-process API.
    const executable = /** @type {string} */ (/** @type {unknown} */ (electron));
    const child = spawn(executable, args, { env, windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
  assert.equal(code, 0, output || 'Chat UI renderer did not exit successfully');
  result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(result.failures, [], 'The real page must load without renderer or fixture HTTP errors');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('long pasted text wraps and wide code and tables scroll without widening a narrow chat', () => {
  const { layout } = result;
  assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.messageScrollWidth <= layout.messageWidth + 1, 'Pasted text must wrap inside its bubble');
  assert.ok(layout.message.right <= layout.wrap.right + 1);
  assert.ok(layout.message.left >= layout.wrap.left - 1);
  assert.deepEqual(layout.wide.map((box) => box.tag), ['PRE', 'TABLE']);
  for (const box of layout.wide) {
    const scroll = box.code ?? box;
    assert.ok(scroll.scrollWidth > scroll.clientWidth, `${box.tag}: fixture must actually overflow: ${JSON.stringify(box)}`);
    assert.equal(scroll.overflow, 'auto', `${box.tag}: overflow must remain locally scrollable`);
    assert.ok(box.box.right <= layout.wrap.right + 1, `${box.tag}: must fit inside the chat`);
  }
});

test('user timestamps align with their bubble and completed answers show elapsed duration', () => {
  const { layout } = result;
  assert.ok(Math.abs(layout.metadataChild.right - layout.metadata.right) <= 1, 'Timestamp must be right aligned');
  assert.ok(layout.metadata.right <= layout.message.right + 1);
  assert.equal(layout.duration, '(1m 05s)');
});

test('semantic markdown follows theme changes and details keep a visible border', () => {
  const [dark, light] = result.accents;
  assert.notEqual(dark.mark, light.mark, 'Highlight must follow the selected theme');
  assert.notEqual(dark.alert, light.alert, 'Alert accent must follow the selected theme');
  for (const palette of result.accents) {
    assert.notEqual(palette.mark, 'rgba(0, 0, 0, 0)');
    assert.ok(parseFloat(palette.detailsBorder) > 0);
  }
});

test('tool output is hidden until expanded and can be collapsed again', () => {
  assert.deepEqual(result.tool, { collapsed: true, expanded: true, collapsedAgain: true });
});

test('a burst of input events defers one layout pass and its draft survives pagehide and reload', () => {
  const { single, burst } = result.scheduling;
  assert.equal(single.beforeFrame, 0, 'Typing must not synchronously measure layout');
  assert.equal(burst.beforeFrame, 0, 'Typing bursts must not synchronously measure layout');
  assert.ok(burst.afterFrame <= single.afterFrame, 'Typing bursts must not multiply layout measurements');
  assert.equal(single.fits, true, 'A multiline draft must fit within the viewport budget');
  assert.equal(burst.fits, true);
  assert.notEqual(result.draft.beforeHide, 'Draft flushed at pagehide', 'Fixture must contain an unflushed edit');
  assert.equal(result.draft.afterHide, 'Draft flushed at pagehide', 'Pagehide must synchronously flush pending edits');
  assert.equal(result.draft.restored, 'Draft flushed at pagehide');
});

test('activity survives text and recoverable errors, pauses for a form and ends when the run settles', () => {
  assert.equal(result.active.visible, true);
  assert.match(result.active.elapsed, /^01:\d{2}$/);
  assert.deepEqual(result.active.actions, [
    { label: 'Reindirizza', type: 'steer' }, { label: 'Dopo', type: 'followUp' },
  ]);
  assert.deepEqual(result.paused, { spinnerHidden: true, sendHidden: true, queueHidden: true });
  assert.equal(result.settled, true);
});
