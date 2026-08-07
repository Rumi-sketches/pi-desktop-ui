# Contributing to pi-web-ui

Thanks for taking the time to contribute. This document explains how the project is laid out,
how to run it, and what a change must pass before it can be merged.

## Getting started

```bash
git clone https://github.com/Rumi-sketches/pi-web-ui.git
cd pi-web-ui
npm install
npm start
```

Requirements: **Node.js >= 22** and a working [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
installation (`~/.pi/agent`). If `pi` works in your terminal, the UI will too.

## The one gate: `npm run verify`

```bash
npm run verify
```

This is the only gate, and it runs the same way locally and in CI. It:

1. syntax-checks every `.mjs` file,
2. runs ESLint (`npm run lint`),
3. runs the unit tests (`node --test test/*.test.mjs`),
4. boots the real server on a free port — with the agent state isolated in a temporary
   directory (`PI_WEB_UI_AGENT_DIR`), never your real `~/.pi/agent` — and runs a battery of
   smoke checks (access control, CSP, secret redaction, input validation).

No external service is required. **Do not open a pull request with a red verify.**

## Where things live

| Path | What it is |
|---|---|
| `server.mjs` | The whole HTTP server: routes, agent bridge, config handling. |
| `access-control.mjs` | Pure functions deciding who may reach the server (loopback, LAN token, CSRF). |
| `usage-tracker.mjs` | Polls claude.ai / kimi.com account limits. |
| `platform.mjs` | Native helpers (folder picker, file manager, terminal) per OS. |
| `public/index.html` | The entire frontend: markup, CSS and JS in one file. |
| `bin/pi-web-ui.mjs` | The `npm start` launcher: boots the server and opens the browser. |
| `scripts/verify.mjs` | The verification gate described above. |
| `scripts/create-shortcut.mjs` | Optional Windows desktop shortcuts. |
| `test/` | Unit tests (`node:test`). |

## Things to know before touching the code

- **`public/index.html` is a known monolith.** The frontend deliberately lives in a single
  file. Do not try to split it up: keep PRs against it **small and focused**, one concern per
  change, so diffs stay reviewable.
- **Security-sensitive code** (`access-control.mjs`, the request guard, secret redaction, the
  DOMPurify/CSP pipeline) must keep its existing tests green and gain new ones when behavior
  changes. Read the "Threat model" section of the README first.
- **No new runtime dependencies** without discussion. Frontend libraries are vendorized and
  served locally — nothing is fetched from a CDN.
- Match the surrounding style; there is no formatter, so do not reformat files you touch.

## Submitting a change

1. Fork and branch from `main`.
2. Make the change, keeping it small.
3. Run `npm run verify` until it is green.
4. Open a pull request describing **what** changed and **why**.
