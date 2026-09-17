/**
 * api-settings.mjs — the endpoints behind the settings and analytics screens:
 * pi's own configuration, this UI's own switches (chat archiving, LAN access),
 * the usage credentials, and the cost history.
 *
 * Unlike api-chat.mjs, almost nothing here is scoped to a chat: these are
 * machine-wide answers, which is exactly why they must not be mixed with the
 * per-context ones. `/api/config` is the exception that proves it — it reports
 * the live session too, so it takes the tab's key like a chat endpoint does.
 */
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRODUCT_ID } from "./product.mjs";
import { openTextFile, platformCapabilities } from "./platform.mjs";
import { provesSameOrigin } from "./access-control.mjs";
import { jsonBody, send, sendError } from "./http.mjs";
import {
  AGENT_DIR,
  SETTINGS_PATH,
  agentBootstrapState,
  agentJsonFile,
  archiveStaleChats,
  archivingState,
  fullSearchState,
  getPath,
  readSettingsFile,
  redactSecrets,
  saveSettingsFile,
  isOpenAIUsageEnabled,
  isTitleGenerationEnabled,
  openAIUsageState,
  setArchivingEnabled,
  setAgentBootstrapTools,
  setFullSearchEnabled,
  setOpenAIUsageEnabled,
  setPath,
  setLunaTitleFallbackEnabled,
  setTitleGenerationEnabled,
  settingsSchema,
  titleGenerationState,
} from "./session-store.mjs";
import { queueMissingTitles } from "./titles.mjs";
import {
  availableModels,
  broadcastGlobal,
  getModelRuntime,
  liveSessions,
  reloadContextBootstrap,
  reloadEmptyBootstrapContexts,
  sessionCommands,
  supportedThinkingLevels,
  useContext,
} from "./contexts.mjs";
import { buildAnalytics } from "./analytics.mjs";
import {
  accessUrl,
  lanAccessEnabled,
  networkStatus,
  regenerateAccessToken,
  setLanAccess,
} from "./network.mjs";
import {
  fetchAllUsage,
  usageConfigStatus,
  fetchAnthropicUsage,
  fetchKimiUsage,
  saveUsageConfig,
  clearUsageConfig,
} from "./usage-tracker.mjs";
import {
  AgentBootstrapError,
  agentBootstrapFiles,
  deleteAgentBootstrapFile,
  effectiveAgentPrompt,
  resetAgentBootstrapFile,
  resolveAgentBootstrapFile,
  saveAgentBootstrapFile,
} from "./agent-bootstrap.mjs";

function sendBootstrapError(res, error) {
  if (!(error instanceof AgentBootstrapError) && error?.code !== "agent_busy") throw error;
  return sendError(res, error.status ?? 400, error.code ?? "agent_bootstrap_error", error.message);
}

async function bootstrapPayload(ctx) {
  const { session, cwd } = ctx;
  const configuredTools = agentBootstrapState().tools;
  const active = new Set(session.getActiveToolNames?.() ?? []);
  return {
    cwd,
    effectivePrompt: effectiveAgentPrompt(session),
    files: await agentBootstrapFiles(session, cwd),
    toolsMode: configuredTools === null ? "pi-default" : "custom",
    tools: (session.getAllTools?.() ?? []).map((tool) => ({
      name: tool.name,
      description: (tool.description ?? "").split("\n")[0].slice(0, 160),
      source: tool.sourceInfo?.source ?? "unknown",
      active: active.has(tool.name),
      selected: configuredTools === null ? active.has(tool.name) : configuredTools.includes(tool.name),
    })),
    commands: await sessionCommands(ctx),
  };
}

export async function handleGetAgentBootstrap({ res, sessionKey }) {
  return send(res, 200, await bootstrapPayload(await useContext(sessionKey)));
}

