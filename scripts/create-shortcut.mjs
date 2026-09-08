#!/usr/bin/env node
// Optional helper: puts a shortcut on the Windows Desktop and one in the Start
// menu, both opening the app window on a double click, exactly like `npm run
// app`. Never called automatically — run it with `npm run shortcut`.
//
// Re-run it after changing the icon: a `.lnk` copies the icon path at creation
// time and Windows never goes back to ask. Anything already pinned to the
// taskbar or to Start is a *third* copy of the shortcut and has to be unpinned
// and pinned again — nothing can reach inside a pin.
//
// The target is Electron's own executable, not node: electron.exe is a GUI
// binary, so no console window flashes up and none stays behind. There is no
// "Stop" counterpart on purpose — the server lives inside the window, so
// closing the window is how you stop it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../product.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ENTRY = path.join(ROOT, "electron", "main.mjs");
const SHORTCUT_NAME = `${PRODUCT_NAME}.lnk`;
// Only `.ico` files: a shortcut's IconLocation is a Windows icon resource, and
// pointing it at a `.png` gives a blank icon rather than an error. Without one
// the shortcut wears Electron's own icon — run `npm run shortcut` again once
// `scripts/make-icon.mjs` has written it.
const ICON = ["icon.ico", "favicon.ico"]
  .map((name) => path.join(ROOT, "public", name))
  .find((file) => existsSync(file));

if (process.platform !== "win32") {
  console.log(
    `create-shortcut only works on Windows (this is ${process.platform}).\n` +
      "On macOS and Linux start the app with: npm run app",
  );
  process.exit(0);
}

if (!existsSync(ELECTRON)) {
  console.error(
    "create-shortcut: Electron's binary is missing, so the shortcut would point at nothing.\n" +
      "Run `node node_modules/electron/install.js` to download it, then try again.",
  );
  process.exit(1);
}

// Quoting rule for a PowerShell single-quoted string: double the quotes.
const psString = (value) => `'${value.replace(/'/g, "''")}'`;

// Both shortcuts are written from one loop: the Start menu entry that differs
// from the desktop one is how you end up with two apps that behave differently.
// An existing .lnk is overwritten in place, which is the point — that is how a
// new icon reaches a shortcut made before it existed.
const script = [
  "$shell = New-Object -ComObject WScript.Shell",
  "$targets = @(",
  "  [Environment]::GetFolderPath('Desktop'),",
  "  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')",
  ")",
  "foreach ($folder in $targets) {",
  "  if (-not (Test-Path $folder)) { continue }",
  `  $path = Join-Path $folder ${psString(SHORTCUT_NAME)}`,
  "  $link = $shell.CreateShortcut($path)",
  `  $link.TargetPath = ${psString(ELECTRON)}`,
  `  $link.Arguments = ${psString(`"${ENTRY}"`)}`,
  `  $link.WorkingDirectory = ${psString(ROOT)}`,
  `  $link.Description = ${psString(`Open ${PRODUCT_NAME}`)}`,
  ...(ICON ? [`  $link.IconLocation = ${psString(ICON)}`] : []),
  "  $link.Save()",
  "  Write-Output $path",
  "}",
  // The shell caches icons per file and shows the stale one until something
  // tells it not to. This is the documented way to ask for a rebuild.
  "ie4uinit.exe -show",
].join("\n");

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  { stdio: "inherit", windowsHide: true },
);

child.on("error", (err) => {
  console.error(`create-shortcut: could not run PowerShell (${err.message})`);
  process.exit(1);
});
child.on("exit", (code) => {
  if (code !== 0) console.error(`create-shortcut: PowerShell exited with code ${code}`);
  else if (!ICON) {
    console.log(
      "create-shortcut: no public/icon.ico, so the shortcuts wear Electron's icon.\n" +
        "Make one with `node scripts/make-icon.mjs <logo.png>` and run this again.",
    );
  }
  process.exit(code ?? 1);
});
