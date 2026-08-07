#!/usr/bin/env node
// Verification gate: syntax-checks every project .mjs file, then runs a smoke
// test that boots the server on a free port, expects GET /api/state -> 200 and
// a cross-origin POST -> 403, and a non-loopback Host -> 403.
// Exits non-zero on the first failed check.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED_DIRS = new Set(["node_modules", ".git", "backup", ".idea", ".sslayer", "PRDs", ".memory", ".reviews"]);
// The UI ships in English only: these are the Italian words the translation
// commit left behind, kept as a tripwire against their return. Documents
// (.md) and the excluded dirs above are allowed to be in Italian.
const TRANSLATED_EXTENSIONS = [".mjs", ".js", ".html", ".css"];
const ITALIAN_BLOCKLIST = [
  "troncat\\w*",
  "scadut\\w*",
  "riconnession\\w*",
  "richiesta",
  "totale",
  "completata",
  "esecuzione",
  "caratteri",
  "misura",
  "aggiornalo",
];
const ITALIAN_RE = new RegExp(`\\b(?:${ITALIAN_BLOCKLIST.join("|")})\\b`, "i");
const SMOKE_HOST = "127.0.0.1";
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

async function collectFiles(dir, matches) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...(await collectFiles(full, matches)));
    } else if (matches(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function checkSyntax() {
  const files = await collectFiles(ROOT, (name) => name.endsWith(".mjs"));
  const failures = [];
  for (const file of files) {
    const { code, stderr } = await run(process.execPath, ["--check", file]);
    if (code !== 0) failures.push(`${path.relative(ROOT, file)}\n${stderr.trim()}`);
  }
  if (failures.length > 0) {
    throw new Error(`Syntax errors in ${failures.length} file(s):\n${failures.join("\n\n")}`);
  }
  return files.length;
}

// No Italian left in the shipped sources: user-visible strings and comments
// alike. Reports every offending line, so one run is enough to fix them all.
async function checkNoItalianStrings() {
  const files = await collectFiles(ROOT, (name) =>
    TRANSLATED_EXTENSIONS.some((ext) => name.endsWith(ext)),
  );
  const failures = [];
  const self = fileURLToPath(import.meta.url); // holds the blocklist itself
  for (const file of files) {
    if (file === self) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (ITALIAN_RE.test(line)) {
        failures.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  if (failures.length > 0) {
    throw new Error(`Italian text in ${failures.length} line(s):\n${failures.join("\n")}`);
  }
  return files.length;
}

// Lint gate: ESLint recommended rules over the server-side sources. Invoked
// through its local bin so the check works the same on every platform.
function runLint() {
  return new Promise((resolve, reject) => {
    const eslintBin = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
    // ESLint prints violations on stdout, crashes on stderr: surface both.
    const child = spawn(process.execPath, [eslintBin, "."], { cwd: ROOT, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`eslint failed:\n${output.trim()}`));
    });
  });
}

// Unit tests run before the smoke test: they are cheaper and fail faster.
// node --test reports failures on stdout, so both streams are surfaced.
function runUnitTests() {
  return new Promise((resolve, reject) => {
    // A bare directory argument fails to resolve on Windows: use a glob.
    const child = spawn(process.execPath, ["--test", "test/*.test.mjs"], { cwd: ROOT, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`unit tests failed (node --test test/):\n${output.trim()}`));
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, SMOKE_HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForState(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${SMOKE_HOST}:${port}/api/state`);
      return res.status;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`server did not answer on port ${port} within ${BOOT_TIMEOUT_MS}ms`);
}

// A POST carrying a foreign Origin must be rejected by the request guard.
async function checkForeignOriginRejected(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}/api/state`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  if (res.status !== 403) {
    throw new Error(`cross-origin POST returned ${res.status}, expected 403`);
  }
}

// A malformed JSON body is a client error: it must answer 400, not 500.
async function checkMalformedJsonRejected(port) {
  const origin = `http://${SMOKE_HOST}:${port}`;
  const res = await fetch(`${origin}/api/status`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{{",
  });
  if (res.status !== 400) {
    throw new Error(`POST with a malformed JSON body returned ${res.status}, expected 400`);
  }
}

// A value outside the whitelist must be rejected, not silently applied:
// POST /api/status used to clear the chat state for any unknown value.
async function checkInvalidStatusRejected(port) {
  const origin = `http://${SMOKE_HOST}:${port}`;
  const res = await fetch(`${origin}/api/status`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/tmp/does-not-exist.jsonl", status: "bogus" }),
  });
  if (res.status !== 400) {
    throw new Error(`POST /api/status with an invalid status returned ${res.status}, expected 400`);
  }
}

// Dynamic responses carry chat content: they must not be sniffed nor cached.
async function checkSecurityHeaders(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}/api/state`);
  const expected = {
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  for (const [header, value] of Object.entries(expected)) {
    const actual = res.headers.get(header);
    if (actual !== value) {
      throw new Error(`GET /api/state: ${header} is "${actual}", expected "${value}"`);
    }
  }
}

// The HTML page renders model-controlled markdown: it must ship with a CSP.
async function checkHtmlCsp(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}/`);
  const csp = res.headers.get("content-security-policy");
  if (!csp || !csp.includes("default-src 'none'")) {
    throw new Error(`GET /: Content-Security-Policy is "${csp}", expected a restrictive policy`);
  }
}

// A fake apiKey planted in the temporary agent dir's models.json must never
// come back from /api/config: its value has to be redacted server-side.
const SMOKE_FAKE_API_KEY = "sk-verify-fake-secret-000";

async function checkConfigSecretsRedacted(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}/api/config`);
  if (res.status !== 200) throw new Error(`GET /api/config returned ${res.status}, expected 200`);
  const body = await res.text();
  if (body.includes(SMOKE_FAKE_API_KEY)) {
    throw new Error("GET /api/config leaked the fake apiKey planted in models.json");
  }
  if (!body.includes("apiKey")) {
    throw new Error("GET /api/config no longer lists the apiKey key name: redaction must keep keys visible");
  }
}

// Opening a session must be confined to the sessions directory: a file that
// exists but lives elsewhere has to be refused, not parsed as a session.
async function checkSessionOpenConfined(port) {
  const origin = `http://${SMOKE_HOST}:${port}`;
  const res = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", path: path.join(ROOT, "package.json") }),
  });
  if (res.status !== 400) {
    throw new Error(`action=open on a file outside SESSIONS_DIR returned ${res.status}, expected 400`);
  }
}

