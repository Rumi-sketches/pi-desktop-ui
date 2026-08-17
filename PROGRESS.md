# PROGRESS

## Migration: pi-web-ui → pi-desktop-ui (Electron)

Turning the web UI into a desktop app, without giving up the terminal + browser setup it started as.

**Done**

- **Embeddable server.** `server.mjs` exports `startServer({ port, host, onRestart })` →
  `{ url, port, host, stop() }` and `runCli()`. A bare import has no side effects, so a host process
  can own the server; `port: 0` picks an ephemeral loopback port. `npm start` behaves as before.
- **Electron shell.** `electron/main.mjs` boots the server in-process and shows it in a 1200×800
  window. Single-instance lock; every exit route (last window, signal, OS session) funnels through
  one teardown, so closing the window leaves no server and no agent run behind.
- **Desktop-aware routes and UI.** `POST /api/restart` calls the injected `onRestart` instead of
  spawning a replacement process: the shell restarts the server and reloads the windows in place.
  Links out go to the system browser, navigation stays on the server origin. LAN mode still works
  from inside the app.
- **Verification and docs.** `npm run verify` covers the embedded start → request → `stop()` →
  port-free cycle, with a clean child exit as the proof that nothing survives `stop()`. README has a
  Desktop app section; the package is now `pi-desktop-ui`.
- **One name.** `product.mjs` exports `PRODUCT_ID` / `PRODUCT_NAME`, used by every log prefix, the
  window title and the UI texts; the launcher is `bin/pi-desktop-ui.mjs`. `npm run verify` trips on
  the old name. Persisted names (`web-ui-*.json`, `pi_web_ui_access`, `PI_WEB_UI_*`) stay as they
  are, on purpose.

**Not done, on purpose**

- No installer and no packaging (`electron-builder` & co.): the app runs from the clone with
  `npm run app`.
- No bundler, no preload script: the UI is served over HTTP from loopback, exactly as before.
- No app icon: `public/` ships none, so Electron's default is used. Dropping an `icon.png` in
  `public/` is enough to pick it up.
