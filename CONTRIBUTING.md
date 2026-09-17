# Contributing to pi-desktop-ui

Thanks for taking the time to contribute. This document explains how the project is laid out,
how to run it, and what a change must pass before it can be merged.

## Getting started

```bash
git clone https://github.com/Rumi-sketches/pi-desktop-ui.git
cd pi-desktop-ui
npm install
npm start
```

Requirements: **Node.js >= 22** and a working [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
installation (`~/.pi/agent`). If `pi` works in your terminal, the UI will too.

## The one gate: `npm test`

```bash
npm test
```

This is the only gate, and it runs the same way locally and in CI. It first runs the unit tests
(`node --test "test/*.test.mjs"`), so their output is visible, then `npm run verify`, which:

1. syntax-checks every `.mjs` file,
2. checks the sources for known Italian words and for the retired product name,
3. runs ESLint (`npm run lint`),
4. type-checks the sources with `tsc --noEmit` (see below),
5. runs the unit tests again, as its own guard when invoked on its own,
6. boots the real server on a free port — with the agent state isolated in a temporary
   directory (`PI_WEB_UI_AGENT_DIR`), never your real `~/.pi/agent` — and runs a battery of
   smoke checks (access control, CSP, secret redaction, input validation).

`PI_WEB_UI_AGENT_DIR` is honoured **only** when `PI_WEB_UI_TEST=1` is set as well: the agent
directory holds tokens and credentials, so a normal run always uses `~/.pi/agent` and no
environment can relocate it. Set both variables together — before importing any module, since
the path is resolved by a module-level constant — whenever a test or a script needs its own
agent state.

No external service is required. **Do not open a pull request with a red verify.**

## Where things live

| Path | What it is |
|---|---|
| `product.mjs` | The two names of the product: `PRODUCT_ID` (logs, filenames) and `PRODUCT_NAME` (window title, UI text). |
| `server.mjs` | Boot, the route table, and the wiring between the modules below. |
| `http.mjs` | Request/response helpers, body parsing, the router, the static assets. |
| `session-store.mjs` | What is persisted under `~/.pi/agent`, and reading the session log. |
| `agent-bootstrap.mjs` | Safe discovery and editing of global and project files that shape pi's initial prompt. |
| `interactive-forms.mjs` | Validation and lifecycle of forms opened by the agent's `request_form` tool. |
| `prompt-queue.mjs` | Cancellable steering and follow-up messages for a running chat. |
| `contexts.mjs` | One agent context per open chat, plus its SSE event stream. |
| `analytics.mjs` | Cost/token history aggregated from the session log. |
| `network.mjs` | The listening address and the LAN access token. |
| `lifecycle.mjs` | Shutdown: signals, `/api/shutdown`, `/api/restart`. |
| `api-chat.mjs` | The endpoints of a chat (scoped to the tab's context). |
| `api-settings.mjs` | The endpoints of the settings and analytics screens. |
| `access-control.mjs` | Pure functions deciding who may reach the server (loopback, LAN token, CSRF). |
| `usage-tracker.mjs` | Polls claude.ai / kimi.com account limits. |
| `platform.mjs` | Native helpers (folder picker, file manager, terminal) per OS. |
| `public/index.html` | The frontend markup. |
| `public/app.js` | The frontend logic, loaded as an ES module. |
| `public/app.css` | The frontend styles. |
| `public/ui-state.js` | Small, testable state helpers shared by activity and navigation behavior. |
| `bin/pi-desktop-ui.mjs` | The `npm start` launcher: boots the server and opens the browser. |
| `jsconfig.json` | Type-check configuration (`checkJs`); lists the files `tsc` reads. |
| `scripts/verify.mjs` | The verification gate described above. |
| `scripts/create-shortcut.mjs` | Optional Windows Desktop and Start menu shortcuts for the app. |
| `test/` | Unit tests (`node:test`). |

## Things to know before touching the code

- **The product has one name, and it is in `product.mjs`.** `PRODUCT_ID` (`pi-desktop-ui`) for
  logs, filenames and anything machine-facing; `PRODUCT_NAME` (`pi desktop ui`) for the window
  title and the texts the user reads. Import them instead of typing the name; the frontend, which
  cannot import from the project root, spells it out. `npm run verify` fails on the retired name
  `pi-web-ui`. The exception is the **persisted** names — the `web-ui-*.json` stores, the
  `pi_web_ui_access` cookie, `PI_WEB_UI_AGENT_DIR` and `PI_WEB_UI_TEST` — which are on disk and in
  live installations: they keep the old spelling forever.
- **`public/app.js` is a known monolith.** The frontend logic deliberately lives in a single
  file. Do not try to split it up: keep PRs against it **small and focused**, one concern per
  change, so diffs stay reviewable.
- **The split is by concern, not by endpoint.** A new handler belongs to `api-chat.mjs` if it
  answers about the tab's chat and to `api-settings.mjs` if it answers about the machine; the
  rules it needs go in the module that owns that state (`contexts.mjs`, `session-store.mjs`,
  `network.mjs`), never in `server.mjs`, which stays boot + route table + wiring.
- **New endpoints go in the route table.** `server.mjs` declares every route as a
  `[method, path, handler]` triple in `ROUTES` (`PARAM_ROUTES` for a path with a `:name`
  segment, `PREFIX_ROUTES` for a whole sub-tree); the handler takes the request bag
  `{ req, res, url, sessionKey, params }`. Dispatch matches the path first and the method
  second, so a path called with the wrong verb answers `405` with an `Allow` header instead of
  quietly running the handler of another verb. `HEAD` is served by the `GET` handler.
- **One operation, one route.** An endpoint must not switch on a field of its body to decide
  what it does: put the operation in the path (`POST /api/archiving/sweep`) and its subject in
  the path too (`POST /api/sessions/:id/fork`), so the verb and the URL say what will happen.
- **A failure never travels with a `200`.** Answer the status that describes it (`400` bad
  input, `409` the state rules it out, `501` not available on this system) and, when the page
  has to *react* to the reason rather than just show it, `sendError(res, status, code, message)`
  — `{ error: { code, message } }` with a stable snake_case `code`. The rest of the API answers
  the flat `{ error: "message" }`; `errorInfo()` in `app.js` reads both, so `api()` callers
  always get `{ error: message, code }` and can silence a code with `{ quiet: [...] }`.
- **Types are checked, in JSDoc.** `jsconfig.json` turns on `checkJs` over the sources and
  `npm test` fails on a type error. There is no build step and no `.ts` file: annotate with
  JSDoc (`@param`, `@returns`, `@typedef`) and, where a cast is the honest answer, write
  `/** @type {X} */ (value)`. Suppress with `@ts-expect-error` only with a reason on the same
  comment. The bodies of `/api/state`, `/api/config` and `/api/analytics` are declared as
  typedefs next to the handler that builds them: extend them when you add a field.
- **No inline `<script>` or `<style>` in `index.html`.** The page ships a CSP with
  `script-src 'self'`: anything inline is blocked by the browser, silently. Styles go in
  `app.css`, logic in `app.js`, both served from the `PAGE_ASSETS` whitelist in `http.mjs`.
- **Security-sensitive code** (`access-control.mjs`, the request guard, secret redaction, the
  DOMPurify/CSP pipeline) must keep its existing tests green and gain new ones when behavior
  changes. Read the "Threat model" section of the README first.
- **No new runtime dependencies** without discussion. Frontend libraries are vendorized and
  served locally — nothing is fetched from a CDN.
- Match the surrounding style; there is no formatter, so do not reformat files you touch.

## Submitting a change

1. Fork and branch from `main`.
2. Make the change, keeping it small.
3. Run `npm test` until it is green.
4. Open a pull request describing **what** changed and **why**.

## Pre-release checklist

Run these before every release. The project is private on npm today, but the package check still
catches files that should not ship.

1. **`npm audit --omit=dev`** — audit what ships, not the toolchain. Fix `high` and `critical`
   findings that a non-breaking bump of a direct dependency in `package.json` can fix.
2. **`npm test`** — the gate of the previous section; it must be green on a clean checkout.
3. **Check that local runtime files are still ignored** — `server.log` and `backup/` are in
   `.gitignore` and must never become tracked:
   ```bash
   git status --porcelain --ignored | grep -E 'server\.log|backup/'
   ```
   Every match must be prefixed with `!!` (ignored). Anything else means the file is tracked
   or staged: stop and fix it.
4. **`npm pack --dry-run`** — read the file list end to end. It must contain only the sources
   the UI needs; no logs, no backups, no local config, no `.pi` state.
