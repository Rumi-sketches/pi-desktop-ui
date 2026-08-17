// pi-desktop-ui main process: boots the embedded server on an ephemeral
// loopback port and shows the very same page `npm start` serves, this time in a
// window of its own. No bundler and no preload script: the UI keeps talking to
// the server over HTTP, so nothing about it has to know it lives in Electron.
//
// The server runs *inside* this process (see startServer in server.mjs), which
// is what makes "close the window, the server is gone" true by construction:
// there is no second process left to orphan.

import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";
import { PRODUCT_ID, PRODUCT_NAME } from "../product.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW_TITLE = PRODUCT_NAME;
const WINDOW_SIZE = { width: 1200, height: 800, minWidth: 900, minHeight: 600 };
// First one that exists wins; none of them ships today, so the app usually
// falls back to Electron's own icon.
const ICON = ["icon.png", "icon.ico", "favicon.png", "favicon.ico"]
  .map((name) => path.join(ROOT, "public", name))
  .find((file) => existsSync(file));
// Handed to the OS browser and nothing else: a `file:` or custom-scheme link
// from a page is an attack surface, not a link.
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const errorMessage = (err) => err?.message ?? String(err);

// The running server, or null before boot and once it has been released.
let running = null;
// Origin the windows are allowed to stay in; anything else is the web at large.
// It changes at every restart, because the port is ephemeral.
let serverOrigin = null;
// In-flight restart, so a second click cannot start one on top of another.
let restarting = null;

function fail(what, err) {
  dialog.showErrorBox(WINDOW_TITLE, `${what}\n\n${errorMessage(err)}`);
  app.quit();
}

// Give the port and the agent sessions back. Idempotent, and never rejects: a
// teardown failure must not keep the app from quitting.
async function releaseServer() {
  const server = running;
  running = null;
  serverOrigin = null;
  if (!server) return;
  try {
    await server.stop();
  } catch (err) {
    console.error(`${PRODUCT_ID}: the server did not stop cleanly (${errorMessage(err)})`);
  }
}

// Port 0: the OS picks a free one, so a session started from the terminal on
// the default port and the desktop app can coexist. The host is left to the
// server, which binds every interface when LAN access is on.
async function launchServer() {
  running = await startServer({ port: 0, onRestart: requestRestart });
  serverOrigin = new URL(running.url).origin;
  return running.url;
}

const isInternal = (target) => {
  try {
    return new URL(target).origin === serverOrigin;
  } catch {
    return false;
  }
};

function openExternally(target) {
  let protocol;
  try {
    protocol = new URL(target).protocol;
  } catch {
    return;
  }
  if (!EXTERNAL_PROTOCOLS.has(protocol)) return;
  shell.openExternal(target).catch((err) => {
    console.error(`${PRODUCT_ID}: could not open ${target} (${errorMessage(err)})`);
  });
}

// This window belongs to the local server and to nothing else: a link out (the
// UI opens a chat in a "new tab", docs and provider pages open in `_blank`)
// goes to the system browser, and a navigation away from our origin never
// happens in here.
function guardNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: "allow", overrideBrowserWindowOptions: windowOptions() };
    openExternally(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    openExternally(url);
  });
}

function windowOptions() {
  return {
    ...WINDOW_SIZE,
    title: WINDOW_TITLE,
    ...(ICON ? { icon: ICON } : {}),
    // Show only once the page has painted: loading a URL means a blank white
    // frame for as long as the first response takes.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function loadInto(win, url) {
  win.loadURL(url).catch((err) => fail(`Could not load ${url}`, err));
}

// The restart button in the UI. Outside Electron the server spawns a
// replacement process and dies; here the process *is* the app, so the server is
// swapped underneath the windows and only they reload. Fire-and-forget by
// design: the caller is a request handler that must not wait for us.
function requestRestart() {
  if (restarting) return;
  restarting = restartServer()
    .catch((err) => fail("The server did not come back after the restart.", err))
    .finally(() => {
      restarting = null;
    });
}

async function restartServer() {
  const openWindows = BrowserWindow.getAllWindows().map((win) => ({ win, url: win.webContents.getURL() }));
  await releaseServer();
  const url = await launchServer();
  // Keep everyone on the page they were on: only the origin moved (the #s=…
  // hash is what picks the open chat).
  for (const { win, url: previous } of openWindows) {
    if (win.isDestroyed()) continue;
    loadInto(win, rebase(previous, url));
  }
}

function rebase(url, baseUrl) {
  try {
    const next = new URL(url);
    const base = new URL(baseUrl);
    next.protocol = base.protocol;
    next.host = base.host;
    return next.href;
  } catch {
    return baseUrl;
  }
}

function focusExistingWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function boot() {
  let url;
  try {
    url = await launchServer();
  } catch (err) {
    fail("The server did not start.", err);
    return;
  }
  loadInto(new BrowserWindow(windowOptions()), url);
}

// Second launch: hand the existing window to the user instead of racing it for
// the agent's state files. The lock must be taken before anything is opened.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);

  // Every window, the popups the UI opens included, gets the same treatment.
  app.on("browser-window-created", (_event, win) => win.once("ready-to-show", () => win.show()));
  app.on("web-contents-created", (_event, contents) => guardNavigation(contents));

  // No dock/tray life on any platform, macOS included: this app *is* its
  // window, and closing it means shutting the server down.
  app.on("window-all-closed", () => app.quit());

  // The single exit funnel: whatever asks for the quit — the last window, a
  // signal, the OS session ending — the server is released first. The quit is
  // held back for that one turn, then let through on the second pass, when
  // `running` is already null.
  app.on("before-quit", (event) => {
    if (!running) return;
    event.preventDefault();
    releaseServer().then(() => app.quit());
  });

  // Ctrl+C in the terminal that launched the app, or a `kill`: Electron does
  // not turn these into a quit by itself, and without this the agent sessions
  // would die with no chance to clean up.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => app.quit());
  }

  app.whenReady().then(boot);
}
