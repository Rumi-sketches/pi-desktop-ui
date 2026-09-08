/**
 * platform.mjs — the three OS-native operations the web UI offers, behind a
 * single cross-platform surface: pick a folder, reveal a folder in the file
 * manager, open a terminal in a folder.
 *
 * Rules of the house:
 *  - nothing here ever throws: every entry point resolves to a result object,
 *    so a missing command degrades into "unavailable" instead of a 500;
 *  - availability is probed once and cached, so the UI can hide the buttons the
 *    current machine cannot honour;
 *  - Windows behaviour must stay byte-for-byte what it was before this module
 *    existed (that is the only platform actually tested).
 */

import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WINDOWS = "win32";
const MACOS = "darwin";

const PICK_FOLDER_SCRIPT = path.join(__dirname, "pick-folder.ps1");

/** Terminal emulators tried in order on Linux; first one installed wins. */
const LINUX_TERMINALS = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];

const UNAVAILABLE = Object.freeze({ ok: false, reason: "unavailable" });

/** Run a command and resolve to its stdout, or to null on any failure. */
function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, ...options }, (err, stdout) => {
      resolve(err ? null : (stdout ?? ""));
    });
  });
}

/** Fire a detached GUI process; resolves to true when the spawn itself worked. */
function detach(cmd, args, options = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        ...options,
      });
      // `error` fires asynchronously when the binary does not exist at all.
      child.once("error", () => resolve(false));
      child.unref();
      // Nothing to await: if the spawn were going to fail it would have by the
      // next tick, and waiting for exit would hang on a long-lived window.
      setImmediate(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

/** True when `name` resolves to an executable on this machine. */
async function hasCommand(name) {
  const finder = process.platform === WINDOWS ? "where" : "which";
  return (await run(finder, [name])) !== null;
}

/**
 * Memoize a zero-argument async probe. Availability cannot change while the
 * server runs, and `where`/`which` cost a process spawn each.
 */
function once(probe) {
  let pending = null;
  return () => (pending ??= probe());
}

/* ------------------------------ folder picker ----------------------------- */

// The modern native picker (IFileOpenDialog + FOS_PICKFOLDERS, see
// pick-folder.ps1). The old inline FolderBrowserDialog was both ugly and opened
// *behind* the browser, having no owner window; the script owns it to the
// foreground window.
async function pickFolderWindows(initial) {
  const stdout = await run(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", PICK_FOLDER_SCRIPT, "-Initial", initial ?? ""],
  );
  return stdout?.trim() || null;
}

async function pickFolderMac(initial) {
  const target = initial ? ` default location (POSIX file ${JSON.stringify(initial)})` : "";
  const script = `POSIX path of (choose folder with prompt "Choose a folder"${target})`;
  const stdout = await run("osascript", ["-e", script]);
  return stdout?.trim() || null;
}

async function pickFolderLinux(initial) {
  const args = ["--file-selection", "--directory"];
  if (initial) args.push(`--filename=${initial.endsWith(path.sep) ? initial : initial + path.sep}`);
  const stdout = await run("zenity", args);
  return stdout?.trim() || null;
}

/** Folder picker per platform; anything else falls back to the Linux one. */
const PICKERS = {
  [WINDOWS]: pickFolderWindows,
  [MACOS]: pickFolderMac,
};

const folderPicker = () => PICKERS[process.platform] ?? pickFolderLinux;

const canPickFolder = once(async () => {
  if (process.platform === WINDOWS) return hasCommand("powershell.exe");
  if (process.platform === MACOS) return hasCommand("osascript");
  return hasCommand("zenity");
});

/**
 * Open the native folder picker.
 * @returns {Promise<{ok: true, path: string|null} | {ok: false, reason: string}>}
 *          `path` is null when the user cancelled.
 */
export async function pickFolder(initial) {
  if (!(await canPickFolder())) return UNAVAILABLE;
  const pick = folderPicker();
  return { ok: true, path: await pick(initial) };
}

/* ------------------------------- open folder ------------------------------ */

const FILE_MANAGER = {
  [WINDOWS]: "explorer.exe",
  [MACOS]: "open",
};

const fileManager = () => FILE_MANAGER[process.platform] ?? "xdg-open";

const canOpenFolder = once(() => hasCommand(fileManager()));

/**
 * Reveal `dir` in the system file manager.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function openFolder(dir) {
  if (!(await canOpenFolder())) return UNAVAILABLE;
  // explorer.exe exits with code 1 even on success when it hands the path to an
  // already running instance: fire and forget, the exit code means nothing.
  return (await detach(fileManager(), [dir])) ? { ok: true } : UNAVAILABLE;
}

/* ------------------------------ open terminal ----------------------------- */

/** The first Linux terminal emulator installed, or null. Probed once. */
const linuxTerminal = once(async () => {
  for (const term of LINUX_TERMINALS) {
    if (await hasCommand(term)) return term;
  }
  return null;
});

function openTerminalWindows(dir, command) {
  // A plain spawn() of powershell.exe inherits the server's own console state,
  // which may be hidden or absent. Routing through `cmd /c start` asks the shell
  // for a brand new, independent console window regardless of the parent's.
  //
  // The directory never appears in the command string: it travels as the spawn's
  // `cwd`, which `start` hands to the new console. A quoted path would have to
  // survive two levels of parsing (cmd, then PowerShell), and escaping for one
  // is not escaping for the other.
  const args = ["/c", "start", "", "powershell.exe", "-NoExit"];
  if (command) args.push("-Command", command);
  return detach("cmd.exe", args, {
    cwd: dir,
    windowsHide: false,
  });
}

function openTerminalMac(dir, command) {
  // `open -a Terminal <dir>` cannot carry a command, so the command variant goes
  // through AppleScript instead.
  if (!command) return detach("open", ["-a", "Terminal", dir]);
  const shell = `cd ${JSON.stringify(dir)} && ${command}`;
  return detach("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(shell)}`]);
}

async function openTerminalLinux(dir, command) {
  const term = await linuxTerminal();
  if (!term) return false;
  if (!command) return detach(term, [], { cwd: dir });
  // `-e` is the one flag all four emulators understand; the shell stays alive
  // after the command with `exec $SHELL`.
  return detach(term, ["-e", `sh -c ${JSON.stringify(`${command}; exec $SHELL`)}`], { cwd: dir });
}

/** Terminal opener per platform; anything else falls back to the Linux one. */
const TERMINALS = {
  [WINDOWS]: openTerminalWindows,
  [MACOS]: openTerminalMac,
};

const terminalOpener = () => TERMINALS[process.platform] ?? openTerminalLinux;

const canOpenTerminal = once(async () => {
  if (process.platform === WINDOWS) return hasCommand("cmd.exe");
  if (process.platform === MACOS) return hasCommand("osascript");
  return (await linuxTerminal()) !== null;
});

/**
 * Open a terminal window in `dir`, optionally running `command` in it.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function openTerminal(dir, command) {
  if (!(await canOpenTerminal())) return UNAVAILABLE;
  const open = terminalOpener();
  return (await open(dir, command)) ? { ok: true } : UNAVAILABLE;
}

/* --------------------- type a command without running it ------------------- */

// Typed into the new shell's own console input buffer. There is no supported
// way to pre-fill a prompt from outside the process (PSReadLine's Insert()
// throws while no ReadLine loop is active), but a process may inject keystrokes
// into its own input buffer: they land at the prompt exactly as if typed by
// hand, with no trailing Return.
const PS_TYPER = `
$src = @"
using System;
using System.Runtime.InteropServices;
public class PiWebUiTyper {
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public bool bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] b, uint len, out uint written);
  public static void Type(string text) {
    IntPtr h = GetStdHandle(-10);
    var recs = new INPUT_RECORD[text.Length * 2];
    int i = 0;
    foreach (char c in text) {
      recs[i++] = new INPUT_RECORD { EventType = 1, bKeyDown = true, wRepeatCount = 1, UnicodeChar = c };
      recs[i++] = new INPUT_RECORD { EventType = 1, bKeyDown = false, wRepeatCount = 1, UnicodeChar = c };
    }
    uint w;
    WriteConsoleInput(h, recs, (uint)recs.Length, out w);
  }
}
"@
Add-Type -TypeDefinition $src
`;

/** Single-quoted PowerShell literal: inside it, only the quote itself escapes. */
const psLiteral = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/**
 * Open a PowerShell window in `dir` with `command` already typed at the prompt,
 * waiting for the user to press Enter. The command is never executed by us.
 *
 * The script travels as -EncodedCommand (UTF-16LE base64): `command` comes from
 * model output, and this way it never has to survive cmd.exe *and* PowerShell
 * quoting on the way in. If the injection fails the window still prints the
 * command, so the user is never left staring at a blank shell.
 */
function typeInTerminalWindows(dir, command) {
  const script = [
    `Set-Location -LiteralPath ${psLiteral(dir)}`,
    PS_TYPER,
    `$cmd = ${psLiteral(command)}`,
    'Write-Host "Command ready below - press Enter to run it, or edit it first." -ForegroundColor DarkCyan',
    'try { [PiWebUiTyper]::Type($cmd) } catch { Write-Host $cmd }',
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // Same reason as openTerminalWindows: `cmd /c start` is what guarantees a new
  // console window, whatever console the server itself was started from.
  return detach("cmd.exe", ["/c", "start", "", "powershell.exe", "-NoExit", "-EncodedCommand", encoded], {
    cwd: dir,
    windowsHide: false,
  });
}

/**
 * Type `command` into a fresh terminal in `dir` without running it.
 * Windows only: neither Terminal.app nor the Linux emulators can leave a
 * command pending at the prompt, and silently running it instead would be
 * exactly the surprise this feature exists to avoid.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function typeInTerminal(dir, command) {
  if (process.platform !== WINDOWS) return UNAVAILABLE;
  if (!(await canOpenTerminal())) return UNAVAILABLE;
  return (await typeInTerminalWindows(dir, command)) ? { ok: true } : UNAVAILABLE;
}

/* ------------------------------- capabilities ----------------------------- */

/**
 * Which native operations this machine can actually perform. The UI hides the
 * buttons that would fail, so the answer must never throw.
 * @returns {Promise<{os: string, osName: string, pickFolder: boolean, openFolder: boolean, openTerminal: boolean, typeInTerminal: boolean}>}
 */
export async function platformCapabilities() {
  const [folderPicker, fileBrowser, terminal] = await Promise.all([
    canPickFolder(),
    canOpenFolder(),
    canOpenTerminal(),
  ]);
  return {
    os: process.platform,
    osName: `${os.type()} ${os.release()}`,
    pickFolder: folderPicker,
    openFolder: fileBrowser,
    openTerminal: terminal,
    typeInTerminal: process.platform === WINDOWS && terminal,
  };
}
