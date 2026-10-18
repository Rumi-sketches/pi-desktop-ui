// Provider identity is centralized here so every UI surface resolves aliases and
// picks a maker's mark in the same way. This browser module has no DOM or
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

// Marks derived from a Lobe Icons asset live in public/provider-logos, one PNG
// per theme, and are served through the page-asset whitelist.
function localIcon(slug) {
  const svg =
    `<img class="logo-img logo-img-light" src="/provider-logos/${slug}-light.png" alt="" aria-hidden="true">` +
    `<img class="logo-img logo-img-dark" src="/provider-logos/${slug}-dark.png" alt="" aria-hidden="true">`;
  return Object.freeze({ kind: 'brand', bg: 'transparent', fg: 'currentColor', svg, monoSvg: svg, mono: 'image' });
}

// Every known maker shows its own mark from the local Lobe Icons package; this
// is nominative use in a local tool, recorded in DECISIONS.md. `source` and
// `terms` point at the asset and its license. `aggregator` marks providers that
// serve other companies' models: their own mark identifies only the provider
// itself, never the models routed through it.
/**
 * @typedef {object} ProviderRecord
 * @property {string[]} aliases
 * @property {boolean} [aggregator]
 * @property {string} source
 * @property {string} terms
 * @property {string} constraint
 * @property {{ kind: string, bg: string, fg: string, svg: string, monoSvg: string, mono: string }} icon
 */
/** @type {Readonly<Record<string, ProviderRecord>>} */
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
    constraint: 'Transparent GLM PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('chatglm', 'GLM', true),
  }),
  google: Object.freeze({
    aliases: ['google', 'google-gemini-cli', 'gemini', 'gemma'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Gemini PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('gemini', 'Gemini', true),
  }),
  kimi: Object.freeze({
    aliases: ['kimi', 'kimi-coding', 'moonshot', 'moonshot-ai', 'moonshotai', 'k2', 'k3'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Kimi PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('kimi', 'Kimi', true),
  }),
  deepseek: Object.freeze({
    aliases: ['deepseek'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent DeepSeek PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('deepseek', 'DeepSeek', true),
  }),
  xai: Object.freeze({
    aliases: ['xai', 'x-ai', 'spacexai', 'grok'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Grok PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('grok', 'Grok'),
  }),
  mistral: Object.freeze({
    aliases: ['mistral', 'mistralai', 'codestral', 'devstral'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Mistral PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('mistral', 'Mistral', true),
  }),
  meta: Object.freeze({
    aliases: ['meta', 'meta-ai', 'meta-llama', 'llama'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Meta PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('meta', 'Meta', true),
  }),
  // MiMo precedes Xiaomi so `xiaomi/mimo-*` model ids resolve to the model mark.
  mimo: Object.freeze({
    aliases: ['mimo', 'xiaomi-mimo'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'The MIMO line of the MIT-licensed Lobe Icons Xiaomi MiMo wordmark, cropped to fit a small square.',
    icon: localIcon('mimo'),
  }),
  xiaomi: Object.freeze({
    aliases: ['xiaomi'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'The Xiaomi line of the MIT-licensed Lobe Icons Xiaomi MiMo wordmark, cropped to fit a small square.',
    icon: localIcon('xiaomi'),
  }),
  qwen: Object.freeze({
    aliases: ['qwen', 'qwq', 'alibaba', 'dashscope', 'tongyi'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Qwen PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('qwen', 'Qwen', true),
  }),
  minimax: Object.freeze({
    aliases: ['minimax'],
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent MiniMax PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('minimax', 'MiniMax', true),
  }),
  ollama: Object.freeze({
    aliases: ['ollama'],
    aggregator: true,
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Ollama PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('ollama', 'Ollama'),
  }),
  groq: Object.freeze({
    aliases: ['groq', 'groqcloud'],
    aggregator: true,
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent Groq PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('groq', 'Groq'),
  }),
  openrouter: Object.freeze({
    aliases: ['openrouter'],
    aggregator: true,
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent OpenRouter PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('openrouter', 'OpenRouter', true),
  }),
  github: Object.freeze({
    aliases: ['github', 'github-copilot'],
    aggregator: true,
    source: 'https://github.com/lobehub/lobe-icons/tree/master/packages/static-png',
    terms: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    constraint: 'Transparent GitHub Copilot PNG supplied by the MIT-licensed Lobe Icons package.',
    icon: lobeIcon('githubcopilot', 'GitHub Copilot'),
  }),
});

function aliasMatches(text, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

export function providerIcon(provider = '', modelId = '') {
  const providerName = String(provider).trim().toLowerCase();
  const modelName = String(modelId).trim().toLowerCase();
  const known = Object.entries(PROVIDER_ICONS)
    .find(([name, record]) => record.aliases.includes(providerName) || name === providerName);

  // Provider identifiers win over model aliases. A model named like another
  // company must not replace the icon of its actual provider. Aggregators are
  // the exception: their models are identified by the model id alone, so
  // `z-ai/glm-5` on OpenRouter shows GLM, and an unknown model stays neutral.
  if (known && !(known[1].aggregator && modelName)) {
    return { id: known[0], ...known[1].icon };
  }
  const text = known ? modelName : `${providerName} ${modelName}`;
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