export async function handleSaveAgentBootstrapFile({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { id, content } = await jsonBody(req);
  try {
    await saveAgentBootstrapFile(ctx.session, ctx.cwd, id, content);
    await reloadEmptyBootstrapContexts();
    return send(res, 200, { ok: true, bootstrap: await bootstrapPayload(ctx) });
  } catch (error) {
    return sendBootstrapError(res, error);
  }
}

export async function handleDeleteAgentBootstrapFile({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { id } = await jsonBody(req);
  try {
    await deleteAgentBootstrapFile(ctx.session, ctx.cwd, id);
    await reloadEmptyBootstrapContexts();
    return send(res, 200, { ok: true, bootstrap: await bootstrapPayload(ctx) });
  } catch (error) {
    return sendBootstrapError(res, error);
  }
}

export async function handleResetAgentBootstrapFile({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { id } = await jsonBody(req);
  try {
    const result = await resetAgentBootstrapFile(ctx.session, ctx.cwd, id);
    await reloadEmptyBootstrapContexts();
    return send(res, 200, { ok: true, restored: result.restored, bootstrap: await bootstrapPayload(ctx) });
  } catch (error) {
    return sendBootstrapError(res, error);
  }
}

export async function handleOpenAgentBootstrapFile({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { id } = await jsonBody(req);
  try {
    const resource = await resolveAgentBootstrapFile(ctx.session, ctx.cwd, id);
    if (!resource.exists) return sendError(res, 404, "resource_not_found", "resource file does not exist");
    const opened = await openTextFile(resource.path);
    if (!opened.ok) return sendError(res, 501, "text_editor_unavailable", "opening a text editor is not available on this system");
    return send(res, 200, { ok: true });
  } catch (error) {
    return sendBootstrapError(res, error);
  }
}

export async function handleSetAgentBootstrapTools({ req, res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { tools } = await jsonBody(req);
  if (tools !== null && (!Array.isArray(tools) || tools.some((name) => typeof name !== "string"))) {
    return sendError(res, 400, "invalid_tools", "tools must be an array of names or null");
  }
  const clean = tools === null ? null : [...new Set(tools.map((name) => name.trim()).filter(Boolean))];
  if (clean && clean.length > 128) return sendError(res, 400, "invalid_tools", "too many tools");
  const known = new Set(ctx.session.getAllTools?.().map((tool) => tool.name) ?? []);
  const unknown = clean?.find((name) => !known.has(name));
  if (unknown) return sendError(res, 400, "unknown_tool", `unknown tool: ${unknown}`);
  await setAgentBootstrapTools(clean);
  await reloadEmptyBootstrapContexts();
  return send(res, 200, { ok: true, bootstrap: await bootstrapPayload(ctx) });
}

export async function handleReloadAgentBootstrap({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  try {
    await reloadContextBootstrap(ctx);
    return send(res, 200, { ok: true, bootstrap: await bootstrapPayload(ctx) });
  } catch (error) {
    return sendBootstrapError(res, error);
  }
}

export async function handleGetSettings({ res }) {
  const [schema, current] = await Promise.all([settingsSchema(), readSettingsFile()]);
  // real runtime choices beat the examples parsed from the docs
  const authed = await availableModels();
  const providerOptions = [...new Set(authed.map((m) => m.provider))].sort();
  const allModels = (await getModelRuntime().getModels?.()) ?? [];
  const prov = getPath(current, "defaultProvider");
  const modelOptions = [
    ...new Set((prov ? allModels.filter((m) => m.provider === prov) : authed).map((m) => m.id)),
  ].sort();
  const runtimeOptions = {
    defaultProvider: providerOptions,
    defaultModel: modelOptions,
    theme: ["dark", "light"],
  };
  const sections = schema.map((s) => ({
    name: s.name,
    items: s.items.map((it) => {
      const value = getPath(current, it.key);
      const options = runtimeOptions[it.key]?.length ? runtimeOptions[it.key] : it.options;
      return {
        ...it,
        options,
        value: value === undefined ? null : value,
        set: value !== undefined,
      };
    }),
  }));
  // anything present in settings.json but not documented
  const known = new Set(schema.flatMap((s) => s.items.map((i) => i.key)));
  const extras = Object.keys(current).filter((k) => !known.has(k) && !known.has(k + ".enabled"));
  return send(res, 200, {
    path: SETTINGS_PATH,
    agentDir: AGENT_DIR,
    sections,
    raw: current,
    extras,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  });
}

export async function handleUpdateSetting({ req, res }) {
  const { key, value } = await jsonBody(req);
  if (typeof key !== "string" || !key) return send(res, 400, { error: "missing key" });
  const schema = await settingsSchema();
  const item = schema.flatMap((s) => s.items).find((i) => i.key === key);
  if (!item) return send(res, 400, { error: `unknown setting: ${key}` });
  let v = value;
  if (v === null || v === "") v = null;
  else if (item.type === "boolean") v = Boolean(v);
  else if (item.type === "number") {
    v = Number(v);
    if (!Number.isFinite(v)) return send(res, 400, { error: "invalid numeric value" });
  } else if (item.type === "string") {
    v = String(v);
  } else if (item.type.endsWith("[]")) {
    // list settings (e.g. `enabledModels`): keep them as clean string arrays.
    // An empty array is meaningful — for `enabledModels` it means "all models".
    if (!Array.isArray(v)) return send(res, 400, { error: `${key} expects an array` });
    v = v.map((entry) => String(entry).trim()).filter(Boolean);
  }
  const current = await readSettingsFile();
  setPath(current, key, v);
  await saveSettingsFile(current);
  // apply live where the running sessions support it
  let applied = false;
  try {
    if (key === "defaultThinkingLevel" && v) {
      for (const session of liveSessions()) session.setThinkingLevel(v);
      applied = true;
    }
    // the model picker reads the allow-list from the live settings manager,
    // so pushing it there makes the change visible without a restart
    if (key === "enabledModels") {
      for (const session of liveSessions()) {
        session.settingsManager?.setEnabledModels?.(v ?? []);
      }
      applied = true;
    }
  } catch (err) {
    console.warn(`${PRODUCT_ID}: applying the setting "${key}" to the live sessions failed: ${err?.message ?? err}`);
  }
  return send(res, 200, {
    ok: true,
    key,
    value: v,
    // most settings are read by pi at startup, so the CLI/session must restart
    restart: !applied,
  });
}

/**
 * @typedef {object} ConfigProvider one configured (or configurable) provider.
 * @property {string} id
 * @property {boolean} configured whether credentials for it were found.
 * @property {string} detail how it authenticates, or why the check failed.
 * @property {boolean} oauth whether it authenticates through OAuth.
 * @property {number} models how many models it exposes.
 */

/**
 * @typedef {object} ConfigModel a model as the settings screen lists it.
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {boolean} reasoning
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {number|null} input cost per input token, when known.
 * @property {number|null} output cost per output token, when known.
 * @property {string[]} thinkingLevels
 * @property {boolean} authed whether its provider has credentials.
 */

/**
 * @typedef {object} ConfigPayload body of `GET /api/config`: the settings
 *   screen in one shot. Secrets are redacted before they reach it.
 * @property {Awaited<ReturnType<typeof platformCapabilities>>} platform
 * @property {string} cwd
 * @property {string|null} sessionFile
 * @property {string|null} sessionId
 * @property {{provider: string, id: string, name: string}|null} current
 * @property {string|null} thinkingLevel
 * @property {string[]} thinkingLevels
 * @property {ConfigProvider[]} providers
 * @property {ConfigModel[]} models
 * @property {{name: string, description: string, active: boolean}[]} tools
 * @property {Record<string, any>|null} options pi's own settings, as the live
 *   settings manager reports them; null when the session has none.
 * @property {{agentDir: string, settings: string, models: string, auth: string}} paths
 * @property {unknown} rawSettings settings.json, redacted.
 * @property {unknown} rawModels models.json, redacted.
 * @property {string} node version of the node process serving this.
 */

export async function handleGetConfig({ res, sessionKey }) {
  const ctx = await useContext(sessionKey);
  const { session, cwd } = ctx;
  const settings = await agentJsonFile("settings.json").load();
  const modelsJson = await agentJsonFile("models.json").load();
  const modelRuntime = getModelRuntime();
  const allModels = (await modelRuntime.getModels?.()) ?? [];
  // One pass over the models gives both the provider ids (Map keys keep first-seen
  // order, like the Set did) and how many models each of them exposes.
  const modelCountByProvider = new Map();
  for (const m of allModels) {
    modelCountByProvider.set(m.provider, (modelCountByProvider.get(m.provider) ?? 0) + 1);
  }
  const providers = await Promise.all(
    [...modelCountByProvider.keys()].map(async (id) => {
      let configured = false;
      let detail = "";
      try {
        const status = await modelRuntime.checkAuth(id);
        configured = Boolean(status?.configured ?? status);
        detail = status?.method ?? status?.source ?? "";
      } catch (e) {
        detail = String(e?.message ?? e);
      }
      return {
        id,
        configured,
        detail,
        oauth: modelRuntime.isUsingOAuth?.(id) ?? false,
        models: modelCountByProvider.get(id),
      };
    }),
  );
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const activeToolNames = new Set(session.getActiveToolNames?.() ?? []);
  const sm = session.settingsManager;
  const sessionMgr = session.sessionManager;
  /** @type {ConfigPayload} */
  const payload = {
    platform: await platformCapabilities(),
    cwd,
    sessionFile: sessionMgr?.getSessionFile?.() ?? null,
    sessionId: sessionMgr?.getSessionId?.() ?? null,
    current: session.model
      ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
      : null,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: supportedThinkingLevels(session.model),
    providers,
    models: allModels.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: Boolean(m.reasoning),
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      input: m.cost?.input ?? null,
      output: m.cost?.output ?? null,
      thinkingLevels: supportedThinkingLevels(m),
      authed: providerById.get(m.provider)?.configured ?? false,
    })),
    tools: (session.getAllTools?.() ?? []).map((t) => ({
      name: t.name,
      description: (t.description ?? "").split("\n")[0].slice(0, 160),
      active: activeToolNames.has(t.name),
    })),
    options: sm
      ? {
          defaultProvider: sm.getDefaultProvider?.() ?? null,
          defaultModel: sm.getDefaultModel?.() ?? null,
          defaultThinkingLevel: sm.getDefaultThinkingLevel?.() ?? null,
          enabledModels: sm.getEnabledModels?.() ?? [],
          theme: sm.getTheme?.() ?? null,
          steeringMode: sm.getSteeringMode?.() ?? null,
          followUpMode: sm.getFollowUpMode?.() ?? null,
          compactionEnabled: sm.getCompactionEnabled?.() ?? null,
          compactionReserveTokens: sm.getCompactionReserveTokens?.() ?? null,
          retryEnabled: sm.getRetryEnabled?.() ?? null,
          hideThinkingBlock: sm.getHideThinkingBlock?.() ?? null,
          sessionDir: sm.getSessionDir?.() ?? null,
          packages: sm.getPackages?.() ?? [],
          extensionPaths: sm.getExtensionPaths?.() ?? [],
          skillPaths: sm.getSkillPaths?.() ?? [],
        }
      : null,
    paths: {
      agentDir: AGENT_DIR,
      settings: path.join(AGENT_DIR, "settings.json"),
      models: path.join(AGENT_DIR, "models.json"),
      auth: path.join(AGENT_DIR, "auth.json"),
    },
    rawSettings: redactSecrets(settings),
    rawModels: redactSecrets(modelsJson),
    node: process.version,
  };
  return send(res, 200, payload);
}

export async function handleGetArchiving({ res }) {
  return send(res, 200, archivingState());
}

export async function handleSetArchiving({ req, res }) {
  const { enabled } = await jsonBody(req);
  if (typeof enabled !== "boolean") return send(res, 400, { error: "enabled must be a boolean" });
  await setArchivingEnabled(enabled);
  broadcastGlobal({ kind: "sessions" });
  return send(res, 200, archivingState());
}

// The sweep is its own route: it runs whatever the toggle says, and used to be
// silently dropped when a caller sent it together with `enabled`.
export async function handleSweepArchive({ res }) {
  const archived = await archiveStaleChats();
  broadcastGlobal({ kind: "sessions" });
  return send(res, 200, { ...archivingState(), archived });
}

export async function handleGetTitleGeneration({ res }) {
  return send(res, 200, titleGenerationState());
}

export async function handleSetTitleGeneration({ req, res }) {
  const body = await jsonBody(req);
  const hasPrimary = Object.hasOwn(body, "enabled");
  const hasLuna = Object.hasOwn(body, "lunaTitleFallback");
  if (!hasPrimary && !hasLuna) {
    return send(res, 400, { error: "enabled or lunaTitleFallback must be a boolean" });
  }
  if (hasPrimary && typeof body.enabled !== "boolean") {
    return send(res, 400, { error: "enabled must be a boolean" });
  }
  if (hasLuna && typeof body.lunaTitleFallback !== "boolean") {
    return send(res, 400, { error: "lunaTitleFallback must be a boolean" });
  }
  if (hasPrimary) await setTitleGenerationEnabled(body.enabled);
  if (hasLuna) await setLunaTitleFallbackEnabled(body.lunaTitleFallback);
  return send(res, 200, titleGenerationState());
}

// The retroactive sweep, like /api/archiving/sweep: its own route because it is
// its own decision. Switching the feature on covers the chats to come; this is
// the click that covers the ones already there, and it is the only thing that
// summarizes them.
export async function handleBackfillTitles({ res }) {
  // Backfill remains an explicit second consent, but it cannot bypass the
  // primary title-generation switch. Luna follows its own independent toggle.
  const queued = isTitleGenerationEnabled()
    ? await queueMissingTitles(await SessionManager.listAll())
    : 0;
  return send(res, 200, { ...titleGenerationState(), queued });
}

// The cap on the deep search is the default; this is the switch that lifts it.
// Its own route, like the other two toggles: one file, one decision.
export async function handleGetFullSearch({ res }) {
  return send(res, 200, fullSearchState());
}

export async function handleSetFullSearch({ req, res }) {
  const { enabled } = await jsonBody(req);
  if (typeof enabled !== "boolean") return send(res, 400, { error: "enabled must be a boolean" });
  await setFullSearchEnabled(enabled);
  return send(res, 200, fullSearchState());
}

export async function handleGetNetwork({ res }) {
  return send(res, 200, networkStatus());
}

export async function handleUpdateNetwork({ req, res }) {
  const { lanAccess, regenerate, reveal } = await jsonBody(req);
  if (reveal === true) {
    const url = accessUrl();
    if (!url) return send(res, 400, { error: "LAN access is off" });
    console.log(`${PRODUCT_ID}: LAN access URL revealed from settings`);
    return send(res, 200, { url });
  }
  if (typeof lanAccess === "boolean") {
    await setLanAccess(lanAccess);
  } else if (regenerate === true) {
    if (!lanAccessEnabled()) return send(res, 400, { error: "LAN access is off" });
    await regenerateAccessToken();
  } else {
    return send(res, 400, { error: "nothing to change" });
  }
  return send(res, 200, networkStatus());
}

export async function handleGetUsage({ req, res, url }) {
  // `force=1` bypasses the cache and spends the user's own credentials on
  // claude.ai / kimi.com, so any page could loop it into a rate limit. The
  // guard exempts safe methods by design: this single handler asks for the
  // same-origin proof itself, and a request without it silently degrades to
  // the cached answer rather than failing the UI with a 403.
  const force = url.searchParams.get("force") === "1" && provesSameOrigin(req, req.headers.host);
  return send(res, 200, await fetchAllUsage({
    force,
    openAIEnabled: isOpenAIUsageEnabled(),
    modelRuntime: getModelRuntime(),
  }));
}

async function publicUsageConfigStatus() {
  const manual = await usageConfigStatus();
  return {
    ...manual,
    openai: {
      ...openAIUsageState(),
      configured: getModelRuntime()?.isUsingOAuth?.("openai-codex") === true,
    },
  };
}

export async function handleGetUsageConfig({ res }) {
  return send(res, 200, await publicUsageConfigStatus());
}

export async function handleSaveUsageConfig({ req, res }) {
  const { provider, ...values } = await jsonBody(req);
  if (provider === "openai-codex") {
    if (typeof values.enabled !== "boolean") {
      return sendError(res, 400, "invalid_enabled", "enabled must be a boolean");
    }
    await setOpenAIUsageEnabled(values.enabled);
  } else {
    // No catch on purpose: a rejected paste throws with `status = 400` and is
    // echoed back, while an I/O failure reaches the generic handler as a 500.
    // Turning both into 400 told the user to fix a paste that was fine.
    await saveUsageConfig(provider, values);
  }
  return send(res, 200, { ok: true, status: await publicUsageConfigStatus() });
}

export async function handleTestUsageCredentials({ req, res }) {
  const { provider } = await jsonBody(req);
  if (!["anthropic", "kimi"].includes(provider)) {
    return sendError(res, 400, "unknown_provider", "unknown provider");
  }
  const data = provider === "anthropic"
    ? await fetchAnthropicUsage({ force: true })
    : await fetchKimiUsage({ force: true });
  if (!data.configured) return sendError(res, 400, "credentials_missing", "credentials not saved");
  // 400 and not 502: this endpoint exists to judge the credentials the user
  // pasted, so a provider that refuses them is a verdict on the request, not
  // an outage of some upstream of ours.
  if (data.error) return sendError(res, 400, "usage_check_failed", data.error);
  return send(res, 200, { ok: true, data });
}

export async function handleDeleteUsageCredentials({ res, params }) {
  // see POST above: validation answers 400, a failed write answers 500.
  await clearUsageConfig(params.provider);
  return send(res, 200, { ok: true, status: await publicUsageConfigStatus() });
}

export async function handleGetAnalytics({ res }) {
  const data = await buildAnalytics();
  return send(res, 200, data);
}
