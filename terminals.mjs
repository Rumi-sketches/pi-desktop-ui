/**
 * terminals.mjs — the registry that owns the integrated terminals.
 *
 * A terminal is a real PTY (node-pty) running a PowerShell, either bare
 * (kind `shell`) or with the pi agent started in it (kind `pi`). The process
 * lives here, in the server, not in the page: a browser reload drops the
 * viewers, never the process.
 *
 * What the registry keeps per terminal:
 *   pty         — the live process handle;
 *   scrollback  — everything it printed so far, capped at 200KB, so a tab that
 *                 attaches late still sees the screen it missed;
 *   produced    — how much the process printed since it started, cap included:
 *                 the running offset a viewer resumes from after a reconnect,
 *                 measured in the same units as the scrollback;
 *   subscribers — the live viewers (one per open SSE stream), each with the
 *                 callback for the output and the one for the death of the
 *                 process: a viewer nobody is typing into learns that the
 *                 terminal is over from here, not from a failed keystroke;
 *   chatKey     — the chat this terminal was opened from, so concluding that
 *                 chat can switch its terminals off (null when unknown);
 *   exited      — set when the process dies, with its exit code. The row stays
 *                 in the list until someone closes it explicitly: a terminal
 *                 that exited on its own must still be visible, and readable.
 *
 * Nothing here is persisted: the terminals die with the server.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node-pty";

/** Scrollback kept in RAM per terminal; older bytes are dropped from the head. */
export const SCROLLBACK_CAP = 200 * 1024;

/** The only two things a terminal can be. */
export const TERMINAL_KINDS = /** @type {const} */ (["pi", "shell"]);

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// node-pty on Windows needs the full path of the executable: the bare name
// "powershell.exe" comes back as "File not found".
const POWERSHELL = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/**
 * @typedef {"pi" | "shell"} TerminalKind
 *
 * @typedef {object} Terminal
 * @property {string} id
 * @property {TerminalKind} kind
 * @property {string} cwd
 * @property {number} createdAt
 * @property {import("node-pty").IPty} pty
 * @property {string} scrollback
 * @property {number} produced  total length ever appended to the scrollback
 * @property {Set<Viewer>} subscribers
 * @property {string | null} chatKey  the chat it was opened from, if known
 * @property {number | null} exited  exit code once the process died, else null
 *
 * @typedef {object} Viewer
 * @property {(data: string, offset: number) => void} onData
 * @property {((code: number, offset: number) => void) | undefined} onExit
 *
 * @typedef {object} TerminalInfo
 * @property {string} id
 * @property {TerminalKind} kind
 * @property {string} cwd
 * @property {number} createdAt
 * @property {string | null} chatKey
 * @property {number | null} exited
 */

/** @type {Map<string, Terminal>} */
const terminals = new Map();

/** @type {(() => void) | null} */
let onTerminalsChanged = null;

/**
 * Register the callback fired whenever the list changes (create, exit, close).
 * Optional: the registry works fine with nobody listening.
 * @param {(() => void) | null} fn
 */
export function setTerminalsChangedListener(fn) {
  onTerminalsChanged = fn;
}

function terminalsChanged() {
  if (!onTerminalsChanged) return;
  try {
    onTerminalsChanged();
  } catch {
    // A broken listener must not take a terminal down with it.
  }
}

/**
 * Keep only the last SCROLLBACK_CAP characters: the head is what scrolls away.
 * @param {string} text
 */
export function capScrollback(text) {
  return text.length > SCROLLBACK_CAP ? text.slice(text.length - SCROLLBACK_CAP) : text;
}

/** @param {string} kind */
export function isTerminalKind(kind) {
  return /** @type {readonly string[]} */ (TERMINAL_KINDS).includes(kind);
}

/** The public shape of a terminal: everything but the process and its bytes.
 * @param {Terminal} terminal
 * @returns {TerminalInfo}
 */
function describe(terminal) {
  const { id, kind, cwd, createdAt, chatKey, exited } = terminal;
  return { id, kind, cwd, createdAt, chatKey, exited };
}

