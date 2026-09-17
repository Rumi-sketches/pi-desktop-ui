// Provider identity is centralized here so every UI surface resolves aliases and
// applies brand restrictions in the same way. This browser module has no DOM or
// runtime dependencies and is imported directly by the Node test suite.

const NEUTRAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M12 8.2v7.6M8.2 12h7.6"/></svg>';
const NEUTRAL_ICON = Object.freeze({
  kind: 'neutral',
  bg: '#1a2130',
  fg: '#8d97a8',
  svg: NEUTRAL_SVG,
  monoSvg: NEUTRAL_SVG,
  mono: 'neutral',
});

const LOBE_ICON_ROOT = '/vendor/@lobehub/icons-static-png';
const themedPng = (slug, suffix = '') =>
  `<img class="logo-img logo-img-light" src="${LOBE_ICON_ROOT}/light/${slug}${suffix}.png" alt="" aria-hidden="true">` +
  `<img class="logo-img logo-img-dark" src="${LOBE_ICON_ROOT}/dark/${slug}${suffix}.png" alt="" aria-hidden="true">`;
function lobeIcon(slug, label, colored = false) {
  return Object.freeze({
    kind: 'brand',
    bg: 'transparent',
    fg: 'currentColor',
    svg: colored
      ? `<img class="logo-img" src="${LOBE_ICON_ROOT}/light/${slug}-color.png" alt="" aria-hidden="true" title="${label}">`
      : themedPng(slug),
    monoSvg: themedPng(slug),
    mono: 'image',
  });
}

// `source` is the asset source when a brand mark is embedded, otherwise the
// official page that establishes why the neutral mark is required. `terms`
// records the governing guidance. A missing public permission is not treated as
// permission: those providers deliberately stay neutral.
export const PROVIDER_ICONS = Object.freeze({
  anthropic: Object.freeze({
    aliases: ['anthropic', 'claude', 'fable', 'opus', 'sonnet', 'haiku'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Claude PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('claude', 'Claude', true),
  }),
  openai: Object.freeze({
    aliases: ['openai', 'openai-codex', 'chatgpt', 'gpt', 'codex', 'o1', 'o3', 'o4'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent OpenAI PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('openai', 'OpenAI'),
  }),
  glm: Object.freeze({
    aliases: ['glm', 'chatglm', 'zhipu', 'zhipuai', 'zhipu-ai', 'z.ai', 'z-ai', 'zai', 'zai-coding-plan', 'z-ai-coding-plan', 'bigmodel'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent ChatGLM PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('chatglm', 'GLM', true),
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
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Grok PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('grok', 'Grok'),
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
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent OpenRouter PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('openrouter', 'OpenRouter', true),
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
  return `<span class="${className}" data-provider-icon="${icon.id}" data-mono="${icon.mono}" style="background:${icon.bg};color:${icon.fg}"><span class="logo-mark logo-brand">${icon.svg}</span><span class="logo-mark logo-mono">${icon.monoSvg}</span><span class="logo-mark logo-neutral">${NEUTRAL_SVG}</span></span>`;
}
