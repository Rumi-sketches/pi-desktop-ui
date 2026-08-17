#!/usr/bin/env node
// pi-desktop-ui launcher: starts the server in this very process, opens the browser
// on the local URL and stays in the foreground until Ctrl+C.
// No dependencies: the browser is opened with the platform's own command.

import { spawn } from "node:child_process";
import { runCli } from "../server.mjs";
import { DEFAULT_PORT } from "../network.mjs";
import { PRODUCT_ID } from "../product.mjs";

// One source of truth for the default port: network.mjs owns it.
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const BROWSER_HOST = "localhost";

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
      console.error(`${PRODUCT_ID}: could not open the browser (${err.message}) — open ${url} yourself`);
    });
    child.unref();
  } catch (err) {
    console.error(`${PRODUCT_ID}: could not open the browser (${err.message}) — open ${url} yourself`);
  }
}

// The busy port is told apart by the error the bind itself raises, not by a
// probe beforehand: a probe answers about a past moment and reads its own
// timeout as "free", while EADDRINUSE is the answer about this very bind.
function explain(err) {
  if (err?.code === "EADDRINUSE") {
    return (
      `port ${PORT} is already in use.\n` +
      `If ${PRODUCT_ID} is already running, open http://${BROWSER_HOST}:${PORT} instead.\n` +
      `Otherwise free the port or start with a different one: PORT=${PORT + 1} npm start`
    );
  }
  return String(err?.message ?? err);
}

async function main() {
  // runCli owns the process from here on: signals, safety net and shutdown
  // (including /api/restart, which from the CLI is just a clean stop — the
  // server does not bring itself back) all live in server.mjs.
  const { port } = await runCli({ port: PORT });

  const url = `http://${BROWSER_HOST}:${port}`;
  console.log(`${PRODUCT_ID}: opening ${url}`);
  openBrowser(url);
}

main().catch((err) => {
  console.error(`${PRODUCT_ID}: ${explain(err)}`);
  process.exit(1);
});
