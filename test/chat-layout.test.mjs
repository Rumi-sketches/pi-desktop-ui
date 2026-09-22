import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `${selector} rule exists`);
  return match[1];
}

test('the transcript clips page-level horizontal overflow', () => {
  assert.match(rule('#chatWrap'), /overflow-x:\s*clip/);
});

test('messages wrap pasted text and cannot exceed their turn', () => {
  assert.match(rule('.turn'), /min-width:\s*0/);
  assert.match(rule('.turn'), /max-width:\s*100%/);
  assert.match(rule('.msg'), /min-width:\s*0/);
  assert.match(rule('.msg'), /max-width:\s*100%/);
  assert.match(rule('.msg'), /overflow-wrap:\s*anywhere/);
});

test('message timestamps stay compact and user metadata aligns with its bubble', () => {
  assert.match(rule('.msgMeta'), /gap:\s*\.25em/);
  assert.match(rule('.msgMeta'), /white-space:\s*nowrap/);
  assert.match(rule('.turn.user .msgMeta'), /justify-content:\s*flex-end/);
});

test('intrinsically wide markdown scrolls locally', () => {
  for (const selector of ['.msg.md pre', '.msg.md table']) {
    assert.match(rule(selector), /max-width:\s*100%/);
    assert.match(rule(selector), /overflow-x:\s*auto/);
  }
  assert.match(rule('.msg.md pre'), /white-space:\s*pre/);
});

test('streaming markdown preserves plain-text line breaks before final rendering', () => {
  assert.match(rule('.msg.md.streaming'), /white-space:\s*pre-wrap/);
});

test('tool calls render as an expandable work timeline', () => {
  assert.match(rule('.toolCard'), /padding-left:\s*32px/);
  assert.match(rule('.toolCard::before'), /background:\s*var\(--line-2\)/);
  assert.match(rule('.toolHead'), /grid-template-columns:/);
  assert.match(rule('.toolResult'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.toolBody'), /display:\s*none/);
  assert.match(rule('.toolCard.open .toolBody'), /display:\s*block/);
});
