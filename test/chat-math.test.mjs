import assert from 'node:assert/strict';
import test from 'node:test';
import { Marked } from 'marked';
import katex from 'katex';
import { createMathExtensions } from '../public/chat-math.js';

const parser = new Marked({ breaks: true, gfm: true, extensions: createMathExtensions(katex) });
const markdown = { parse: (source) => parser.parse(source, { async: false }) };
const countMath = (html) => (html.match(/class="katex"/g) ?? []).length;

import { THREAD_FORMULAS } from './fixtures/chat-math.mjs';

test('thread formulas render fractions, boxes, cases and inline symbols', () => {
  const html = markdown.parse(THREAD_FORMULAS);
  assert.equal(countMath(html), 6);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 4);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<mtable/);
  assert.match(html, /<annotation encoding="application\/x-tex">/);
  assert.doesNotMatch(html, /<br>/, 'Markdown must not insert breaks into TeX');
});

test('math works beside Markdown emphasis, links, lists and without blank lines', () => {
  const html = markdown.parse(String.raw`**Result**: \(x_i^2\), [docs](https://example.com).
\[x=\frac{1}{2}\]
- Use \(N\) keys.

A $$y=2$$ expression and $z_i$ inline.`);
  assert.equal(countMath(html), 5);
  assert.match(html, /<strong>Result<\/strong>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<li>Use/);
});

test('code spans, fenced code, escaped delimiters and prices remain literal', () => {
  const source = ['`\\(x_i\\)` and `$z$`', '```tex', '\\[x=2\\]', '$$x=3$$', '```',
    'Max x20 ($200/mo) and x5 ($100/mo); $7,059 and $4,615.', String.raw`Escaped \\(literal\\) and \$x\$.`].join('\n\n');
  const html = markdown.parse(source);
  assert.equal(countMath(html), 0);
  assert.match(html, /<code>\\\(x_i\\\)<\/code>/);
  assert.match(html, /\$200\/mo/);
  assert.match(html, /\$7,059/);
});

test('unfinished and invalid formulas do not throw or swallow following content', () => {
  assert.equal(countMath(markdown.parse(String.raw`Unfinished \(x_i`)), 0);
  const html = markdown.parse(String.raw`Invalid \(\unknownCommand{x}\) then **still here**.`);
  assert.equal(countMath(html), 0);
  assert.match(html, /\\unknownCommand/);
  assert.match(html, /<strong>still here<\/strong>/);
});

test('math rendering is bounded and refuses trusted HTML/URL commands', () => {
  const options = [];
  const extensions = createMathExtensions({ renderToString(_text, value) { options.push(value); return '<span>math</span>'; } });
  const parser = new Marked({ extensions });
  parser.parse(String.raw`\(x\)`, { async: false });
  assert.equal(options[0].trust, false);
  assert.equal(options[0].maxExpand, 1000);
  assert.equal(options[0].maxSize, 20);
  assert.equal(options[0].throwOnError, true);
  const tooLong = `\\(${'x'.repeat(10_001)}<img onerror="alert(1)">\\)`;
  const html = parser.parse(tooLong, { async: false });
  assert.equal(options.length, 1, 'oversize input is not sent to KaTeX');
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  for (const tex of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\htmlClass{injected}{x}`, String.raw`\includegraphics{https://example.com/a.png}`]) {
    const rendered = markdown.parse(`\\(${tex}\\)`);
    assert.doesNotMatch(rendered, /<a\b|<img\b|class="injected"/);
  }
});