// LAN access is off by default: a non-loopback Host must not get through, even
// on a plain GET (the request never reaches a route).
function checkLanHostRejected(port) {
  // fetch() refuses to override the Host header, so this one goes through the
  // raw http client.
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: SMOKE_HOST,
        port,
        path: "/api/state",
        method: "GET",
        headers: { Host: `192.168.1.50:${port}` },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 403) return resolve();
        reject(new Error(`request with a LAN Host returned ${res.statusCode}, expected 403`));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function smokeTest() {
  const port = await findFreePort();
  // The server rewrites its state files at boot (first-run archiving sweep), so
  // it must never see the real ~/.pi/agent of whoever runs the test suite.
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-ui-verify-"));
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { fake: { apiKey: SMOKE_FAKE_API_KEY, baseUrl: "https://example.invalid" } } }),
  );
  const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: SMOKE_HOST,
      PI_WEB_UI_AGENT_DIR: agentDir,
    },
  });
  let exited = false;
  server.on("exit", () => (exited = true));

  try {
    const status = await waitForState(port, Date.now() + BOOT_TIMEOUT_MS);
    if (status !== 200) throw new Error(`GET /api/state returned ${status}, expected 200`);
    await checkForeignOriginRejected(port);
    await checkSecurityHeaders(port);
    await checkHtmlCsp(port);
    await checkLanHostRejected(port);
    await checkConfigSecretsRedacted(port);
    await checkMalformedJsonRejected(port);
    await checkInvalidStatusRejected(port);
    await checkSessionOpenConfined(port);
    return port;
  } finally {
    if (!exited) server.kill();
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The org id is interpolated into a claude.ai URL: a value carrying `/` or `..`
// must be refused at save time. Run in a child process so the temporary agent
// dir is picked up by usage-tracker's module-level constant.
async function checkOrgIdTraversalRejected() {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-ui-verify-"));
  const trackerUrl = pathToFileURL(path.join(ROOT, "usage-tracker.mjs")).href;
  const script = `
    const { saveUsageConfig } = await import(${JSON.stringify(trackerUrl)});
    try {
      await saveUsageConfig("anthropic", {
        cookie: "sessionKey=x",
        orgId: "11111111-2222-3333-4444-000000000000/../../evil",
      });
    } catch { process.exit(0); }
    process.exit(1);
  `;
  try {
    const { code } = await run(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PI_WEB_UI_AGENT_DIR: agentDir },
    });
    if (code !== 0) throw new Error("an org id containing a path traversal was accepted");
  } finally {
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const fileCount = await checkSyntax();
  console.log(`✓ syntax: ${fileCount} .mjs file(s) parsed without errors`);
  const scanned = await checkNoItalianStrings();
  console.log(`✓ language: ${scanned} source file(s) free of Italian text`);
  await runLint();
  console.log("✓ lint: eslint passed");
  await checkOrgIdTraversalRejected();
  console.log("✓ validation: org id with a path traversal is rejected");
  await runUnitTests();
  console.log("✓ unit tests: node --test test/*.test.mjs passed");
  const port = await smokeTest();
  console.log(`✓ smoke test: GET http://${SMOKE_HOST}:${port}/api/state -> 200`);
  console.log("✓ smoke test: POST with foreign Origin -> 403");
  console.log("✓ smoke test: responses carry nosniff and no-store");
  console.log("✓ smoke test: GET / carries a restrictive Content-Security-Policy");
  console.log("✓ smoke test: POST with a malformed JSON body -> 400");
  console.log("✓ smoke test: POST /api/status with a value outside the whitelist -> 400");
  console.log("✓ smoke test: GET with a LAN Host (lanAccess off) -> 403");
  console.log("✓ smoke test: secret values are redacted from /api/config");
  console.log("✓ smoke test: action=open outside the sessions directory -> 400");
  console.log("✓ smoke test: agent state isolated in a temporary PI_WEB_UI_AGENT_DIR");
}

main().catch((err) => {
  console.error(`✗ verify failed: ${err.message}`);
  process.exit(1);
});
