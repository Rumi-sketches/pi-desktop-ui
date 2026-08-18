/**
 * lifecycle.mjs — how this server stops.
 *
 * Starting is startServer()'s job (server.mjs); giving everything back is this
 * module's. That is the asymmetry it exists for: a stop has to happen from a
 * request handler (`POST /api/shutdown`, `POST /api/restart`), from a signal,
 * or from an embedder calling stop() — and all three must release exactly the
 * same things, exactly once.
 *
 * Restarting is *not* this module's job. The desktop shell is the primary way
 * this server runs, and there the host restarts it in place (see the
 * `onRestart` handler below). From the CLI the server no longer clones itself:
 * it stops cleanly and says what to type. The self-spawning path it used to
 * take — detached child, `server.log`, two processes fighting over the port —
 * was a lot of machinery for the secondary way of running the app.
 */
import { PRODUCT_ID } from "./product.mjs";
import { jsonBody, send, sendError } from "./http.mjs";
import { disposeAllContexts } from "./contexts.mjs";
import { closeAllTerminals, countLiveTerminals } from "./terminals.mjs";

// The listening socket, handed over by startServer() once it is bound.
let server = null;
export const isServerRunning = () => server !== null;
export function setListeningServer(httpServer) {
  server = httpServer;
}

// Set by an embedder through startServer({ onRestart }); null on the CLI path,
// where /api/restart degrades to a clean shutdown instead.
let restartHandler = null;
export function setRestartHandler(handler) {
  restartHandler = typeof handler === "function" ? handler : null;
}

// Run `fn` once the response is off this process' hands. `close` fires exactly
// once, after `finish` or on an aborted request, so the callback can neither
// run twice nor be lost. Nothing may throw out of here: the response is already
// sent and an uncaught error would take every open chat down with it.
function afterResponse(res, fn) {
  res.once("close", () => {
    try {
      fn();
    } catch (err) {
      console.error(`${PRODUCT_ID}: the restart handler failed (${err?.message ?? err})`);
    }
  });
}

// Everything this process owns and must give back: the idle sweep, the agent
// sessions (each one a child process), the integrated terminals (each one a
// PowerShell), the SSE sockets and the port itself.
// Idempotent: calling it twice, or before a successful start, is a no-op.
export async function stopServer() {
  restartHandler = null;
  await disposeAllContexts();
  // The terminals die with the server, exactly like the agent sessions above:
  // without this a quit leaves one orphan powershell.exe per open terminal,
  // and on Windows their conout pipes can keep the event loop alive.
  closeAllTerminals();
  const listening = server;
  server = null;
  if (!listening) return;
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    listening.close(() => resolve());
    // Without this, idle keep-alive sockets hold the port open for their whole
    // timeout and the caller cannot rebind it.
    listening.closeAllConnections();
  }));
}

// CLI path only: release everything, then leave the process. Embedders call
// stop() and stay alive.
// how long to wait for a clean close before killing the process anyway
const FORCED_EXIT_MS = 1500;
let stopping = false;
export async function shutdown(reason = "signal") {
  if (stopping) return;
  stopping = true;
  console.log(`${PRODUCT_ID}: shutting down (${reason})…`);
  // hard exit if something keeps the loop alive
  setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
  await stopServer();
  process.exit(0);
}

// What the CLI user has to do by hand, now that nothing restarts for them.
const CLI_RESTART_HINT = `restart ${PRODUCT_ID} to apply`;

/** @param {number} count */
const terminalsWording = (count) => (count === 1 ? "1 terminal" : `${count} terminals`);

export async function handleShutdown({ res }) {
  send(res, 200, { ok: true, stopping: true });
  return shutdown("api");
}

export async function handleRestart({ req, res }) {
  // A restart takes every integrated terminal down with it — whatever is
  // running in them, a build, an ssh session, an agent halfway through a task.
  // The count comes from the registry, the only place that knows which
  // processes are still alive, and never from the page. `force` is the caller
  // saying the user has seen the warning and chose to go ahead.
  const { force } = await jsonBody(req);
  const live = countLiveTerminals();
  if (live > 0 && force !== true) {
    return sendError(
      res,
      409,
      "terminals_open",
      `${terminalsWording(live)} will be closed by the restart`,
      { terminals: live },
    );
  }
  // Embedded (Electron): this process is the app, not a disposable wrapper
  // around the server — replacing it would take the window down with it.
  // The host restarts the server in place instead, once this response has
  // left the socket (stopping the server closes the connection under it).
  if (restartHandler) {
    send(res, 200, { ok: true, restarting: true });
    return afterResponse(res, restartHandler);
  }
  // CLI: nothing will come back up on its own, so don't promise a restart.
  // The answer says the server is stopping and what to type to get it back.
  send(res, 200, { ok: true, stopping: true, restarting: false, message: CLI_RESTART_HINT });
  console.log(`${PRODUCT_ID}: ${CLI_RESTART_HINT}`);
  return shutdown("restart requested");
}

// An uncaught exception left the process in a state nobody can describe: some
// handler stopped halfway, holding whatever it was holding. Node's own docs
// are blunt about it — "it is not safe to resume normal operation after
// 'uncaughtException'" — and a server that keeps answering from there serves
// corrupted state instead of an error. So: say what happened, give back what
// can be given back *synchronously* (an async teardown would be racing the
// exit), and go. Coming back up is the host's job, not ours — the Electron app
// restarts the server in place, and from the CLI it is the user's call.
function crash(err) {
  console.error(`${PRODUCT_ID}: uncaught exception, exiting: ${err?.stack ?? err}`);
  // Best-effort and never fatal: we are already on the way out, and a throw in
  // here would swallow the exit below.
  try {
    const listening = server;
    server = null;
    if (listening) {
      // Cuts every open socket, the SSE streams included: without it the
      // browser sees a hung connection rather than a closed one.
      listening.closeAllConnections();
      listening.close();
    }
  } catch (e) {
    console.error(`${PRODUCT_ID}: cleanup after the uncaught exception failed (${e?.message ?? e})`);
  }
  process.exit(1);
}

// Signals and the crash handler, installed only by runCli(): an embedder owns
// its own process and must not have them hijacked by an import.
export function installProcessHandlers() {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => shutdown(sig));
  }
  process.on("uncaughtException", crash);
  // The rejection value is anything the code threw, not necessarily an Error.
  process.on("unhandledRejection", (reason) => {
    const err = /** @type {any} */ (reason);
    console.error(`${PRODUCT_ID}: unhandled rejection (server stays up): ${err?.stack ?? err}`);
  });
}
