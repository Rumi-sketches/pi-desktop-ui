import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLocalLink } from '../api-chat.mjs';

test('local links resolve relative to the chat folder and discard source locations', () => {
  const cwd = path.resolve('fixture-project');
  assert.equal(resolveLocalLink('./src/app.js:42:7', cwd), path.join(cwd, 'src', 'app.js'));
  assert.equal(resolveLocalLink('README.md#L12C4', cwd), path.join(cwd, 'README.md'));
});

test('file URLs resolve to native absolute paths', () => {
  const target = path.resolve('fixture-project', 'file with spaces.txt');
  assert.equal(resolveLocalLink(pathToFileURL(target).href, process.cwd()), target);
});

test('malformed local links are rejected', () => {
  assert.equal(resolveLocalLink('%ZZ', process.cwd()), null);
  assert.equal(resolveLocalLink('', process.cwd()), null);
  assert.equal(resolveLocalLink('bad\0path', process.cwd()), null);
});
