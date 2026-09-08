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
- **Desktop chrome.** Browser-style project tabs sit at the top, one per project/cwd, with the open
  set persisted in localStorage. Each project tab and `All` remembers its own chat, terminal or
  settings view. The vertical icon rail became a small horizontal bar at the foot of the sidebar;
  the "Graphite" grey theme and a selectable accent colour work with every palette.
- **Integrated terminals.** Two buttons next to "New chat" open a real PTY in the folder of the
  current chat: π starts `pi`, ▢ a bare PowerShell. The processes live in the server (`terminals.mjs`),
  so they survive a page reload; output travels over SSE, input and resize over POST, and xterm.js is
  vendorized like the other libraries. They show up in a "Terminals" section above the chat list.
  The routes answer loopback only, LAN token or not: a shell is not something to hand out over the
  network. There is no cap on how many can be open. A chip in the header counts the running ones and
  its popover lists them. The selected terminal gets its own folder, type and status header. Open
  folder, copy path, restart and close always act on that visible terminal; restart replaces the PTY
  and clears its scrollback.

- **Chat keys stay opaque.** The current SDK normally assigns a session file when a chat is created.
  The compatibility path still accepts `draft:<cwd>` and moves the context, tab memory, cached view
  and requests in flight to the server's key when a `rekey` event arrives. Changing folder follows
  the key the server returns.
- **One selection drives the view.** Every transition identifies a tab, view type and resource.
  Filters, sort and grouping still choose deterministic fallbacks when a remembered resource is no
  longer available. A new chat opened under a project tab starts in that project's folder. Toasts
  sit at the top right, and "Chat finished" only appears for a run this page saw start.
- **The desktop app has a port of its own (3778), not an ephemeral one.** The page origin is what
  `localStorage` is keyed by, so a fresh port at every launch handed the UI an empty store: filters,
  sort, grouping, theme and project tabs reset themselves at every start. The proof was on disk —
  fifteen `http://127.0.0.1:<random>` origins in the Local Storage LevelDB, each with its own copy
  of the settings. Verified by launching the app twice against a throwaway profile: the filter, the
  sort and the project tabs come back. Busy port → ephemeral fallback, with a warning; a check in
  `npm run verify` keeps the port from going back to 0.

- **Chat switching paints locally first.** The last eight visited chats keep bounded DOM snapshots,
  scroll and composer state. A switch restores that state in the click's synchronous turn, then
  refreshes chat, session and project data in parallel. Model and command catalogs load at bootstrap
  instead of on each switch. Eviction clears DOM references, listeners and timers; composer text is
  persisted in sessionStorage, while attachments stay in memory.
- **Project diffs retain their source chat.** Agent-produced changes now live in a project-level
  registry for the server lifetime. Two chats that modify the same path produce separate rows, and
  diff requests include the opaque source session key instead of depending on the active chat.
- **Navigation scenarios pass in the Windows Electron app.** An isolated run covered two rapid
  three-chat sequences, three project tabs plus `All`, per-chat composer and scroll, a rekey event,
  nine distinct chats, and terminal open, folder, copy, restart and close actions. The ninth chat
  evicted the least-recent attachment, and a cached chat rendered before its HTTP refresh.
- **Marking the open chat as done moves on to the next one.** Landing on the chat below it in the
  sidebar, or on the new-chat screen when the list is empty.
- **No menu bar** (`Edit` / `View`) off macOS, where the application menu is where copy/paste and
  Cmd+Q live. Reload and devtools are bound on the window instead (F5 / Ctrl+R, F12 / Ctrl+Shift+I).
- **App icon.** `public/icon.png` + `public/icon.ico` (window, taskbar, favicon), generated from any
  PNG by `scripts/make-icon.mjs`: it trims the uniform border a logo export comes with, drops that
  background colour, squares the mark and writes the six sizes the Windows shell picks from. No
  image dependency — PNG is inflate plus a filter byte per scanline, and an ICO entry may hold a
  PNG as is. `npm run shortcut` now writes the Start menu entry as well as the desktop one and
  rebuilds the shell icon cache: a `.lnk` copies the icon path when it is created, so a shortcut
  made before the icon existed keeps Electron's own until it is written again.
- **Stopping the server asks first when it would interrupt something.** One count
  (`workInProgress()` in `lifecycle.mjs`: chats mid-turn from the context registry, live terminals
  from the terminal registry, never from the page) behind three doors: closing the desktop window
  (native dialog, on the window's own `close` — by `before-quit` the window is gone and a "cancel"
  would leave an app with no screen), `POST /api/shutdown` and `POST /api/restart` (both `409`
  `work_in_progress` with `{ agents, terminals }`, repeated with `{ force: true }`). A signal or the
  OS session ending never asks.
- **Running chats accept cancellable steering and follow-up.** Each context owns an in-memory queue
  with opaque IDs, a 20-item limit and a 32 MiB byte limit. `Reindirizza` hands a message to the next
  model turn; `Dopo` waits for the current response. The transcript shows pending ghosts, removes
  only the selected duplicate, and fixes each message only after the server reports delivery.
- **Transcript and chat metrics now use pi's public SDK contracts.** Skill calls reload as compact
  name-and-argument blocks, provider reasoning keeps one shape, and live transcript changes share
  the same bottom-stickiness rule. `getSessionStats()` supplies all token buckets and cost;
  `getContextUsage()` supplies the nullable context percentage. Per-model rows plus `Session work`
  add back to the chat total.
- **OpenAI account usage and Luna title fallback are separate opt-ins.** Both start off. OpenAI usage
  resolves pi's OAuth only on the server, while Haiku and Luna share a three-call title budget per
  chat. The provider icon map also records source and terms; uncertain or restricted marks use the
  neutral symbol instead of an altered logo.
- **The integrated controls-and-metrics flow passed in Electron on Windows.** A local fixture covered
  steering, follow-up, selective cancellation, queue ownership across chat changes, scroll
  stickiness, reasoning, compact skill reload and cache-token totals. API, SSE and logs did not
  contain the fixture credential or hidden skill body. Rekey and post-compaction metrics passed the
  isolated endpoint tests. OpenAI quota and Luna fallback were not called live because their
  opt-ins were off and no consent was supplied. Final `npm test`: 239 tests, 237 passed and 2
  pre-existing platform skips; syntax, API-doc, lint, typecheck, lifecycle and smoke gates passed.

**Not done, on purpose**

- No installer and no packaging (`electron-builder` & co.): the app runs from the clone with
  `npm run app`.
- No bundler, no preload script: the UI is served over HTTP from loopback, exactly as before.

