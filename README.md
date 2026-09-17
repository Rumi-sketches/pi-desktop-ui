# pi desktop ui

A local desktop and browser interface for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Use several chats at once, inspect diffs, answer interactive forms, switch models, open terminals and track token costs without leaving the app. The server runs on your machine and uses your existing `~/.pi/agent` configuration. There is no hosted service, account or telemetry.

## Quick start

You need Node.js 22 or newer and a working pi installation. If `pi` runs in your terminal, the app can use the same providers, credentials, settings and sessions.

```bash
git clone https://github.com/Rumi-sketches/pi-desktop-ui.git
cd pi-desktop-ui
npm install
npm run app
```

`npm run app` opens the Electron desktop app. Closing its window also stops the local server.

Prefer a browser tab instead?

```bash
npm start
```

This opens `http://127.0.0.1:3777`. Press `Ctrl+C` in the terminal to stop it.

The package is not published on npm. Run it from the cloned folder.

## What you can do

### Work across chats and projects

- Run multiple chats in parallel. Switching chats does not stop their agents.
- Pin project folders as tabs, drag the tabs into your preferred order and switch Git branches from the project view.
- Search chat titles and message contents, mark finished chats as done and fork a conversation from an earlier message.
- Return to a recent chat without losing its scroll position, draft text or in-memory attachments.
- See changes from each source chat as separate diffs, even when two chats edit the same file.

### Control a running agent

The composer stays available while pi is responding:

- `Reindirizza` sends guidance at the next model turn.
- `Dopo` queues a follow-up after the current response.
- A queued message remains visible and can be cancelled until pi receives it.

The activity label shows how long the current response has been running. Its timer starts again for each prompt and pauses while an interactive form waits for your answer.

### Use pi's tools and configuration

- Switch between authenticated models and supported thinking levels.
- Use slash commands, prompt templates and skills from your pi installation.
- Fill in forms created by pi's `request_form` tool without leaving the chat.
- Inspect the exact generated prompt and the instruction files pi loaded.
- Edit global agent inputs from Settings and project inputs from the chat header. You can restore every file to its pre-edit state.
- Choose which tools, providers and models appear in the app.

### Inspect usage and files

- See current context size, context percentage, processed tokens and cumulative cost for each chat.
- Review daily usage by model and project from the session files in `~/.pi/agent/sessions`.
- Check account limits for Claude and Kimi after adding their credentials. OpenAI Codex limits use pi's existing OAuth and require a separate opt-in.
- Open files, reveal the working folder and inspect agent-produced diffs.

### Open integrated terminals

On Windows, the buttons beside "New chat" open either pi or PowerShell in the current chat's folder. Terminals survive page reloads and have controls for copying the path, opening the folder, restarting and closing the process.

Integrated terminals are not available on macOS or Linux yet. The rest of the app works there, subject to the platform notes below.

## Desktop app

```bash
npm run app
```

The app uses port `3778` on loopback so it can run beside `npm start`. If that port is busy, it chooses a free port for that launch.

Other desktop behavior:

- Starting a second instance brings the existing window to the front.
- Web links open in your system browser.
- Restarting from Settings replaces the server and reloads the window.
- Windows uses the system title bar theme and the header adapts to narrow windows.
- Text fields follow your operating system spellchecker languages.

### Windows shortcut

```bash
npm run shortcut
```

This creates shortcuts on the Desktop and in the Start menu. They open the app without a console window. Delete the shortcuts if you no longer want them.

There is no installer or packaged binary yet.

## Browser mode

```bash
npm start
```

The browser version and desktop app expose the same UI. To choose another port:

```bash
PORT=4000 npm start
```

On Windows PowerShell, use:

```powershell
$env:PORT = 4000
npm start
```

## First steps in the app

1. Open a new chat.
2. Pick a project folder from the chat header.
3. Choose a model and thinking level from the top bar.
4. Send a prompt. Markdown, tool calls, thinking blocks and diffs stream into the transcript.
5. Use the project tab to return to that folder later.

Settings contains themes, model visibility, account usage, chat archiving, title generation, agent inputs and local network access. Features that can consume provider quota, including generated chat titles, start disabled.

## Data and privacy

The app reads and writes the same local files as pi:

- settings and provider configuration under `~/.pi/agent`
- session history under `~/.pi/agent/sessions`
- optional web usage credentials in `~/.pi/agent/web-usage.json`

The UI does not send telemetry. Model requests still go to the provider selected in pi. Optional account-limit checks contact the corresponding provider only after you configure or enable them.

Claude and Kimi usage credentials are stored as clear text in `web-usage.json`. Protect that file like a password. OpenAI Codex usage reads pi's OAuth token on the server and does not copy the token into browser storage or `web-usage.json`.

## Local network access

By default, the server binds to `127.0.0.1`. Other devices cannot connect.

To open the UI from another device on a trusted network:

1. Enable "Local network access" in Settings.
2. Restart the server. The desktop app can do this in place. In browser mode, stop and rerun `npm start`.
3. Reveal the access URL in Settings and open it once on the other device.
4. Keep the token private. Anyone with access controls pi with your user permissions.

The first visit exchanges the token for an `HttpOnly` cookie and removes it from the address bar. Regenerating the token signs out every connected device. Turning network access off rejects remote requests immediately, though the listening socket returns to loopback only after a restart.

> Local network mode uses plain HTTP. Anyone able to inspect traffic on that network can read the token and chat contents. A VPN does not encrypt traffic between two devices on the same local network. Do not enable this mode on public or shared Wi-Fi.

Integrated terminal routes always require a loopback connection. The LAN token cannot open a shell remotely.

## Security model

This app controls a coding agent that can read files, write files and run commands with your user permissions. Treat access to the UI like access to your shell.

- Every request passes host and origin checks. Unsafe cross-origin requests and DNS-rebinding attempts receive `403`.
- The access boundary is the server port. A caller admitted through loopback or the LAN token has the same power as the local user.
- The app does not sandbox the agent after access has been granted.
- Files in the cloned project and its `node_modules` run with your permissions. Install only from a source you trust.
- LAN mode has no TLS and is intended only for trusted networks.

The project does not add route-level privilege tiers or rate limiting because they would not limit a caller who already controls the agent. The reasoning behind these choices lives in [DECISIONS.md](DECISIONS.md). The HTTP routes are documented in [docs/api.md](docs/api.md), but they are an unversioned implementation detail rather than a public integration API.

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Tested. Includes integrated PowerShell terminals, folder picker and native helpers. |
| macOS | Implemented with `osascript` and `open`, but not verified. Integrated terminals are unavailable. |
| Linux | Implemented with `zenity`, `xdg-open` and common terminal apps, but not verified. Integrated terminals are unavailable. |

If a native helper is missing, the app keeps running and hides or disables that action. You can always type a folder path by hand.

## Troubleshooting

### Electron has no binary

If `npm run app` reports that Electron has no executable, its install step did not finish. Run:

```bash
node node_modules/electron/install.js
```

Then try `npm run app` again.

### The desktop app uses a different port

Port `3778` was busy. The app selected a free port for that launch. Browser settings use the page origin, so a temporary port has separate local UI preferences.

### A restart or shutdown is blocked

The app asks for confirmation when stopping would interrupt a running agent or an open terminal. Close the work first or confirm the forced stop.

### A model is missing

Confirm that the provider is authenticated in pi, then check the enabled providers and models in Settings.

## Development

Run the full local and CI gate with:

```bash
npm test
```

It runs unit tests, syntax checks, ESLint, JavaScript type checks and server smoke tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and contribution rules.

## License

[MIT](LICENSE) © 2026 Rumi-sketches
