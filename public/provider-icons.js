// Provider identity is centralized here so every UI surface resolves aliases and
// applies brand restrictions in the same way. This browser module has no DOM or
// runtime dependencies and is imported directly by the Node test suite.

const NEUTRAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M12 8.2v7.6M8.2 12h7.6"/></svg>';
const NEUTRAL_ICON = Object.freeze({
  kind: 'neutral',
  bg: '#1a2130',
  fg: '#8d97a8',
  svg: NEUTRAL_SVG,
  mono: 'neutral',
});

const OPENROUTER_SVG = '<svg width="1024" height="730" viewBox="0 0 1024 730" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M795.893 0C915.776 0 1012.95 97.9963 1012.95 218.88C1012.95 339.764 915.776 437.76 795.893 437.76L1011.2 654.869C1038.55 682.447 1019.18 729.6 980.504 729.6H361.77C161.97 729.6 0 566.273 0 364.8C0 163.327 161.97 0 361.77 0L795.893 0ZM361.77 145.92C241.89 145.92 144.708 243.916 144.708 364.8C144.708 485.684 241.89 583.68 361.77 583.68C481.649 583.68 578.831 485.684 578.831 364.8C578.831 243.916 481.649 145.92 361.77 145.92Z" fill="#7624F4"/></svg>';

const LOBE_ICON_ROOT = '/vendor/@lobehub/icons-static-svg/icons';
function lobeIcon(slug, label) {
  return Object.freeze({
    kind: 'brand',
    bg: '#ffffff',
    fg: '#111111',
    svg: `<img src="${LOBE_ICON_ROOT}/${slug}.svg" alt="" aria-hidden="true" title="${label}">`,
    mono: 'brand',
  });
}

