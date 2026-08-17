#!/usr/bin/env node
// Optional helper: puts a single shortcut on the Windows Desktop that opens the
// app window on a double click, exactly like `npm run app`.
// Never called automatically — run it with `npm run shortcut`.
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
// pointing it at a `.png` gives a blank icon rather than an error. None of
// these ships today, so the shortcut normally wears Electron's own icon.
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

const script = [
  "$desktop = [Environment]::GetFolderPath('Desktop')",

  `$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop ${psString(SHORTCUT_NAME)}))`,
  `$link.TargetPath = ${psString(ELECTRON)}`,
  `$link.Arguments = ${psString(`"${ENTRY}"`)}`,
  `$link.WorkingDirectory = ${psString(ROOT)}`,
  `$link.Description = ${psString(`Open ${PRODUCT_NAME}`)}`,
  ...(ICON ? [`$link.IconLocation = ${psString(ICON)}`] : []),
  "$link.Save()",

  `Write-Output (Join-Path $desktop ${psString(SHORTCUT_NAME)})`,
].join("; ");

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
  process.exit(code ?? 1);
});
