// pi-desktop-ui main process: boots the embedded server on a loopback port of
// its own and shows the very same page `npm start` serves, this time in a
// window of its own. No bundler and no preload script: the UI keeps talking to
// the server over HTTP, so nothing about it has to know it lives in Electron.
//
// The server runs *inside* this process (see startServer in server.mjs), which
// is what makes "close the window, the server is gone" true by construction:
// there is no second process left to orphan.

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";
import { describeWork } from "../lifecycle.mjs";
import { DEFAULT_PORT } from "../network.mjs";
import { PRODUCT_ID, PRODUCT_NAME } from "../product.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Sandboxed preloads run in Electron's restricted CommonJS environment.  An
// `.mjs` preload is treated as an ES module and is not executed there, leaving
// the renderer without the title-bar bridge (and the Windows caption buttons
// stuck on the light startup colour). Keep this tiny bridge explicitly CJS.
const PRELOAD = path.join(ROOT, "electron", "preload.cjs");
const WINDOW_TITLE = PRODUCT_NAME;
const WINDOW_SIZE = { width: 1200, height: 800, minWidth: 900, minHeight: 600 };
// First one that exists wins. Windows asks for the .ico first on purpose: it is
// the format the taskbar and the window frame read at every size they need,
// instead of resampling one bitmap themselves. Everywhere else it is the png.
const ICON = (process.platform === "win32"
  ? ["icon.ico", "icon.png", "favicon.ico", "favicon.png"]
  : ["icon.png", "favicon.png", "icon.ico", "favicon.ico"])
  .map((name) => path.join(ROOT, "public", name))
  .find((file) => existsSync(file));
// Handed to the OS browser and nothing else: a `file:` or custom-scheme link
// from a page is an attack surface, not a link.
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const errorMessage = (err) => err?.message ?? String(err);

// The running server, or null before boot and once it has been released.
let running = null;
// Origin the windows are allowed to stay in; anything else is the web at large.
let serverOrigin = null;
// In-flight restart, so a second click cannot start one on top of another.
let restarting = null;
// Set once the user has answered the "this will stop N chats" question, or by
// any exit that must not ask it (a signal, the OS session ending).
let closeConfirmed = false;

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

// A port of its own, next to the CLI's: the desktop app and a session started
// from the terminal on the default port coexist, and the app keeps the SAME
// origin at every launch. That last part is not cosmetic — everything the UI
// remembers (filters, sort, grouping, theme, project tabs, sidebar width) lives
// in localStorage, which the browser engine keys BY ORIGIN: an ephemeral port
// meant a brand-new empty store at every start, i.e. settings that reset
// themselves. If the port is taken by something else we still start, on an
// ephemeral one, rather than refusing to open.
const DESKTOP_PORT = DEFAULT_PORT + 1;
async function launchServer() {
  try {
    running = await startServer({ port: DESKTOP_PORT, onRestart: requestRestart });
  } catch (err) {
    console.warn(`${PRODUCT_ID}: port ${DESKTOP_PORT} is not free (${errorMessage(err)}), falling back to an ephemeral one — saved UI settings will not be found`);
    running = await startServer({ port: 0, onRestart: requestRestart });
  }
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

/** @returns {import("electron").BrowserWindowConstructorOptions} */
function windowOptions() {
  return {
    ...WINDOW_SIZE,
    title: WINDOW_TITLE,
    ...(ICON ? { icon: ICON } : {}),
    // Show only once the page has painted: loading a URL means a blank white
    // frame for as long as the first response takes.
    show: false,
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#f7f1e9", symbolColor: "#262220", height: 39 },
    } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD,
    },
  };
}