// `source` is the asset source when a brand mark is embedded, otherwise the
// official page that establishes why the neutral mark is required. `terms`
// records the governing guidance. A missing public permission is not treated as
// permission: those providers deliberately stay neutral.
export const PROVIDER_ICONS = Object.freeze({
  anthropic: Object.freeze({
    aliases: ['anthropic', 'claude', 'fable', 'opus', 'sonnet', 'haiku'],
    source: 'https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/claude.svg',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Claude mark supplied by the MIT-licensed Lobe Icons static SVG package.',
    icon: lobeIcon('claude', 'Claude'),
  }),
  openai: Object.freeze({
    aliases: ['openai', 'openai-codex', 'chatgpt', 'gpt', 'codex', 'o1', 'o3', 'o4'],
    source: 'https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/openai.svg',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'OpenAI mark supplied by the MIT-licensed Lobe Icons static SVG package.',
    icon: lobeIcon('openai', 'OpenAI'),
  }),
  glm: Object.freeze({
    aliases: ['glm', 'chatglm', 'zhipu', 'zhipuai', 'zhipu-ai', 'z.ai', 'z-ai', 'zai'],
    source: 'https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/chatglm.svg',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'ChatGLM mark supplied by the MIT-licensed Lobe Icons static SVG package.',
    icon: lobeIcon('chatglm', 'GLM'),
  }),
  google: Object.freeze({
    aliases: ['google', 'google-gemini-cli', 'gemini'],
    source: 'https://about.google/brand-resource-center/guidance/',
    terms: 'https://about.google/brand-resource-center/guidance/',
    constraint: 'Third-party product-icon use requires prior approval; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
  kimi: Object.freeze({
    aliases: ['kimi', 'kimi-coding', 'moonshot', 'moonshot-ai', 'k2', 'k3'],
    source: 'https://www.kimi.com/en/resources/kimi-brand',
    terms: 'https://www.kimi.com/policies/logo-usage-terms',
    constraint: 'The logo license is limited to editorial, media, and non-commercial promotion; use the neutral symbol in this UI.',
    icon: NEUTRAL_ICON,
  }),
  deepseek: Object.freeze({
    aliases: ['deepseek'],
    source: 'https://www.deepseek.com/',
    terms: 'https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html',
    constraint: 'Display of DeepSeek logos requires permission; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
  xai: Object.freeze({
    aliases: ['xai', 'x-ai', 'spacexai', 'grok'],
    source: 'https://x.ai/legal/brand-guidelines',
    terms: 'https://x.ai/legal/brand-guidelines',
    constraint: 'Only the exact downloadable logo may be used without alteration; use the neutral symbol unless that asset is embedded unchanged.',
    icon: NEUTRAL_ICON,
  }),
  mistral: Object.freeze({
    aliases: ['mistral', 'codestral'],
    source: 'https://mistral.ai/brand/',
    terms: 'https://mistral.ai/brand/',
    constraint: 'The official kit forbids recoloring and unofficial variants; use the neutral symbol until an approved kit asset is embedded unchanged.',
    icon: NEUTRAL_ICON,
  }),
  meta: Object.freeze({
    aliases: ['meta', 'meta-ai', 'llama'],
    source: 'https://www.meta.com/brand/resources/meta/company-brand/',
    terms: 'https://www.meta.com/brand/resources/meta/company-brand/',
    constraint: 'Meta requires approval for all logo use; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
  ollama: Object.freeze({
    aliases: ['ollama'],
    source: 'https://ollama.com/',
    terms: 'https://ollama.com/terms',
    constraint: 'Published terms grant no right to use Ollama branding; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
  groq: Object.freeze({
    aliases: ['groq', 'groqcloud'],
    source: 'https://groq.com/trademark-policy',
    terms: 'https://groq.com/trademark-policy',
    constraint: 'Groq forbids logos in a UI without a license; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
  openrouter: Object.freeze({
    aliases: ['openrouter'],
    source: 'https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg',
    terms: 'https://openrouter.ai/brand',
    constraint: 'Official glyph used unchanged; do not stretch, recolor, or remix. Mono uses the neutral symbol.',
    icon: Object.freeze({
      kind: 'brand',
      bg: '#ffffff',
      fg: '#7624F4',
      svg: OPENROUTER_SVG,
      mono: 'neutral',
    }),
  }),
  github: Object.freeze({
    aliases: ['github', 'github-copilot'],
    source: 'https://github.com/logos',
    terms: 'https://github.com/logos',
    constraint: 'No permission for this product-picker use was verified; use the neutral symbol.',
    icon: NEUTRAL_ICON,
  }),
});

function aliasMatches(text, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

export function providerIcon(provider = '', modelId = '') {
  const providerName = String(provider).trim().toLowerCase();
  const text = `${providerName} ${String(modelId).trim().toLowerCase()}`;

  // Provider identifiers win over model aliases. A model named like another
  // company must not replace the icon of its actual provider.
  for (const [name, record] of Object.entries(PROVIDER_ICONS)) {
    if (record.aliases.includes(providerName) || name === providerName) {
      return { id: name, ...record.icon };
    }
  }
  for (const [name, record] of Object.entries(PROVIDER_ICONS)) {
    if (record.aliases.some((alias) => aliasMatches(text, alias))) {
      return { id: name, ...record.icon };
    }
  }
  return { id: '_', ...NEUTRAL_ICON };
}

function safeClasses(value) {
  return String(value).split(/\s+/).filter((part) => /^[a-z0-9_-]+$/i.test(part)).join(' ');
}

export function providerIconHtml(provider, modelId, classes = '') {
  const icon = providerIcon(provider, modelId);
  const className = ['logo', safeClasses(classes)].filter(Boolean).join(' ');
  return `<span class="${className}" data-provider-icon="${icon.id}" data-mono="${icon.mono}" style="background:${icon.bg};color:${icon.fg}"><span class="logo-mark logo-brand">${icon.svg}</span><span class="logo-mark logo-neutral">${NEUTRAL_SVG}</span></span>`;
}
