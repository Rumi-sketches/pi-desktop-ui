# HTTP API

Every route this server answers, and nothing else: the tables below are checked
against the route table in `server.mjs` (`ROUTES` and `PARAM_ROUTES`) by
`scripts/verify.mjs`, so a route added to one without the other fails the gate.

## Conventions

- **Scope.** The routes marked *[s]* act on the chat the tab is attached to. The
  tab names it with the query parameter `?s=<key>` or the header
  `x-pi-session`; without it the server picks the most recent chat. The key is
  opaque for the client (see the boundary comment in `contexts.mjs`).
- **Bodies.** Requests and responses are JSON (`application/json; charset=utf-8`),
  capped at 32 MB. `GET /api/events` is the exception: it answers
  `text/event-stream`.
- **Errors.** A failure never travels with a 200. Most routes answer the flat
  `{ error: "message" }`; `/api/cwd`, `/api/pick-folder` and `/api/usage/test`
  answer `{ error: { code, message } }`, where `code` is machine-readable
  (`chat_already_started`, `cancelled`, `credentials_missing`, …) and the page
  reads both shapes.
- **Errors every route can answer.** `403` foreign origin, non-loopback Host
  while LAN access is off, or a missing access token; `404` unknown path; `405`
  known path, wrong verb (with an `Allow` header); `413` body over the cap;
  `500` unexpected failure (the message is never echoed back, only logged).
  The tables below list the status codes a route raises *on its own*.
- **Static routes** are not part of this API: `GET /` (the page),
  `GET /app.js`, `GET /app.css` (its two assets, see `PAGE_ROUTES` in
  `http.mjs`) and `GET /vendor/*` (the vendored browser libraries, a prefix
  route). They answer HTML/JS/CSS, or `404` when a path is not whitelisted.

## Chat

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/events` *[s]* | – | SSE stream of the chat's agent events (`retry: 1000`, then one `data:` frame per event) | – |
| `GET /api/state` *[s]* | – | `{ key, sessionFile, cwd, current, thinkingLevel, thinkingLevels, totals, chat, chatByModel, context, streaming, platform, chatArchiving }` (see the `StatePayload` typedef) | – |
| `GET /api/models` *[s]* | – | `{ current, thinkingLevel, thinkingLevels, models[] }`, authenticated models only | – |
| `POST /api/model` *[s]* | `{ provider, id }` | `{ ok, current, thinkingLevel, thinkingLevels, context }` | `400` provider/id not non-empty strings · `404` model unknown or not authenticated |
| `POST /api/thinking` *[s]* | `{ level }` | `{ ok, thinkingLevel, thinkingLevels }` | `400` level outside what the model supports |
| `GET /api/history` *[s]* | – | `{ key, messages[], turnModel, live[], streaming }`; every message carries an `entryId` for forking | – |
| `POST /api/prompt` *[s]* | `{ text, images? }` | `202` `{ ok, key }`, the turn streams on `/api/events` | `400` empty prompt (no text and no image) |
| `POST /api/abort` *[s]* | – | `{ ok }` | – |
| `GET /api/commands` *[s]* | – | `{ commands[] }` (extensions, prompt templates, skills) | – |
| `GET /api/git` *[s]* | – | git status of the chat's folder | – |
| `GET /api/files` *[s]* | – | `{ files: [{ path, changes }] }` touched by this chat | – |
| `GET /api/files/diff` *[s]* | `?path=…` | `{ path, write, hunks[] }`, secrets redacted | `404` file not tracked by this chat |

## Sessions and folders

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/sessions` *[s]* | `?scope=cwd` (default) or `?scope=all` | `{ current, cwd, scope, running[], open[], sessions[] }` | – |
| `POST /api/sessions` *[s]* | – | `{ ok, key, cwd, running }` for a new chat in the tab's folder | – |
| `POST /api/sessions/activate` *[s]* | – | `{ ok, key, cwd, running }` for the most recent chat of that folder | – |
| `POST /api/sessions/:id/activate` *[s]* | `:id` = session file, url-encoded; `{ cwd? }` | `{ ok, key, cwd, running }` | `400` id unresolvable or outside the sessions directory |
| `POST /api/sessions/:id/fork` | `:id` as above; `{ entryId }` | `{ ok, key, cwd, running }` for the branched chat | `400` missing `entryId`, draft chat with no session file, id outside the sessions directory, or the branch could not be created |
| `POST /api/cwd` *[s]* | `{ path }` | `{ ok, cwd, key }` — folder of the not-yet-started chat | `400` `invalid_folder` · `409` `chat_already_started` |
| `POST /api/pick-folder` *[s]* | – | `{ path }` from the native folder picker | `400` `invalid_folder` · `409` `cancelled` · `501` `picker_unavailable` |
| `GET /api/recent-cwds` | – | `{ recent[] }` | – |
| `DELETE /api/recent-cwds` | `?path=…` | `{ recent[] }` without that entry | – |
| `POST /api/open-explorer` *[s]* | – | `{ ok, cwd }`, folder revealed in the system file manager | `501` not available on this system |
| `POST /api/open-terminal` *[s]* | – | `{ ok, cwd }`, terminal opened in the folder running `pi` | `501` not available on this system |
| `POST /api/favorites` | `{ path, favorite }` | `{ ok, favorites[] }` | `400` missing path |
| `POST /api/status` | `{ path, status }` with status `done` / `reopened` / `active` | `{ ok, status }` | `400` missing path or status outside the whitelist |
| `GET /api/archiving` | – | `{ enabled, lastSweep }` | – |
| `PUT /api/archiving` | `{ enabled }` | archiving state | `400` `enabled` is not a boolean |
| `POST /api/archiving/sweep` | – | archiving state plus `archived` (chats idle for more than 24h) | – |

