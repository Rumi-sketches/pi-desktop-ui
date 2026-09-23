import path from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, SETTINGS_PATH } from "./agent-paths.mjs";
import { jsonFile, mutateJsonFile, mutationQueue } from "./json-store.mjs";
import { withFileLock } from "./file-lock.mjs";

/**
 * One independently persisted preference with a private state and mutation
 * queue. Stores share the lifecycle, not their defaults or transactions.
 * @template T
 * @param {string} name
 * @param {{ fallback: () => T, revive: (raw: any) => T | undefined }} options
 */
function preferenceFile(name, options) {
  const file = path.join(AGENT_DIR, name);
  const store = jsonFile(file, options);
  const mutate = mutationQueue();
  let state = options.fallback();
  return {
    async load() {
      state = await store.load();
    },
    read() {
      // A different instance may have changed a consent since startup.
      // On read failure, never authorize provider work from stale memory.
      try {
        const latest = options.revive(JSON.parse(readFileSync(file, "utf8")));
        state = latest === undefined ? options.fallback() : latest;
      } catch {
        state = options.fallback();
      }
      return state;
    },
    /** @param {(current: T) => T} operation */
    update(operation) {
      return mutate(async () => {
        const next = await mutateJsonFile(store, file, operation);
        state = next;
        return next;
      });
    },
  };
}

// The web-ui-* prefix, cookie and PI_WEB_UI_* environment names are persisted
// compatibility contracts. Existing installations must keep finding the same
// files without a migration.

// Pi owns settings.json and models.json. This adapter is for read-only config
// payloads; the settings writer below preserves pi's own formatting.
export const agentJsonFile = (name) => jsonFile(path.join(AGENT_DIR, name));

// ---- agent bootstrap preferences -----------------------------------------
const defaultAgentBootstrap = () => ({ tools: null });
const agentBootstrap = preferenceFile("web-ui-agent-bootstrap.json", {
  fallback: defaultAgentBootstrap,
  revive: (raw) => {
    if (!raw || typeof raw !== "object") return undefined;
    if (raw.tools === null || raw.tools === undefined) return defaultAgentBootstrap();
    if (!Array.isArray(raw.tools) || raw.tools.some((name) => typeof name !== "string")) return undefined;
    return { tools: [...new Set(raw.tools.map((name) => name.trim()).filter(Boolean))] };
  },
});
export const agentBootstrapState = () => {
  const state = agentBootstrap.read();
  return { tools: state.tools === null ? null : [...state.tools] };
};
export function setAgentBootstrapTools(tools) {
  const requested = tools === null ? null : [...new Set(tools)];
  return agentBootstrap.update(() => ({ tools: requested === null ? null : [...requested] }))
    .then(() => agentBootstrapState());
}

// ---- chat archiving preference -------------------------------------------
const defaultArchiving = () => ({ enabled: true, firstRunArchivedAt: null });
const archiving = preferenceFile("web-ui-archiving.json", {
  fallback: defaultArchiving,
  revive: (raw) =>
    raw && typeof raw === "object"
      ? {
          enabled: raw.enabled !== false,
          firstRunArchivedAt: typeof raw.firstRunArchivedAt === "string" ? raw.firstRunArchivedAt : null,
        }
      : undefined,
});
export const archivingState = () => ({ ...archiving.read() });
export const isArchivingEnabled = () => archiving.read().enabled;
export function setArchivingEnabled(enabled) {
  return archiving.update((current) => ({ ...current, enabled })).then(() => undefined);
}
export function markFirstRunArchivingComplete() {
  return archiving.update((current) => {
    if (!current.enabled || current.firstRunArchivedAt) return current;
    return { ...current, firstRunArchivedAt: new Date().toISOString() };
  }).then(() => undefined);
}

// ---- title generation preferences ----------------------------------------
const defaultTitleGeneration = () => ({
  enabled: false,
  enabledAt: null,
  lunaTitleFallback: false,
  lunaTitleFallbackEnabledAt: null,
});
const titleGeneration = preferenceFile("web-ui-title-generation.json", {
  fallback: defaultTitleGeneration,
  revive: (raw) =>
    raw && typeof raw === "object"
      ? {
          enabled: raw.enabled === true,
          enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : null,
          lunaTitleFallback: raw.lunaTitleFallback === true,
          lunaTitleFallbackEnabledAt:
            typeof raw.lunaTitleFallbackEnabledAt === "string" ? raw.lunaTitleFallbackEnabledAt : null,
        }
      : undefined,
});
export const titleGenerationState = () => ({ ...titleGeneration.read() });
export const isTitleGenerationEnabled = () => titleGeneration.read().enabled;
export const isLunaTitleFallbackEnabled = () => titleGeneration.read().lunaTitleFallback;
export function titleGenerationEnabledAt() {
  const state = titleGeneration.read();
  if (!state.enabled || !state.enabledAt) return null;
  const at = Date.parse(state.enabledAt);
  return Number.isFinite(at) ? at : null;
}
export function lunaTitleFallbackEnabledAt() {
  const state = titleGeneration.read();
  if (!state.lunaTitleFallback || !state.lunaTitleFallbackEnabledAt) return null;
  const at = Date.parse(state.lunaTitleFallbackEnabledAt);
  return Number.isFinite(at) ? at : null;
}
/** @param {{ enabled?: boolean, lunaTitleFallback?: boolean }} options */
export function setTitleGenerationOptions({ enabled, lunaTitleFallback }) {
  return titleGeneration.update((current) => {
    const next = { ...current };
    // Each independent consent receives its own off -> on timestamp.
    if (enabled !== undefined) {
      if (enabled && !next.enabled) next.enabledAt = new Date().toISOString();
      next.enabled = enabled;
    }
    if (lunaTitleFallback !== undefined) {
      if (lunaTitleFallback && !next.lunaTitleFallback) {
        next.lunaTitleFallbackEnabledAt = new Date().toISOString();
      }
      next.lunaTitleFallback = lunaTitleFallback;
    }
    return next;
  }).then(() => undefined);
}
export const setTitleGenerationEnabled = (enabled) => setTitleGenerationOptions({ enabled });
export const setLunaTitleFallbackEnabled = (lunaTitleFallback) =>
  setTitleGenerationOptions({ lunaTitleFallback });

