import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedExternalUrl } from '../electron/external-links.mjs';

test('desktop navigation allows web links on every platform', () => {
  /** @type {NodeJS.Platform[]} */
  const platforms = ['win32', 'darwin', 'linux'];
  for (const platform of platforms) {
    assert.equal(isAllowedExternalUrl('https://example.com/docs', platform), true);
    assert.equal(isAllowedExternalUrl('mailto:user@example.com', platform), true);
  }
});

test('desktop navigation limits Windows Settings links to Windows', () => {
  assert.equal(isAllowedExternalUrl('ms-settings:display', 'win32'), true);
  assert.equal(isAllowedExternalUrl('ms-settings:display', 'darwin'), false);
  assert.equal(isAllowedExternalUrl('ms-settings:display', 'linux'), false);
});

test('desktop navigation rejects local, executable and malformed URLs', () => {
  assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/cmd.exe', 'win32'), false);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)', 'win32'), false);
  assert.equal(isAllowedExternalUrl('not a URL', 'win32'), false);
});
