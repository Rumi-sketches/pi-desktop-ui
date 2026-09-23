# Contributing to pi-desktop-ui

Use Node.js 22 or newer and an existing pi installation under `~/.pi/agent`.

```bash
git clone https://github.com/Rumi-sketches/pi-desktop-ui.git
cd pi-desktop-ui
npm install
npm test
```

`npm test` runs the unit tests, then `npm run verify`: syntax, naming, lint and JSDoc type checks, another unit test run, and server smoke tests with isolated agent state. Run it before opening a pull request. The browser launches with `npm start`; Electron launches with `npm run app`.

## Code map

- `server.mjs` declares routes and wires modules. Chat handlers live in `src/chat/api-chat.mjs`; machine and settings handlers live in `src/settings/api-settings.mjs`. Route contracts belong in `docs/api.md`.
- `src/http/` owns request handling and access control; `src/storage/` owns persisted UI data; `src/terminals/` owns loopback-only terminals.
- `public/app.js` wires the browser app. `public/settings-view.js` owns settings UI; `public/agent-inputs.js` supplies editors shared with the project menu. Markup and styles live in `public/index.html` and `public/app.css`.
- `test/` contains Node.js tests; `scripts/verify.mjs` runs the verification checks.

## Rules that are easy to miss

- Keep the old persisted names: `web-ui-*.json`, `pi_web_ui_access`, `PI_WEB_UI_AGENT_DIR` and `PI_WEB_UI_TEST`. Other product names come from `product.mjs`. Do not rename persisted state as part of a product rename.
- `PI_WEB_UI_AGENT_DIR` works only with `PI_WEB_UI_TEST=1`. Set both before importing modules in tests; ordinary runs must use `~/.pi/agent` for credentials and state.
- Use `mutateJsonFile` for read-modify-write on shared JSON stores. It reloads under a cross-process lock. Stop all app instances before manually removing a stranded `.lock.reclaim` directory. The lock does not protect writes by pi or other programs.
- Declare new endpoints in the route tables in `server.mjs` and document them in `docs/api.md`. Put chat-scoped behavior in `src/chat/api-chat.mjs`, machine settings in `src/settings/api-settings.mjs`. Give distinct operations distinct routes and return an appropriate non-200 status for failures.
- Use JSDoc types; `jsconfig.json` enables `checkJs`. Do not add a TypeScript build step.
- Keep inline scripts and styles out of `public/index.html`; the CSP blocks inline scripts. Serve frontend assets locally. Do not add runtime dependencies without discussion.
- Read the [security model](README.md#security-model) before changing access controls, LAN access, terminals, secrets or rendered model output. Add tests for security-sensitive changes. Keep renderer updates bounded during streaming and add regression tests for changed hot paths.
- Keep changes focused; avoid unrelated formatting.

## Before a release

Run `npm audit --omit=dev`, `npm test` and `npm pack --dry-run`. Check the package file list for logs, backups, local configuration and agent state. Confirm `server.log` and `backup/` remain ignored rather than tracked.
