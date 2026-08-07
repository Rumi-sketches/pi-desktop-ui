#!/usr/bin/env node
// Optional helper: puts "pi-web-ui - Start" and "pi-web-ui - Stop" shortcuts on
// the Windows Desktop. Never called automatically — run it with `npm run shortcut`.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "pi-web-ui.mjs");
const PORT = Number(process.env.PORT ?? 3777);
const START_SHORTCUT_NAME = "pi-web-ui - Start.lnk";
const STOP_SHORTCUT_NAME = "pi-web-ui - Stop.lnk";

if (process.platform !== "win32") {
  console.log(
    `create-shortcut only works on Windows (this is ${process.platform}).\n` +
      "On macOS and Linux start the app with: npm start",
  );
  process.exit(0);
}

// Quoting rule for a PowerShell single-quoted string: double the quotes.
const psString = (value) => `'${value.replace(/'/g, "''")}'`;

// Stop shortcut: no PID file is kept anywhere, so it just kills whatever is
// listening on the port, which is always the pi-web-ui server in practice.
const stopCommand =
  `$conns = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue; ` +
  "if (-not $conns) { Write-Host 'pi-web-ui is not running.'; Start-Sleep -Seconds 2; exit }; " +
  "$conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; " +
  "Write-Host 'pi-web-ui stopped.'; Start-Sleep -Seconds 2";

const script = [
  "$desktop = [Environment]::GetFolderPath('Desktop')",

  `$start = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop ${psString(START_SHORTCUT_NAME)}))`,
  `$start.TargetPath = ${psString(process.execPath)}`,
  `$start.Arguments = ${psString(`"${LAUNCHER}"`)}`,
  `$start.WorkingDirectory = ${psString(ROOT)}`,
  "$start.Description = 'Start pi-web-ui'",
  "$start.Save()",

  `$stop = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop ${psString(STOP_SHORTCUT_NAME)}))`,
  "$stop.TargetPath = 'powershell.exe'",
  `$stop.Arguments = ${psString(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -Command "${stopCommand}"`)}`,
  `$stop.WorkingDirectory = ${psString(ROOT)}`,
  "$stop.Description = 'Stop pi-web-ui'",
  "$stop.Save()",

  "Write-Output (Join-Path $desktop " + psString(START_SHORTCUT_NAME) + ")",
  "Write-Output (Join-Path $desktop " + psString(STOP_SHORTCUT_NAME) + ")",
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
