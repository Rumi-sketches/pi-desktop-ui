/**
 * pi-desktop-ui — minimal local web UI on top of the pi SDK.
 *
 * Multi-chat: the server keeps one agent *context* per open chat, keyed by its
 * session file. Every tab tells the server which chat it is on (query `?s=<key>`
 * or header `x-pi-session`); events are delivered only to the tabs attached to
 * that context. Leaving a chat never disposes it, so a run keeps going in the
 * background and you find the result when you come back.
 *
 * Endpoints: see docs/api.md — request and response shapes, error statuses and
 * which routes are scoped to the tab's chat. It is not prose anyone has to
 * trust: scripts/verify.mjs fails when it and the route table below disagree.
 *
 * The code is split by concern, not by endpoint: this file is boot, route table
 * and wiring, and everything it wires lives next to it —
 *   `http.mjs`          request/response helpers, static assets, the router
 *   `session-store.mjs` what is persisted under ~/.pi/agent
 *   `contexts.mjs`      one agent context per open chat, and its event stream
 *   `analytics.mjs`     cost/token history built from the session log
 *   `network.mjs`       the listening address and the LAN access token
 *   `api-chat.mjs`      the endpoints of a chat
 *   `api-settings.mjs`  the endpoints of the settings and analytics screens
 *   `api-terminals.mjs` the endpoints of the integrated PTY terminals (loopback only)
 *   `lifecycle.mjs`     stopping: signals, /api/shutdown, /api/restart
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_ID } from "./product.mjs";
import { classifyRequest, isLoopbackPeer } from "./access-control.mjs";
import { createRouter, PAGE_ROUTES, send, sendMethodNotAllowed, VENDOR_ROUTE } from "./http.mjs";
import { loadPersistedState, runFirstRunArchiving } from "./session-store.mjs";
import { openBootContext, getBootContext, startAgentRuntime, startIdleSweep } from "./contexts.mjs";
import {
  DEFAULT_PORT,
  completeAccessHandshake,
  hasAccessToken,
  lanAccessEnabled,
  loadNetwork,
  localUrl,
  resolveHost,
  serverHost,
  serverPort,
  setServerAddress,
  warnRemoteDeny,
} from "./network.mjs";
import {
  handleRestart,
  handleShutdown,
  installProcessHandlers,
  isServerRunning,
  setListeningServer,
  setRestartHandler,
  stopServer,
  workInProgress,
} from "./lifecycle.mjs";
import {
  handleAbort,
  handleActivateRecentSession,
  handleActivateSession,
  handleCreateSession,
  handleDeleteQueuedPrompt,
  handleEvents,
  handleForgetRecentCwd,
  handleForkSession,
  handleGetCommands,
  handleGetFileDiff,
  handleGetFiles,
  handleGetGitStatus,
  handleGetHistory,
  handleGetModels,
  handleGetRecentCwds,
  handleGetState,
  handleListSessions,
  handleOpenExplorer,
  handleOpenTerminal,
  handlePickFolder,
  handlePrompt,
  handleSearchMessages,
  handleSetCwd,
  handleSetFavorite,
  handleSetModel,
  handleSetSessionStatus,
  handleSetThinkingLevel,
  handleTypeCommand,
} from "./api-chat.mjs";
import {
  handleCreateTerminal,
  handleDeleteTerminal,
  handleListTerminals,
  handleOpenTerminalFolder,
  handleRestartTerminal,
  handleTerminalInput,
  handleTerminalResize,
  handleTerminalStream,
} from "./api-terminals.mjs";
import {
  handleBackfillTitles,
  handleDeleteAgentBootstrapFile,
  handleDeleteUsageCredentials,
  handleGetAgentBootstrap,
  handleGetAnalytics,
  handleGetArchiving,
  handleGetConfig,
  handleGetFullSearch,
  handleGetNetwork,
  handleGetSettings,
  handleGetTitleGeneration,
  handleGetUsage,
  handleGetUsageConfig,
  handleOpenAgentBootstrapFile,
  handleReloadAgentBootstrap,
  handleSaveAgentBootstrapFile,
  handleSaveUsageConfig,
  handleSetArchiving,
  handleSetAgentBootstrapTools,
  handleSetFullSearch,
  handleSetTitleGeneration,
  handleSweepArchive,
  handleTestUsageCredentials,
  handleUpdateNetwork,
  handleUpdateSetting,
} from "./api-settings.mjs";

// ---- route table -----------------------------------------------------------
// The single source of truth for what this server answers: [method, path,
// handler] triples. Adding a route here is the only way to add one, so no
// endpoint can silently accept every verb the way the old `if` cascade did.
const ROUTES = [
  // the page and its two assets (see PAGE_ROUTES in http.mjs)
  ...PAGE_ROUTES,
  ["GET", "/api/events", handleEvents],
  ["GET", "/api/state", handleGetState],
  ["GET", "/api/models", handleGetModels],
  ["GET", "/api/settings", handleGetSettings],
  ["POST", "/api/settings", handleUpdateSetting],
  ["GET", "/api/config", handleGetConfig],
  ["GET", "/api/agent-bootstrap", handleGetAgentBootstrap],
  ["PUT", "/api/agent-bootstrap/file", handleSaveAgentBootstrapFile],
  ["DELETE", "/api/agent-bootstrap/file", handleDeleteAgentBootstrapFile],
  ["POST", "/api/agent-bootstrap/file/open", handleOpenAgentBootstrapFile],
  ["PUT", "/api/agent-bootstrap/tools", handleSetAgentBootstrapTools],
  ["POST", "/api/agent-bootstrap/reload", handleReloadAgentBootstrap],
  ["GET", "/api/archiving", handleGetArchiving],
  ["PUT", "/api/archiving", handleSetArchiving],
  ["POST", "/api/archiving/sweep", handleSweepArchive],
  ["GET", "/api/title-generation", handleGetTitleGeneration],
  ["PUT", "/api/title-generation", handleSetTitleGeneration],
  ["POST", "/api/title-generation/backfill", handleBackfillTitles],
  ["GET", "/api/full-search", handleGetFullSearch],
  ["PUT", "/api/full-search", handleSetFullSearch],
  ["GET", "/api/network", handleGetNetwork],
  ["POST", "/api/network", handleUpdateNetwork],
  ["GET", "/api/usage", handleGetUsage],
  ["GET", "/api/usage/config", handleGetUsageConfig],
  ["POST", "/api/usage/config", handleSaveUsageConfig],
  ["POST", "/api/usage/test", handleTestUsageCredentials],
  ["POST", "/api/model", handleSetModel],
  ["POST", "/api/thinking", handleSetThinkingLevel],
  ["POST", "/api/cwd", handleSetCwd],
  ["GET", "/api/recent-cwds", handleGetRecentCwds],
  ["DELETE", "/api/recent-cwds", handleForgetRecentCwd],
  ["POST", "/api/open-explorer", handleOpenExplorer],
  ["POST", "/api/open-terminal", handleOpenTerminal],
  ["POST", "/api/type-command", handleTypeCommand],
  ["POST", "/api/favorites", handleSetFavorite],
  ["POST", "/api/status", handleSetSessionStatus],
  ["POST", "/api/pick-folder", handlePickFolder],
  ["GET", "/api/git", handleGetGitStatus],
  ["GET", "/api/analytics", handleGetAnalytics],
  ["GET", "/api/sessions", handleListSessions],
  ["GET", "/api/search", handleSearchMessages],
  ["POST", "/api/sessions", handleCreateSession],
  ["POST", "/api/sessions/activate", handleActivateRecentSession],
  ["GET", "/api/commands", handleGetCommands],
  ["GET", "/api/files", handleGetFiles],
  ["GET", "/api/files/diff", handleGetFileDiff],
  ["GET", "/api/history", handleGetHistory],
  ["POST", "/api/prompt", handlePrompt],
  ["POST", "/api/abort", handleAbort],
  // The terminals answer the local machine only, whatever LAN access says:
  // the guard lives in every handler of api-terminals.mjs.
  ["GET", "/api/terminals", handleListTerminals],
  ["POST", "/api/terminals", handleCreateTerminal],
  ["POST", "/api/shutdown", handleShutdown],
  ["POST", "/api/restart", handleRestart],
];

// Routes whose path carries data: a `:name` segment matches any single segment
// and reaches the handler in `rq.params`. Tried in order, after the exact table.
const PARAM_ROUTES = [
  ["POST", "/api/sessions/:id/activate", handleActivateSession],
  ["POST", "/api/sessions/:id/fork", handleForkSession],
  ["DELETE", "/api/queued-prompts/:id", handleDeleteQueuedPrompt],
  ["DELETE", "/api/usage/credentials/:provider", handleDeleteUsageCredentials],
  ["GET", "/api/terminals/:id/stream", handleTerminalStream],
  ["POST", "/api/terminals/:id/input", handleTerminalInput],
  ["POST", "/api/terminals/:id/resize", handleTerminalResize],
  ["POST", "/api/terminals/:id/open-folder", handleOpenTerminalFolder],
  ["POST", "/api/terminals/:id/restart", handleRestartTerminal],
  ["DELETE", "/api/terminals/:id", handleDeleteTerminal],
];

// Sub-tree routes, where the pathname is data for the handler instead of a key.
// Tried in order, only when no exact path and no pattern matches.
const PREFIX_ROUTES = [VENDOR_ROUTE];

const matchRoute = createRouter({ routes: ROUTES, paramRoutes: PARAM_ROUTES, prefixRoutes: PREFIX_ROUTES });

// ---- dispatch --------------------------------------------------------------
async function handleRequest(req, res) {
  const port = serverPort();
  // A request-target the URL parser refuses (`//`, a stray backslash, a bad
  // percent-escape) is a malformed request, not a bug: it must end in a 400.
  // Parsing outside the try below would throw straight through the 'request'
  // listener and take the whole process down — fatal here, where the server
  // shares its process with the desktop shell.
  const url = URL.parse(req.url, `http://localhost:${port}`);
  if (!url) return send(res, 400, { error: "malformed request target" });
  const verdict = classifyRequest(
    {
      method: req.method,
      headers: req.headers,
      searchParams: url.searchParams,
      remoteAddress: req.socket.remoteAddress,
    },
    { port, lanAccess: lanAccessEnabled(), matchesToken: hasAccessToken },
  );
  if (verdict === "handshake") return completeAccessHandshake(res, url);
  if (verdict !== "allow") {
    if (!isLoopbackPeer(req.socket.remoteAddress)) warnRemoteDeny(req);
    return send(res, 403, { error: "forbidden origin" });
  }
  // which chat this tab is talking about (null → most recent one)
  const sessionKey = url.searchParams.get("s") || req.headers["x-pi-session"] || null;
  try {
    const route = matchRoute(url.pathname, req.method);
    if (!route) return send(res, 404, { error: "not found" });
    if ("allow" in route) return sendMethodNotAllowed(res, route.allow);
    // Everything a handler may need about the call, in one bag (`params` holds
    // the `:name` segments of a pattern route, empty for every other one): each
    // handler destructures out the fields it actually uses.
    const rq = { req, res, url, sessionKey, params: route.params ?? {} };
    // `return await`, not `return`: inside a try, a bare returned promise
    // escapes the catch below.
    return await route.handler(rq);
  } catch (err) {
    // Full error (stack, absolute paths, username) goes to the console only.
    console.error(`${PRODUCT_ID}: request error:`, err);
    const status = err?.status ?? 500;
    // Internal messages leak local paths and the username: never echo them back.
    const payload = status < 500 ? { error: String(err?.message ?? err) } : { error: "internal error" };
    if (!res.headersSent) send(res, status, payload);
  }
}

// ---- boot ------------------------------------------------------------------
// Resolves with the bound address, rejects on the first listen error (a busy
// port included: nothing races us for it anymore, so a failure is a failure
// and the caller gets to say it in its own words).
function listen(httpServer, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      httpServer.off("error", onError);
      reject(err);
    };
    httpServer.on("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      resolve(httpServer.address());
    });
  });
}

/**
 * Boot the server: persisted state, agent runtime, HTTP listener. Nothing here
 * runs on a bare `import`, so the module can be embedded (Electron, tests).
 *
 * @param {object} [options]
 * @param {number|string} [options.port] listening port; `0` picks an ephemeral one
 * @param {string|null} [options.host] bind address; defaults to loopback (see resolveHost)
 * @param {() => void} [options.onRestart] takes over POST /api/restart, so a host (Electron)
 *   can restart the server in place; without it the CLI path just shuts down
 * @returns {Promise<{url: string, port: number, host: string, stop: () => Promise<void>,
 *   activity: () => import("./lifecycle.mjs").WorkInProgress}>}
 */
