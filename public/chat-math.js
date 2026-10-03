const MAX_MATH_LENGTH = 10_000;
const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/**
 * Tokenize math before Markdown consumes backslashes, underscores and line breaks.
 * Marked handles code spans/fences first, so their literal examples stay untouched.
 * The caller must sanitize the complete Markdown HTML, including these renderings.
 * @param {{ renderToString: (text: string, options: any) => string }} katex
 */
export function createMathExtensions(katex) {
  function render(token) {
    if (token.text.length > MAX_MATH_LENGTH) return escapeHtml(token.raw);
    try {
      return katex.renderToString(token.text, {
        displayMode: token.displayMode,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
        output: 'htmlAndMathml',
      });
    } catch {
      // Incomplete streaming expressions and invalid TeX stay readable, not errors.
      return escapeHtml(token.raw);
    }
  }

  return [{
    name: 'chatMathBlock',
    level: 'block',
    start(source) { return source.search(/^ {0,3}(?:\\\[|\$\$)/m); },
    tokenizer(source) {
      const match = /^ {0,3}\\\[([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source)
        ?? /^ {0,3}\$\$([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
      if (match) return { type: 'chatMathBlock', raw: match[0], text: match[1].trim(), displayMode: true };
    },
    renderer(token) { return `${render(token)}\n`; },
  }, {
    name: 'chatMathInline',
    level: 'inline',
    start(source) { return source.search(/\\[([]|\$\$|\$(?![\s\d$])/); },
    tokenizer(source) {
      const display = /^\\\[([\s\S]*?)\\\]/.exec(source) ?? /^\$\$([\s\S]*?)\$\$/.exec(source);
      const match = display ?? /^\\\(([^\n]*?)\\\)/.exec(source)
        // Single-dollar math is deliberately conservative: $200/mo and $100/mo
        // are prices, not one expression. Numeric math can use \\( ... \\).
        ?? /^\$(?![\s\d$])((?:\\.|[^\\$\n])*?[^\s\\$])\$(?!\d)/.exec(source);
      if (match) return { type: 'chatMathInline', raw: match[0], text: match[1].trim(), displayMode: Boolean(display) };
    },
    renderer: render,
  }];
}