/**
 * Spawn a terminal and keep it.
 * @param {{ kind: TerminalKind, cwd: string, chatKey?: string | null,
 *          cols?: number, rows?: number }} options
 * @returns {TerminalInfo}
 */
export function createTerminal({ kind, cwd, chatKey = null, cols = DEFAULT_COLS, rows = DEFAULT_ROWS }) {
  if (!isTerminalKind(kind)) throw new Error(`unknown terminal kind: ${kind}`);
  // `pi` rides inside PowerShell rather than being spawned directly: -NoExit
  // leaves a usable shell behind when the agent quits, instead of a dead PTY.
  const args = kind === "pi" ? ["-NoLogo", "-NoExit", "-Command", "pi"] : ["-NoLogo"];
  const pty = spawn(POWERSHELL, args, {
    name: "xterm-color",
    cols,
    rows,
    cwd,
    env: /** @type {{ [key: string]: string }} */ ({ ...process.env }),
  });

  /** @type {Terminal} */
  const terminal = {
    id: randomUUID(),
    kind,
    cwd,
    createdAt: Date.now(),
    pty,
    scrollback: "",
    produced: 0,
    subscribers: new Set(),
    chatKey,
    exited: null,
  };
  terminals.set(terminal.id, terminal);

  pty.onData((data) => {
    terminal.scrollback = capScrollback(terminal.scrollback + data);
    // Counted before the chunk goes out, so a viewer is told the offset it has
    // reached *including* what it is about to write.
    terminal.produced += data.length;
    for (const subscriber of terminal.subscribers) {
      try {
        subscriber.onData(data, terminal.produced);
      } catch {
        // A viewer that throws loses this chunk, not the terminal.
      }
    }
  });

  pty.onExit(({ exitCode }) => {
    terminal.exited = exitCode;
    // The viewers hear it before the list does: an open pane must turn
    // read-only on the death itself, not on the next keystroke it swallows.
    for (const subscriber of terminal.subscribers) {
      try {
        subscriber.onExit?.(exitCode, terminal.produced);
      } catch {
        // A viewer that throws is not a reason to skip the others.
      }
    }
    terminalsChanged();
  });

  terminalsChanged();
  return describe(terminal);
}

/** @returns {TerminalInfo[]} oldest first, so the sidebar order is stable. */
export function listTerminals() {
  return [...terminals.values()].sort((a, b) => a.createdAt - b.createdAt).map(describe);
}

/**
 * How many terminals still have a live process. The row of an exited terminal
 * stays in the list, so the length of listTerminals() is not this number — and
 * this is the one anything destructive (a restart) has to ask before it warns
 * the user: a dead terminal costs nothing to lose.
 * @returns {number}
 */
export function countLiveTerminals() {
  let live = 0;
  for (const terminal of terminals.values()) if (terminal.exited === null) live += 1;
  return live;
}

/**
 * @param {string} id
 * @returns {TerminalInfo | null}
 */
export function getTerminal(id) {
  const terminal = terminals.get(id);
  return terminal ? describe(terminal) : null;
}

/**
 * Everything the terminal printed so far (capped), for a viewer attaching now.
 * @param {string} id
 * @returns {string | null} null when the id is unknown
 */
export function getScrollback(id) {
  return terminals.get(id)?.scrollback ?? null;
}

/**
 * What a viewer resuming at `offset` missed.
 *
 * The scrollback is a window on the tail of the output: it covers the offsets
 * from `produced - scrollback.length` to `produced`. An offset inside that
 * window can be resumed from exactly; anything older scrolled away for good
 * and the only honest answer is the whole window plus `reset`, which tells the
 * viewer to throw away the screen it has instead of stitching output that
 * never followed.
 *
 * @param {string} id
 * @param {number | null} offset where the viewer got to, null when it is new
 * @returns {{ data: string, offset: number, reset: boolean } | null} null when
 *   the id is unknown. `offset` is where the caller now is; `reset` means the
 *   data replaces the viewer's screen rather than continuing it.
 */
