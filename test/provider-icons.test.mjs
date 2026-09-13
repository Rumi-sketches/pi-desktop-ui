import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PROVIDER_ICONS, providerIcon, providerIconHtml } from '../public/provider-icons.js';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');

test('every provider record documents an official source and usage constraint', () => {
  for (const [name, record] of Object.entries(PROVIDER_ICONS)) {
    assert.match(record.source, /^https:\/\//, `${name} source`);
    assert.match(record.terms, /^https:\/\//, `${name} terms`);
    assert.ok(record.constraint.length > 20, `${name} constraint`);
  }
});

test('Claude, OpenAI and GLM use the local Lobe Icons package', () => {
  for (const name of ['anthropic', 'openai', 'glm']) {
    const record = PROVIDER_ICONS[name];
    assert.equal(record.icon.kind, 'brand');
    assert.match(record.source, /lobehub\/lobe-icons/);
    assert.match(record.icon.svg, /\/vendor\/@lobehub\/icons-static-png\/(light|dark)\//);
    assert.match(record.icon.monoSvg, /\/vendor\/@lobehub\/icons-static-png\/(light|dark)\//);
  }
});

test('the current official OpenRouter glyph stays fixed in brand mode', () => {
  const record = PROVIDER_ICONS.openrouter;
  const icon = providerIcon('openrouter', 'model');
  assert.equal(record.icon.kind, 'brand');
  assert.equal(icon.id, 'openrouter');
  assert.equal(icon.mono, 'neutral');
  assert.match(icon.svg, /viewBox="0 0 1024 730"/);
  assert.match(icon.svg, /fill="#7624F4"/);
  assert.doesNotMatch(icon.svg, /currentColor/);
});

test('provider and model aliases resolve without stealing known providers', () => {
  assert.equal(providerIcon('openai-codex', 'gpt-5.6').id, 'openai');
  assert.equal(providerIcon('kimi-coding', 'k2.5').id, 'kimi');
  assert.equal(providerIcon('', 'claude-sonnet').id, 'anthropic');
  assert.equal(providerIcon('', 'gemini-3-pro').id, 'google');
  assert.equal(providerIcon('', 'llama-4').id, 'meta');
  assert.equal(providerIcon('custom-provider', 'gpt-compatible').id, 'openai');
  assert.equal(providerIcon('anthropic', 'gpt-compatible').id, 'anthropic');
  assert.equal(providerIcon('zai', 'glm-5').id, 'glm');
  assert.equal(providerIcon('zai-coding-plan', 'glm-5').id, 'glm');
  assert.equal(providerIcon('', 'GLM-4.7').id, 'glm');
});

test('only marks with verified permission use a brand asset', () => {
  const branded = Object.entries(PROVIDER_ICONS)
    .filter(([, record]) => record.icon.kind === 'brand')
    .map(([name]) => name);
  assert.deepEqual(branded, ['anthropic', 'openai', 'glm', 'openrouter']);
});

test('unknown providers and restricted mono mode use the neutral mark', () => {
  const unknown = providerIcon('acme', 'model');
  assert.equal(unknown.id, '_');
  assert.equal(unknown.kind, 'neutral');
  const html = providerIconHtml('openrouter', 'model', 'lg fixed');
  assert.match(html, /data-provider-icon="openrouter"/);
  assert.match(html, /data-mono="neutral"/);
  assert.match(html, /logo-brand/);
  assert.match(html, /logo-neutral/);
  assert.match(providerIconHtml('glm', 'glm-5'), /chatglm-color\.png/);
  assert.match(providerIconHtml('glm', 'glm-5'), /logo-mono/);
  assert.match(cssSource, /data-mono="neutral"[^}]*logo-brand/);
  assert.match(cssSource, /data-mono="neutral"[^}]*logo-neutral/);
});

test('all UI surfaces import the one map and the browser preloads its served module', () => {
  assert.match(appSource, /import \{ providerIconHtml \} from '.\/provider-icons\.js';/);
  assert.doesNotMatch(appSource, /const LOGOS\s*=/);
  assert.match(appSource, /h\.innerHTML = providerIconHtml\(s\.provider, s\.model\)/);
  assert.match(indexSource, /<link rel="modulepreload" href="\/provider-icons\.js">/);
});