export async function startServer(options = {}) {
  if (isServerRunning()) throw new Error("the server is already running in this process");
  setRestartHandler(options.onRestart);

  await Promise.all([loadPersistedState(), loadNetwork()]);
  await runFirstRunArchiving();

  const requestedPort = Number(options.port ?? DEFAULT_PORT);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`invalid port: ${options.port}`);
  }
  // resolveHost refuses a non-loopback bind while LAN access is off, so it runs
  // before anything is started, not after.
  const host = resolveHost(options.host ?? null);
  setServerAddress(requestedPort, host);

  try {
    await startAgentRuntime();
    startIdleSweep();
    await openBootContext();
    const httpServer = http.createServer(handleRequest);
    setListeningServer(httpServer);
    const address = await listen(httpServer, requestedPort, host);
    // With `port: 0` the real port is only known now, and the request guard
    // compares it against the Host header: fix it up before anyone connects.
    setServerAddress(address.port, host);
    // The boot listener is gone once bound: a later error must not go unhandled.
    httpServer.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
      console.error(`${PRODUCT_ID}: server error (${err?.code ?? err?.message ?? err})`);
    });
  } catch (err) {
    await stopServer();
    throw err;
  }

  // `activity` is what a host needs to ask before it stops us: how much work
  // stopping would interrupt. Handed over as a function, not as a number — the
  // answer is only true at the moment it is asked.
  return { url: localUrl(), port: serverPort(), host, stop: stopServer, activity: workInProgress };
}


/**
 * Start the server as *the* job of this process: signals, safety net and the
 * boot banner included. Used by `node server.mjs` and by the launcher in
 * bin/, so the two share one behavior instead of two copies of it.
 *
 * @param {Parameters<typeof startServer>[0]} [options]
 * @returns {ReturnType<typeof startServer>}
 */
export async function runCli(options = {}) {
  installProcessHandlers();
  const started = await startServer({
    port: options.port ?? process.env.PORT ?? DEFAULT_PORT,
    host: options.host ?? process.env.HOST ?? null,
  });
  const bootCtx = getBootContext();
  const bootModel = bootCtx.session.model;
  console.log(`${PRODUCT_ID} ready → http://${serverHost()}:${serverPort()}`);
  console.log(`cwd: ${bootCtx.cwd}`);
  console.log(`model: ${bootModel ? `${bootModel.provider}/${bootModel.id}` : "none configured"}`);
  return started;
}

const isCliEntry =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntry) {
  runCli().catch((err) => {
    console.error(`${PRODUCT_ID}: ${err?.message ?? err}`);
    process.exit(1);
  });
}