export function getScrollbackSince(id, offset) {
  const terminal = terminals.get(id);
  if (!terminal) return null;
  const { scrollback, produced } = terminal;
  const oldest = produced - scrollback.length;
  // `offset > produced` is not paranoia: the registry loses everything when the
  // server restarts, so a browser can come back holding an id from a previous
  // life of the same terminal.
  const resumable =
    offset !== null && Number.isInteger(offset) && offset >= oldest && offset <= produced;
  if (!resumable) return { data: scrollback, offset: produced, reset: true };
  return { data: scrollback.slice(offset - oldest), offset: produced, reset: false };
}

/**
 * @param {string} id
 * @param {string} data
 * @returns {boolean} false when the id is unknown or the process already died
 */
export function writeTo(id, data) {
  const terminal = terminals.get(id);
  if (!terminal || terminal.exited !== null) return false;
  terminal.pty.write(data);
  return true;
}

/**
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 * @returns {boolean} false when the id is unknown or the process already died
 */
export function resize(id, cols, rows) {
  const terminal = terminals.get(id);
  if (!terminal || terminal.exited !== null) return false;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
  try {
    terminal.pty.resize(cols, rows);
  } catch {
    // The process can die between the check above and the call.
    return false;
  }
  return true;
}

/**
 * Attach a viewer. The returned function detaches it — call it when the SSE
 * stream closes, or the set grows by one on every reload.
 * The viewer is handed the offset reached by the terminal, so a client that
 * drops the connection can ask to resume from there.
 * @param {string} id
 * @param {(data: string, offset: number) => void} onData
 * @param {(code: number, offset: number) => void} [onExit] told when the
 *   process dies, with its exit code
 * @returns {(() => void) | null} null when the id is unknown
 */
export function subscribe(id, onData, onExit) {
  const terminal = terminals.get(id);
  if (!terminal) return null;
  /** @type {Viewer} */
  const viewer = { onData, onExit };
  terminal.subscribers.add(viewer);
  return () => {
    terminal.subscribers.delete(viewer);
  };
}

/**
 * Switch a terminal off without dropping it: the process dies, the row and its
 * scrollback stay, so the pane can be reopened read-only. This is the state a
 * terminal reaches on its own when its shell quits — concluding a chat just
 * gets it there on purpose.
 *
 * @param {string} id
 * @returns {boolean} false when the id is unknown
 */
export function terminateTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  // Already off: nothing to kill, and no second `exited` to announce.
  if (terminal.exited !== null) return true;
  try {
    terminal.pty.kill();
  } catch {
    // It threw because there is nothing left to kill, which means onExit has
    // already fired: the row is in the state this call wanted anyway.
  }
  // No terminalsChanged() here: onExit fires it, with the real exit code.
  return true;
}

/**
 * Switch off every terminal opened from a chat. Called when that chat is
 * concluded: its consoles have nothing left to run, but stay readable.
 * @param {string} chatKey
 * @returns {number} how many were still alive
 */
export function terminateTerminalsForChat(chatKey) {
  if (typeof chatKey !== "string" || !chatKey) return 0;
  let terminated = 0;
  for (const terminal of terminals.values()) {
    if (terminal.chatKey !== chatKey || terminal.exited !== null) continue;
    terminateTerminal(terminal.id);
    terminated += 1;
  }
  return terminated;
}

/**
 * Kill the process and drop the row. Killing an already exited terminal is not
 * an error: it just removes it.
 * @param {string} id
 * @returns {boolean} false when the id is unknown
 */
export function closeTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminals.delete(id);
  terminal.subscribers.clear();
  // kill() runs even on an already exited process, and that is not belt and
  // braces: on Windows the conout pipe of a PTY whose shell quit on its own
  // stays open and keeps the event loop alive forever. kill() is what releases
  // it. It throws when there is really nothing left, hence the catch.
  try {
    terminal.pty.kill();
  } catch {
    // Already gone: nothing left to kill.
  }
  terminalsChanged();
  return true;
}

/** Kill every terminal — the server shutting down, or a test cleaning up. */
export function closeAllTerminals() {
  for (const id of [...terminals.keys()]) closeTerminal(id);
}
