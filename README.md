# pi-desktop-ui

A local UI for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
as a desktop app or in your browser. It runs a small Node server on your machine and gives the agent
a front-end: multiple chats side by side, streaming answers, diffs, slash commands, model switching
and cost analytics.

Two ways to run the same thing: `npm run app` opens a desktop window (Electron) with the server
living inside it, `npm start` keeps the original terminal + browser setup. Both can run at the same
time.

Everything stays local. There is no backend service, no telemetry, no account: the server talks to
your own `~/.pi/agent` installation and to the model providers you have already authenticated.

## Design decisions

A few things this project deliberately does not do. They are choices, not gaps; the operational
details of each one live in [Security and network access](#security-and-network-access).

**The security boundary is the port, not the individual route.** Access is decided once, at the
door: loopback, or a valid token cookie. Behind that check there is no second tier of privilege,
because there is nothing to protect it from — whoever is inside already has `/api/cwd` and
`/api/prompt`, which run arbitrary commands by design.

That is why the code does not validate the path in `?s=`, nor mask the token returned by
`GET /api/network`. Both would look like hardening and neither would stop anyone: a caller past the
guard can read that token from disk, or read any file, with a single prompt. Spending checks there
buys nothing and suggests a boundary that does not exist.

**No TLS in local network mode.** Serving HTTPS from a machine on your LAN means a self-signed
certificate, accepted by hand on every device that connects, re-accepted whenever it changes. For a
feature that is off by default and meant for a trusted network, that trade is not worth it. The
consequence — plain HTTP traffic, cookie included — is stated in the threat model, and enabling the
mode is an explicit, reversible opt-in.

**No rate limiting.** The server is single-user and local: the only client is the person sitting in
front of it. There is no quota to protect and no shared capacity to be fair about, so the practical
limit on request volume is your own patience. The one case where a request has an external cost —
forcing a provider refresh from `/api/usage` — is handled where it belongs, by requiring the request
to be same-origin.

**The HTTP API is an implementation detail.** The routes under `/api/` exist to serve `public/`, not
as a supported integration API. Their current shapes are listed in [docs/api.md](docs/api.md) so the
server and its own UI cannot drift apart, but they are unversioned and may change with the UI. A
script built on them may need updates after any release.

Before opening a security issue, describe the realistic attacker: who they are, and how they get past
the guard in the first place. An issue that starts after that point is describing the design.

## Requirements

- **Node.js >= 22**
- **pi configured on the machine** — the UI reuses `~/.pi/agent` (settings, credentials, sessions).
  If `pi` works in your terminal, you are ready.
- **For the desktop app only:** Electron, installed as a devDependency by `npm install`. Nothing
  else — no bundler, no packaging step.

## Install

```bash
git clone https://github.com/Rumi-sketches/pi-desktop-ui.git
cd pi-desktop-ui
npm install
```

The package is not published on npm: clone it and run it from the folder.

If `npm run app` later complains that Electron has no binary, its post-install step did not run:
`node node_modules/electron/install.js` downloads it.

## Desktop app

```bash
npm run app
```

A window opens on the same UI, and that is the whole app: the server runs *inside* the Electron
process, so closing the window shuts it down — no stray server left behind, nothing to `Ctrl+C`.

- The server takes **port 3778 on loopback** (the CLI's 3777 plus one), so the app and a `npm start`
  session can be open side by side without fighting over the port or the agent's state files. The
  port is fixed, not ephemeral, because the page origin is what the UI's saved settings hang on: a
  new port at every launch would mean an empty `localStorage` and filters, theme and tabs back to
  their defaults. Busy port → the app still opens, on an ephemeral one.
- **One instance:** launching it again brings the existing window to the front.
- **Links out** (docs, provider pages) open in your system browser; the window itself never leaves
  the local server.
- **Restart** from the settings panel swaps the server underneath the window and reloads it, keeping
  the chat you were on.
- **Local network access** works exactly as it does from the terminal, token included (see
  [Security and network access](#security-and-network-access)).

There is no installer and no packaged binary yet: run it from the clone. On Windows, though, you can
get the double click:

```bash
npm run shortcut
```

This puts a single shortcut on your Desktop that opens the app window — no console, no browser, same
thing `npm run app` does. It is optional and never runs on its own. To remove it, delete the
shortcut; there is no "Stop" counterpart, because closing the window stops the server with it.

## Run in the browser

```bash
npm start
```

This starts the server on `http://127.0.0.1:3777`, waits until it answers, and opens your browser.
`Ctrl+C` shuts it down. To use another port:

```bash
PORT=3778 npm start
```

## Features

- **Multiple chats in parallel.** One agent context per chat stays alive when you switch away. The
  last eight visited chats also keep their rendered view, scroll position, composer text and
  in-memory attachments. Returning to one of them paints the cached view before HTTP sync starts.
- **Streaming answers** with markdown, syntax highlighting, thinking blocks and tool calls rendered
  as they arrive. A text-free spinner waits for the first model text; thinking and tool activity do
  not dismiss it.
- **Native interactive forms.** The built-in `request_form` tool lets the model collect related text,
  numeric, date, single-choice, multi-choice and confirmation fields in one accessible form. The tool
  waits for a validated submission and then continues the same turn; completed forms remain readable
  in chat history.
- **Steering and follow-up during a run.** The composer stays active and replaces the send arrow with
  `Reindirizza` and `Dopo`. The first delivers at the next model turn, the second after the current
  response. Pending messages appear as cancellable ghosts in their eventual transcript position.
  The queue belongs to one chat, is cleared with that live context, and accepts at most 20 messages
  or 32 MiB of decoded text and attachments.
- **Sessions sidebar** with search, favorites, per-chat working folder, and forking a conversation
  from any earlier message. Project tabs and `All` each remember their own chat, terminal or
  settings view.
- **Chat archiving** to keep the sidebar tidy (see below).
- **Model switching** from the top bar, restricted to providers with valid credentials, plus a
  thinking-level selector.
- **Enabled providers and models**: pick which providers/models show up in the picker; the choice is
  written to `enabledModels` in `~/.pi/agent/settings.json`.
- **Agent input controls** that show the contents of the instruction files pi actually loads. Global
  files and tool defaults live in Settings; project files live in the chat header, can be saved for
  that project or promoted globally, and every loaded resource has an always-visible native-editor
  action. Slash commands remain inspectable alongside the global configuration.
- **Chat metrics from pi's session APIs.** The header shows the current context size, context percentage
  (or `?` when pi cannot calculate either value) and cumulative cost. The detail shows cumulative
  processed tokens—including input, output, cache reads and cache writes—per model, and labels
  unattributed work as `Session work`.
- **Cost analytics** aggregated from `~/.pi/agent/sessions/**.jsonl`: tokens, requests and cost by
  day, model and project.
- **Real account limits** for claude.ai and kimi.com when you store those credentials. OpenAI Codex
  account limits have a separate, default-off toggle and reuse pi's OAuth on the server without
  copying its token into this app's settings.
- **Optional chat titles.** Haiku title generation is default-off. A second default-off toggle allows
  `openai-codex/gpt-5.6-luna` only when Haiku is unavailable. Existing chats require the separate
  backfill action, and each chat has one shared budget of three remote attempts.
- **Native helpers**: folder picker, reveal the working folder in the file manager, open a terminal
  there. An integrated terminal has its own folder, type and status header, plus copy path, restart
  and close actions.
- **Eight themes**, light and dark, plus an accent colour that applies over any of them.
- **Offline friendly**: libraries and fonts are served locally, nothing is fetched from a CDN.

## Security and network access

The server drives a coding agent that can read and write files on your machine. Treat it as a shell,
not as a web page.

- It binds to **`127.0.0.1` only** by default: other devices on your network cannot reach it.
- Every request goes through an origin check. Requests whose `Host` is not loopback, and unsafe
  methods (`POST`, `DELETE`, …) coming from a foreign `Origin`, are rejected with **403**. This
  blocks CSRF from any page you may have open and DNS-rebinding attempts.
- The **integrated terminals** (`/api/terminals*`) are served to the local machine only. They are a
  real shell with your privileges, so the check there is the TCP peer itself, hard-coded: enabling
  local network access does *not* extend to them, and no token opens them from another device.

If you do want to open a chat from your phone or another machine, enable **Local network access** in
Settings:

1. Turn the toggle on. The server generates a fresh token
   (32 random bytes) and shows a URL like `http://192.168.1.20:3777/?k=<token>`.
2. Restart the server so it binds to all interfaces: in the desktop app the **Restart** button
   does it in place; started from the terminal, stop it (Ctrl+C) and run `npm start` again.
3. Open that URL once on the other device. The token is verified in constant time, stored in an
   `HttpOnly; SameSite=Strict` cookie, and the browser is redirected to the clean URL — the token
   never stays in the address bar or in a log.
4. Requests from non-loopback hosts without that cookie get a 403.

Turning the toggle off drops the token (old URLs stop working) and every request from another
device is refused with a 403 straight away. The socket itself stays bound to all interfaces until
you restart the server, the same way turning the toggle on needs a restart to reach them.
**Regenerate token** invalidates every device at once.

Anyone on your LAN who obtains the URL controls the agent with your permissions. Only enable this on
networks you trust, and turn it back off when you are done.

> **Local network access is plain HTTP, and a VPN does not protect it.**
> The transport is unencrypted: anyone on the same network can read the access token and the
> content of your conversations as they travel. A VPN does not cover this case — it encrypts the
> traffic your machine sends out to the Internet through the tunnel, while local network access
> arrives from a device sitting on the same network and never enters that tunnel at all. This mode
> is meant for networks you trust; on public or shared Wi-Fi keep the toggle off.

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
  share or back it up carelessly. OpenAI Codex usage is different: the app reads pi's existing OAuth
  on the server and does not copy the token or full account ID into `web-usage.json` or browser
  responses.

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

The **integrated terminals** (the π and ▢ buttons) are Windows-only for now: they spawn a real
PowerShell through a PTY. On macOS and Linux `POST /api/terminals` answers `501` and the button
shows the reason in a toast; everything else works as described above.

The three native helpers detect whether the required command exists. When it does not, the server
answers `501` instead of crashing and the UI hides the button — the folder path can always be typed
by hand.

## License

[MIT](LICENSE) © 2026 Rumi-sketches
