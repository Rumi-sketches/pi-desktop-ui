// Optional real-renderer smoke test: electron scripts/check-debates-ui.mjs
// Uses isolated app/agent state and a local fake provider. No paid model requests.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fixtureRuntime, fixtureModel } from '../test/fixtures/debate-runtime.mjs';

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-debate-renderer-'));
  process.env.PI_WEB_UI_TEST = '1';
  process.env.PI_WEB_UI_AGENT_DIR = path.join(directory, 'agent');
  process.env.PI_CODING_AGENT_DIR = path.join(directory, 'agent');
  app.setPath('userData', path.join(directory, 'profile'));
  let server, window;
  const errors = [];
  try {
    await app.whenReady();
    const { startServer } = await import('../server.mjs');
    server = await startServer({ port: 0 });
    const { getModelRuntime } = await import('../src/chat/contexts.mjs');
    const runtime = getModelRuntime();
    const modelCalls = [];
    const project = path.join(directory, 'fixture-project');
    await mkdir(project);
    await writeFile(path.join(project, 'README.md'), 'READ_ONLY_PROJECT_EVIDENCE');
    Object.assign(runtime, fixtureRuntime({ calls: modelCalls, delay: 250,
      toolCall: { name: 'read', arguments: { path: 'README.md' } },
      decorate: (text) => `${text}\n\n<script>window.debateUnsafe = true</script><img src="/not-an-image" onerror="window.debateUnsafe = true">[unsafe](javascript:alert(1))`,
    }));
    runtime.getModels = () => ['model-a', 'model-b'].map(fixtureModel);
    runtime.checkAuth = async () => ({ configured: true });
    window = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    async function wait(expression) {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (await run(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Renderer did not reach: ${expression}\n${errors.join('\n')}`);
    }
    await window.loadURL(server.url);
    await wait(`document.querySelector('#modelMenu')?.textContent.includes('debate-fixture')`);
    assert.equal(await run(`getComputedStyle(document.querySelector('#debatesSidebar')).display`), 'none');
    await run(`document.querySelector('#navDebates').click()`);
    await wait(`document.querySelector('#debateModelA').options.length === 2`);
    assert.equal(await run(`getComputedStyle(document.querySelector('#sessionList')).display`), 'none');
    await run(`document.querySelector('#debateCwd').value = ${JSON.stringify(project)}`);
    await run(`
      document.querySelector('#debatePrompt').value = 'Explore a public library open all night.';
      document.querySelector('#debateModelB').value = '1';
      document.querySelector('#debateModelB').dispatchEvent(new Event('change'));
      document.querySelector('#debateEffortB').value = 'high';
      const transfer = new DataTransfer();
      transfer.items.add(new File(['PRIVATE_ATTACHMENT_CONTENT'], 'requirements.md', { type: 'text/plain' }));
      document.querySelector('#debateFileInput').files = transfer.files;
      document.querySelector('#debateFileInput').dispatchEvent(new Event('change'));
    `);
    await wait(`document.querySelectorAll('#debateAttachments .debate-file').length === 1 && !document.querySelector('#debateLaunch').disabled`);
    await run(`document.querySelector('#debatePrompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('running')`);
    await run(`document.querySelector('#navSettings').click()`);
    await wait(`!document.querySelector('#settingsView').classList.contains('hide')`);
    await run(`document.querySelector('#navChat').click()`);
    assert.equal(await run(`getComputedStyle(document.querySelector('#debatesSidebar')).display`), 'none');
    await run(`document.querySelector('#navDebates').click()`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('completed')`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 8`);
    assert.deepEqual(modelCalls.slice(0, 2).map((call) => call.model.id), ['model-a', 'model-b']);
    assert.equal(await run(`document.querySelector('#debateModels').textContent.includes('model-b (high)')`), true);
    assert.equal(await run(`document.querySelectorAll('#debateTranscript h3')[1].textContent.includes('model-b (high)')`), true);
    assert.ok(JSON.stringify(modelCalls[0].context.messages).includes('PRIVATE_ATTACHMENT_CONTENT'));
    assert.ok(modelCalls.some((call) => JSON.stringify(call.context.messages).includes('READ_ONLY_PROJECT_EVIDENCE')));
    assert.equal(await run(`document.querySelector('#debateTranscript').textContent.includes('private-')`), false);
    assert.equal(await run(`document.querySelectorAll('#debateTranscript script, #debateTranscript img, #debateTranscript a[href^="javascript:"]').length`), 0);
    assert.equal(await run(`window.debateUnsafe === true`), false);
    await run(`document.querySelector('#debateFinals').click()`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 2`);
    assert.deepEqual(await run(`[...document.querySelectorAll('#debateTranscript .debate-turn')].map(n => n.dataset.turn)`), ['A4', 'B4']);
    const reloaded = once(window.webContents, 'did-finish-load');
    window.webContents.reload();
    await reloaded;
    await wait(`document.querySelector('#debateStatus')?.textContent.includes('completed') && !document.querySelector('#debateView').classList.contains('hide')`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 8`);
    await run(`document.querySelector('#debateContinuePrompt').value = 'Now focus on staffing costs.'; document.querySelector('#debateContinueRounds').value = '2'; document.querySelector('#debateContinueForm').requestSubmit()`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('Cycle 2') && document.querySelector('#debateStatus').textContent.includes('completed')`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 12`);
    assert.ok(modelCalls.some((call) => JSON.stringify(call.context.messages).includes('Now focus on staffing costs.') && JSON.stringify(call.context.messages).includes('PRIVATE_ATTACHMENT_CONTENT')));
    await run(`document.querySelector('#debateFinals').click()`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 2`);
    assert.deepEqual(await run(`[...document.querySelectorAll('#debateTranscript .debate-turn')].map(n => n.dataset.turn)`), ['A2', 'B2']);
    await run(`document.querySelector('#debateView').scrollTop = 0; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const screenshot = path.join(os.tmpdir(), 'pi-debate-ui-smoke.png');
    await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    window.setSize(480, 800);
    await run(`document.querySelector('#newDebateBtn').click()`);
    assert.equal(await run(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    await run(`document.querySelector('#debateCwd').value = ${JSON.stringify(project)}; document.querySelector('#debatePrompt').value = 'Explore late-night library staffing.'; document.querySelector('#debateRounds').value = '12'; document.querySelector('#debateForm').requestSubmit()`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('running') && !document.querySelector('#debateStop').disabled`);
    await run(`document.querySelector('#debateStop').click()`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('interrupted') && !document.querySelector('#debateResume').disabled`);
    await run(`document.querySelector('#debateResume').click()`);
    await wait(`document.querySelector('#debateStatus').textContent.includes('completed')`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 20`);
    await run(`document.querySelector('#debateOlder').click()`);
    await wait(`document.querySelectorAll('#debateTranscript .debate-turn').length === 4`);
    assert.deepEqual(await run(`[...document.querySelectorAll('#debateTranscript .debate-turn')].map(n => n.dataset.turn)`), ['A1', 'B1', 'A2', 'B2']);
    assert.deepEqual(errors, []);
    console.log(`Debate renderer smoke passed: separate navigation, read-only tools, attachments, continuation with new rounds, model labels, conclusions, reload, stop/resume, paging, sanitization, narrow layout. Screenshot: ${screenshot}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
    app.exit(Number(process.exitCode || 0));
  }
}
// Do not await app.whenReady() at module scope: Electron waits for ESM evaluation before ready.
main().catch((error) => { console.error(error); app.exit(1); });
