import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// A fresh process lets the injected fs binding take effect before preferences is imported.
test("partial settings write rejects without damaging old keys, cleans up, and recovers", () => {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-atomic-'));
    process.env.PI_WEB_UI_TEST = '1';
    process.env.PI_WEB_UI_AGENT_DIR = dir;
    const file = path.join(dir, 'settings.json');
    const original = '{"prior":{"keep":true},"theme":"dark"}\\n';
    try {
      await writeFile(file, original);
      const write = fs.promises.writeFile;
      let injected = false;
      fs.promises.writeFile = async (target, data, ...args) => {
        if (!injected && String(target).startsWith(file)) {
          injected = true;
          await write(target, String(data).slice(0, 7), ...args);
          const error = new Error('injected disk full');
          error.code = 'ENOSPC';
          throw error;
        }
        return write(target, data, ...args);
      };
      syncBuiltinESMExports();
      const { updateSettingsFile, readSettingsFile } = await import('./src/storage/preferences.mjs');
      await assert.rejects(updateSettingsFile(s => { s.theme = 'light'; }), { code: 'ENOSPC' });
      assert.equal(injected, true);
      assert.equal(await readFile(file, 'utf8'), original);
      assert.deepEqual(await readdir(dir), ['settings.json']);
      assert.deepEqual(await readSettingsFile(), { prior: { keep: true }, theme: 'dark' });
      fs.promises.writeFile = write;
      syncBuiltinESMExports();
      await updateSettingsFile(s => { s.theme = 'light'; });
      assert.equal(await readFile(file, 'utf8'), JSON.stringify({ prior: { keep: true }, theme: 'light' }, null, 2) + '\\n');
      assert.deepEqual(await readdir(dir), ['settings.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PI_WEB_UI_TEST: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
});