const safeCssColor = (value) => typeof value === "string"
  && value.length <= 64
  && /^(?:#[\da-f]{6,8}|rgba?\([\d\s.,%]+\))$/i.test(value);

function installTitleBarThemeBridge() {
  ipcMain.on("window:title-bar-theme", (event, palette) => {
    if (process.platform !== "win32" || !isInternal(event.sender.getURL())) return;
    if (!safeCssColor(palette?.background) || !safeCssColor(palette?.foreground)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay({ color: palette.background, symbolColor: palette.foreground, height: 39 });
    } catch (err) {
      console.error(`${PRODUCT_ID}: could not update the title bar (${errorMessage(err)})`);
    }
  });
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

// Closing the window stops the server, and with it every agent turn still
// running and every integrated terminal. Worth a question rather than a
// surprise — and asked here, on the window's own close, because by `before-quit`
// the window is already gone and a "cancel" would leave an app with nothing on
// screen. The counts come from the server, which owns the processes.
function confirmClose(win) {
  const work = running?.activity?.();
  if (!work?.busy) return true;
  const choice = dialog.showMessageBoxSync(win, {
    type: "question",
    buttons: ["Close anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: WINDOW_TITLE,
    message: `${describeWork(work)}.`,
    detail: `Closing ${WINDOW_TITLE} stops the local server, and with it everything running in it.`,
  });
  return choice === 0;
}

// Only the last window is asked: the others (a chat opened in a "new tab") are
// closing a view, not the server.
const isLastWindow = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length <= 1;

function guardClose(win) {
  win.on("close", (event) => {
    if (closeConfirmed || !isLastWindow()) return;
    if (confirmClose(win)) {
      closeConfirmed = true;
      return;
    }
    event.preventDefault();
  });
}

function focusExistingWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// No menu bar: this is a single-window app whose whole surface is the page, and
// an "Edit / View" strip on top of it was only ever chrome. macOS is the
// exception and not a stylistic one — there the application menu is where
// copy/paste and Cmd+Q live, and an app without it cannot be quit properly.
//
// The default menu also bound Ctrl+W to "close window" and ate the key before
// the page saw it; in the app Ctrl+W closes the *project tab* and only quits
// when there is none left. Dropping the menu makes that true by construction.
function installMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }]));
}

// Reload and devtools used to come free with the View menu. They are worth
// keeping — this app *is* a local web page and one bad render is one F5 away
// from being fixed — so they are bound on the window itself instead. Nothing
// else is: every other key belongs to the page.
function installWindowShortcuts(contents) {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const devtools = key === "f12" || (input.control && input.shift && key === "i");
    const reload = key === "f5" || (input.control && !input.shift && !input.alt && key === "r");
    if (devtools) {
      contents.toggleDevTools();
      event.preventDefault();
    } else if (reload) {
      contents.reload();
      event.preventDefault();
    }
  });
}

async function boot() {
  let url;
  try {
    url = await launchServer();
  } catch (err) {
    fail("The server did not start.", err);
    return;
  }
  installMenu();
  installTitleBarThemeBridge();
  loadInto(new BrowserWindow(windowOptions()), url);
}

// Second launch: hand the existing window to the user instead of racing it for
// the agent's state files. The lock must be taken before anything is opened.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);

  // Every window, the popups the UI opens included, gets the same treatment.
  app.on("browser-window-created", (_event, win) => {
    win.once("ready-to-show", () => win.show());
    guardClose(win);
  });
  app.on("web-contents-created", (_event, contents) => {
    guardNavigation(contents);
    installWindowShortcuts(contents);
  });

  // No dock/tray life on any platform, macOS included: this app *is* its
  // window, and closing it means shutting the server down.
  app.on("window-all-closed", () => app.quit());

  // The single exit funnel: whatever asks for the quit — the last window, a
  // signal, the OS session ending — the server is released first. The quit is
  // held back for that one turn, then let through on the second pass, when
  // `running` is already null.
  app.on("before-quit", (event) => {
    // Whatever asked for the quit before a window did — a signal, the OS session
    // ending, the second-instance path — is not a click to be second-guessed:
    // the windows about to close must not stop to ask.
    closeConfirmed = true;
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
