#!/usr/bin/env node
// pi-web-ui launcher: starts the server, waits until it answers, opens the
// browser on the local URL and stays in the foreground until Ctrl+C.
// No dependencies: the browser is opened with the platform's own command.

import { spawn } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(ROOT, "server.mjs");
const PORT = Number(process.env.PORT ?? 3777);
const LOCAL_HOST = "127.0.0.1";
const BROWSER_HOST = "localhost";
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const PORT_PROBE_TIMEOUT_MS = 1000;
const SHUTDOWN_GRACE_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when something is already listening on the port: the server would then
// spin on EADDRINUSE and die, so it is better to say it up front.
function isPortTaken(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: LOCAL_HOST, port });
    const finish = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilReady(port, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server stopped during startup (exit code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://${LOCAL_HOST}:${port}/api/state`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`the server did not answer within ${BOOT_TIMEOUT_MS / 1000}s`);
}

function browserCommand(url) {
  switch (process.platform) {
    case "win32":
      return { command: "explorer.exe", args: [url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

// Best effort: a missing browser command must never take the launcher down,
// the URL is printed anyway.
function openBrowser(url) {
  const { command, args } = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", (err) => {
      console.error(`pi-web-ui: could not open the browser (${err.message}) — open ${url} yourself`);
    });
    child.unref();
  } catch (err) {
    console.error(`pi-web-ui: could not open the browser (${err.message}) — open ${url} yourself`);
  }
}

function startServer() {
  return spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

// Ctrl+C: ask the server to stop, then force it if it lingers.
function installShutdownHandlers(child) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("\npi-web-ui: stopping…");
    child.kill("SIGINT");
    setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
}

async function main() {
  if (await isPortTaken(PORT)) {
    console.error(
      `pi-web-ui: port ${PORT} is already in use.\n` +
        `If pi-web-ui is already running, open http://${BROWSER_HOST}:${PORT} instead.\n` +
        `Otherwise free the port or start with a different one: PORT=3778 npm start`,
    );
    process.exit(1);
  }

  const child = startServer();
  installShutdownHandlers(child);

  const url = `http://${BROWSER_HOST}:${PORT}`;
  try {
    await waitUntilReady(PORT, child);
  } catch (err) {
    console.error(`pi-web-ui: ${err.message}`);
    if (child.exitCode === null) child.kill();
    process.exit(1);
  }

  console.log(`pi-web-ui: opening ${url}`);
  openBrowser(url);

  // The server also exits on /api/restart, after spawning a detached
  // replacement that keeps the port: that is a normal exit, not a failure.
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`pi-web-ui: ${err?.message ?? err}`);
  process.exit(1);
});