## Settings, network and usage

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/settings` | – | `{ path, agentDir, sections[], raw, extras[], thinkingLevels[] }` — documented schema plus current values | – |
| `POST /api/settings` | `{ key, value }` | `{ ok, key, value, restart }`; `restart` is false when the change was applied to the live sessions | `400` missing key, unknown setting, non-numeric number, non-array list |
| `GET /api/config` *[s]* | – | `{ platform, cwd, sessionFile, sessionId, current, providers[], models[], tools[], options, paths, rawSettings, rawModels, node }`, secrets redacted | – |
| `GET /api/network` | – | LAN access state, detected LAN ip | – |
| `POST /api/network` | `{ lanAccess }` or `{ regenerate: true }` or `{ reveal: true }` | network state, or `{ url }` for `reveal` (one-shot access URL) | `400` nothing to change, or LAN access is off |
| `GET /api/usage` | `?force=1` refetches instead of serving the cache (same-origin proof required, otherwise it degrades to the cached answer) | account usage limits scraped from claude.ai / kimi.com | – |
| `GET /api/usage/config` | – | `{ anthropic: { configured, orgId }, kimi: { configured } }`, never the secrets | – |
| `POST /api/usage/config` | `{ provider: "anthropic" \| "kimi", ...fields }` (or `paste`) | `{ ok, status }` | `400` unknown provider or a value that fails validation (e.g. an org id containing a path traversal) |
| `POST /api/usage/test` | `{ provider }` | `{ ok, data }` after a live check of the stored credentials | `400` `unknown_provider`, `credentials_missing`, `usage_check_failed` |
| `DELETE /api/usage/credentials/:provider` | `:provider` = `anthropic` or `kimi` | `{ ok, status }` | `400` unknown provider |
| `GET /api/analytics` | – | cost/token history aggregated from the session files under the agent dir | – |

## Lifecycle

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `POST /api/shutdown` | – | `{ ok, stopping: true }`, then the server exits gracefully | – |
| `POST /api/restart` | – | embedded (Electron): `{ ok, restarting: true }` and the host restarts the server in place. From the CLI: `{ ok, stopping: true, restarting: false, message }` and the server stops for good | – |
