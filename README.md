# pi-web-ui

A local web UI for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
It runs a small Node server on your machine and gives the agent a browser front-end: multiple chats
side by side, streaming answers, diffs, slash commands, model switching and cost analytics.

Everything stays local. There is no backend service, no telemetry, no account: the server talks to
your own `~/.pi/agent` installation and to the model providers you have already authenticated.

## Requirements

- **Node.js >= 22**
- **pi configured on the machine** — the UI reuses `~/.pi/agent` (settings, credentials, sessions).
  If `pi` works in your terminal, you are ready.

## Install

```bash
git clone https://github.com/Rumi-sketches/pi-web-ui.git
cd pi-web-ui
npm install
```

The package is not published on npm: clone it and run it from the folder.

## Run

```bash
npm start
```

This starts the server on `http://127.0.0.1:3777`, waits until it answers, and opens your browser.
`Ctrl+C` shuts it down. To use another port:

```bash
PORT=3778 npm start
```

On Windows you can create a Desktop shortcut with `npm run shortcut` (optional, never run
automatically).

## Features

- **Multiple chats in parallel.** One agent context per chat, kept alive when you switch away: a run
  keeps going in the background and the result is there when you come back.
- **Streaming answers** with markdown, syntax highlighting, thinking blocks and tool calls rendered
  as they arrive.
- **Sessions sidebar** with search, favorites, per-chat working folder, and forking a conversation
  from any earlier message.
- **Chat archiving** to keep the sidebar tidy (see below).
- **Model switching** from the top bar, restricted to providers with valid credentials, plus a
  thinking-level selector.
- **Enabled providers and models**: pick which providers/models show up in the picker; the choice is
  written to `enabledModels` in `~/.pi/agent/settings.json`.
- **Settings panel** over your real pi configuration: documented settings, providers and
  authentication, active tools, paths, and the raw `settings.json` / `models.json`.
- **Cost analytics** aggregated from `~/.pi/agent/sessions/**.jsonl`: tokens, requests and cost by
  day, model and project.
- **Real account limits** for claude.ai and kimi.com, if you store those credentials.
- **Native helpers**: folder picker, reveal the working folder in the file manager, open a terminal
  there.
- **Six themes**, light and dark.
- **Offline friendly**: libraries and fonts are served locally, nothing is fetched from a CDN.

## Security and network access

The server drives a coding agent that can read and write files on your machine. Treat it as a shell,
not as a web page.

- It binds to **`127.0.0.1` only** by default: other devices on your network cannot reach it.
- Every request goes through an origin check. Requests whose `Host` is not loopback, and unsafe
  methods (`POST`, `DELETE`, …) coming from a foreign `Origin`, are rejected with **403**. This
  blocks CSRF from any page you may have open and DNS-rebinding attempts.

If you do want to open a chat from your phone or another machine, enable **Local network access** in
Settings:

1. Turn the toggle on. The server generates a fresh token
   (32 random bytes) and shows a URL like `http://192.168.1.20:3777/?k=<token>`.
2. The server restarts and binds to all interfaces.
3. Open that URL once on the other device. The token is verified in constant time, stored in an
   `HttpOnly; SameSite=Strict` cookie, and the browser is redirected to the clean URL — the token
   never stays in the address bar or in a log.
4. Requests from non-loopback hosts without that cookie get a 403.

Turning the toggle off drops the token (old URLs stop working) and rebinds to loopback.
**Regenerate token** invalidates every device at once.

Anyone on your LAN who obtains the URL controls the agent with your permissions. Only enable this on
networks you trust, and turn it back off when you are done.

### Threat model

Be clear about what this tool is before exposing it to anything:

- **Whoever reaches the port controls the machine.** The server drives an agent that reads and
  writes files and runs commands with your user's permissions. The access checks exist to keep
  strangers out, not to sandbox whoever gets in — there is no privilege boundary behind the port.
- **LAN traffic is plain HTTP.** There is no TLS. With local network access enabled, anyone able
  to sniff your network segment can read chats and the access cookie in transit. Only use it on
  networks you trust as much as the machine itself.
- **The installation folder is trusted code.** Everything in it (`server.mjs`, `public/`,
  `node_modules/`) runs or is served with your permissions. Treat it like any other program you
  install: don't run copies from sources you don't trust, and don't let untrusted users write to it.
- **`~/.pi/agent/web-usage.json` contains real session credentials.** If you configure the account
  limits widget, the claude.ai session cookie and the kimi.com token you paste are stored there in
  clear text. They grant access to your accounts: protect that file like a password, and don't
  share or back it up carelessly.

## Chat archiving

Chats you are done with can be marked as **done**: they move to a separate group at the bottom of the
sidebar, dimmed but still clickable, and reopening one marks it as *reopened*.

- **On the very first run** — and only then — every chat untouched for more than 24 hours is marked
  as done, so an existing installation does not start with a wall of old sessions. A flag is written
  afterwards so the sweep never repeats.
- **Archive chats older than 24 hours** in Settings runs the same sweep manually, whenever you want.
- **Turning archiving off** hides the whole feature: the sidebar becomes a flat list, without the
  done/reopen button, the Active/Done filters or the archived group. It **does not delete anything** —
  the states are kept and come back if you turn it on again.

## Platform support

| Platform | Status |
|---|---|
| Windows | **Tested.** All features, including folder picker, file manager and terminal helpers. |
| macOS | **Not verified.** Implemented with `osascript` / `open`; expected to work, untested. |
| Linux | **Not verified.** Implemented with `zenity` / `xdg-open` / common terminals; expected to work, untested. |

The three native helpers detect whether the required command exists. When it does not, the server
answers `501` instead of crashing and the UI hides the button — the folder path can always be typed
by hand.

## License

[MIT](LICENSE) © 2026 Rumi-sketches
