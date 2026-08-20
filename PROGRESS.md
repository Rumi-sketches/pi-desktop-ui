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

- **The page loads its libraries as classic scripts.** highlight.js comes from `@highlightjs/cdn-assets`
  (a real browser build): the `highlight.js` package is CommonJS behind ES shims, so the old
  `import hljs from "/vendor/highlight.js/es/common.js"` 404'd and aborted all of `app.js` — dead
  buttons, empty lists, no counters. `npm run verify` now fetches every `/vendor/` URL the page names.
- **A malformed request target is a 400.** `new URL(req.url, ...)` used to throw out of the request
  listener and kill the process, taking the desktop window with it.

- **pi-web-ui parity.** Ported the later web-ui work: `POST /api/type-command` (command typed in a
  terminal, never executed) with a ▶ button on shell code blocks, the usage ring + popover in the
  composer, the flat chat layout (user pill / no avatars), the quick chat switcher on the collapsed
  sidebar, per-model weekly limits in the usage tracker.
- **Desktop chrome.** Browser-style project tabs at the top (one per project/cwd, persisted in
  localStorage, "+" opens known projects; a tab filters the sidebar and lands on the project's
  latest chat); the vertical icon rail became a small horizontal bar at the foot of the sidebar;
  new neutral "Graphite" grey theme plus a selectable accent colour (applies over any theme).
- **Integrated terminals.** Two buttons next to "New chat" open a real PTY in the folder of the
  current chat: π starts `pi`, ▢ a bare PowerShell. The processes live in the server (`terminals.mjs`),
  so they survive a page reload; output travels over SSE, input and resize over POST, and xterm.js is
  vendorized like the other libraries. They show up in a "Terminals" section above the chat list.
  The routes answer loopback only, LAN token or not: a shell is not something to hand out over the
  network. There is no cap on how many can be open: a chip in the header counts the running ones and
  its popover lists them, one click to jump to a terminal or close it.

- **A draft chat keeps its identity.** The first message creates the session file, and the context
  now moves from `draft:<cwd>` to that path (`rekey` event to the tab, alias for the requests in
  flight): the chat shows up in the sidebar, already marked as the active one, instead of appearing
  only after a detour through another chat. Changing folder follows the key the server answers with.
- **The sidebar drives the view.** Project tab, filters, sort and grouping all land on the first
  chat of the list they produce, or on the new-chat screen when it is empty; a new chat opened with
  a project tab active is born in that project's folder. Toasts moved to the top right, unsent
  composer text is parked per chat instead of following the tab, and "Chat finished" now needs a run
  this page actually saw start, with the chat's title (clipped) instead of its whole first message.
- **The desktop app has a port of its own (3778), not an ephemeral one.** The page origin is what
  `localStorage` is keyed by, so a fresh port at every launch handed the UI an empty store: filters,
  sort, grouping, theme and project tabs reset themselves at every start. The proof was on disk —
  fifteen `http://127.0.0.1:<random>` origins in the Local Storage LevelDB, each with its own copy
  of the settings. Verified by launching the app twice against a throwaway profile: the filter, the
  sort and the project tabs come back. Busy port → ephemeral fallback, with a warning; a check in
  `npm run verify` keeps the port from going back to 0.

**Not done, on purpose**

- No installer and no packaging (`electron-builder` & co.): the app runs from the clone with
  `npm run app`.
- No bundler, no preload script: the UI is served over HTTP from loopback, exactly as before.
- No app icon: `public/` ships none, so Electron's default is used. Dropping an `icon.png` in
  `public/` is enough to pick it up.