// ---- OpenAI account usage consent ----------------------------------------
const defaultOpenAIUsage = () => ({ enabled: false });
const openAIUsage = preferenceFile("web-ui-openai-usage.json", {
  fallback: defaultOpenAIUsage,
  revive: (raw) => (raw && typeof raw === "object" ? { enabled: raw.enabled === true } : undefined),
});
export const openAIUsageState = () => ({ ...openAIUsage.read() });
export const isOpenAIUsageEnabled = () => openAIUsage.read().enabled;
export function setOpenAIUsageEnabled(enabled) {
  return openAIUsage.update(() => ({ enabled })).then(() => undefined);
}

// ---- deep search budget ---------------------------------------------------
const defaultFullSearch = () => ({ enabled: false });
const fullSearch = preferenceFile("web-ui-full-search.json", {
  fallback: defaultFullSearch,
  revive: (raw) => (raw && typeof raw === "object" ? { enabled: raw.enabled === true } : undefined),
});
export const fullSearchState = () => ({ ...fullSearch.read() });
export const isFullSearchEnabled = () => fullSearch.read().enabled;
export function setFullSearchEnabled(enabled) {
  return fullSearch.update(() => ({ enabled })).then(() => undefined);
}

// ---- recent working directories ------------------------------------------
const RECENT_CWDS_MAX = 12;
const recentCwds = preferenceFile("web-ui-recent-cwds.json", {
  fallback: () => [],
  revive: (raw) =>
    Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string").slice(0, RECENT_CWDS_MAX) : undefined,
});
export function rememberCwd(dir) {
  if (!dir) return Promise.resolve();
  return recentCwds.update((current) => [dir, ...current.filter((entry) => entry !== dir)].slice(0, RECENT_CWDS_MAX))
    .then(() => undefined);
}
export const recentCwdList = () => [...recentCwds.read()];
export function forgetCwd(dir) {
  return recentCwds.update((current) => current.filter((entry) => entry !== dir)).then(() => undefined);
}

// Load each independently persisted preference once during server startup.
export async function loadPreferences() {
  await Promise.all([
    agentBootstrap.load(),
    archiving.load(),
    titleGeneration.load(),
    openAIUsage.load(),
    fullSearch.load(),
    recentCwds.load(),
  ]);
}

// ---- pi settings ----------------------------------------------------------
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SETTINGS_DOC = path.join(
  PROJECT_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "docs",
  "settings.md",
);
let schemaCache = null;
export async function settingsSchema() {
  if (schemaCache) return schemaCache;
  let markdown = "";
  try {
    markdown = await readFile(SETTINGS_DOC, "utf8");
  } catch {
    return (schemaCache = []);
  }
  const sections = [];
  let section = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = { name: heading[1], items: [] };
      sections.push(section);
      continue;
    }
    const row = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!row || !section) continue;
    const [, key, rawType, rawDefault, description] = row;
    if (key === "Setting") continue;
    const type = rawType.toLowerCase().trim();
    const options = [...description.matchAll(/`"([^"`]+)"`/g)].map((match) => match[1]);
    section.items.push({
      key,
      type,
      default: rawDefault.replace(/`/g, "").trim(),
      description: description.replace(/`/g, ""),
      options: [...new Set(options)],
      editable: ["boolean", "number", "string"].includes(type),
    });
  }
  schemaCache = sections.filter((candidate) => candidate.items.length);
  return schemaCache;
}

export const getPath = (object, key) => key.split(".").reduce((owner, part) => (owner == null ? undefined : owner[part]), object);
export function setPath(object, key, value) {
  const parts = key.split(".");
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null) current[part] = {};
    current = current[part];
  }
  const last = parts.at(-1);
  if (value === null) {
    delete current[last];
    for (let index = parts.length - 2; index >= 0; index--) {
      const parentKey = parts.slice(0, index + 1);
      const node = getPath(object, parentKey.join("."));
      if (node && typeof node === "object" && !Array.isArray(node) && Object.keys(node).length === 0) {
        const owner = index === 0 ? object : getPath(object, parts.slice(0, index).join("."));
        delete owner[parts[index]];
      }
    }
  } else {
    current[last] = value;
  }
}
export async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}
const settingsStore = jsonFile(SETTINGS_PATH, { indent: 2, trailingNewline: true });
export function saveSettingsFile(settings) {
  return settingsStore.save(settings);
}
const mutateSettings = mutationQueue();
/** @param {(settings: Record<string, any>) => void} update */
export function updateSettingsFile(update) {
  return mutateSettings(() => withFileLock(SETTINGS_PATH, async () => {
    const settings = await settingsStore.loadStrict().then((value) => value ?? {});
    update(settings);
    await saveSettingsFile(settings);
    return settings;
  }));
}

// ---- secret redaction -----------------------------------------------------
const SENSITIVE_KEY_RE = /key|token|secret|password|cookie|authorization|bearer/i;
const REDACTED_PLACEHOLDER = "\u00abredacted\u00bb";
export function redactSecrets(value, keyName = "") {
  if (typeof value === "string") {
    return SENSITIVE_KEY_RE.test(keyName) ? REDACTED_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, keyName));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = redactSecrets(item, key);
    return output;
  }
  return value;
}
