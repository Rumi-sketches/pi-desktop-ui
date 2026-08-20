#!/usr/bin/env node
// Verification gate: syntax-checks every project .mjs file, then runs a smoke
// test that boots the server on a free port, expects GET /api/state -> 200 and
// a cross-origin POST -> 403, and a non-loopback Host -> 403. A second smoke
// test covers the embeddable path the desktop shell uses: startServer({port:0})
// -> request -> stop() -> port free again.
// Exits non-zero on the first failed check.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNoItalianStrings, checkOneProductName, collectFiles } from "./check-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_HOST = "127.0.0.1";
const BOOT_TIMEOUT_MS = 30_000;
// Counted during the smoke test, reported with the other smoke-test lines.
let vendorAssets = 0;
const POLL_INTERVAL_MS = 250;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // `code` is null when the child was killed, e.g. by spawn's own timeout.
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// Runs an ESM snippet in a child process with its own agent dir, so the
// module-level constants that read PI_WEB_UI_AGENT_DIR never see the real
// ~/.pi/agent of whoever runs the suite. PI_CODING_AGENT_DIR points at the same
// dir: it is the one the pi library reads, so without it the SessionManager
// would still write its session files into the real ~/.pi/agent.
// PI_WEB_UI_TEST=1 is what makes PI_WEB_UI_AGENT_DIR honoured at all: outside
// test mode the override is ignored on purpose.
/**
 * @param {string} script
 * @param {{ timeout?: number }} [opts]
 */
async function runIsolated(script, { timeout } = {}) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-ui-verify-"));
  try {
    return await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      timeout,
      env: { ...process.env, PI_WEB_UI_TEST: "1", PI_WEB_UI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
  }
}

// docs/api.md is the API documentation, and this is what keeps it honest: the
// routes literally written in server.mjs's tables must match, one to one, the
// rows of the document. Both sides are read as text — importing server.mjs here
// would boot half the agent for three regexes.
// Only `/api/…` paths are compared: the page and its assets reach the table
// through spreads (PAGE_ROUTES, VENDOR_ROUTE) that no regex over this file can
// see, so the document describes them in prose instead of a row.
const TABLE_ROUTE_RE = /^\s*\["(GET|POST|PUT|DELETE)", "(\/api\/[^"]*)"/gm;
const DOC_ROUTE_RE = /^\|\s*`(GET|POST|PUT|DELETE) (\/api\/[^`]*)`/gm;

async function checkApiDocumented() {
  const [source, doc] = await Promise.all([
    readFile(path.join(ROOT, "server.mjs"), "utf8"),
    readFile(path.join(ROOT, "docs", "api.md"), "utf8"),
  ]);
  const collect = (re, text) => new Set([...text.matchAll(re)].map(([, method, p]) => `${method} ${p}`));
  const table = collect(TABLE_ROUTE_RE, source);
  // Before comparing: no route at all means the table changed shape and the
  // regex above stopped seeing it. Said here, it names the real cause instead
  // of reporting every documented route as stale.
  if (table.size === 0) throw new Error("no route found in server.mjs: the check is reading the wrong shape");
  const documented = collect(DOC_ROUTE_RE, doc);
  const missing = [...table].filter((route) => !documented.has(route));
  const stale = [...documented].filter((route) => !table.has(route));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `routes missing from docs/api.md:\n  ${missing.join("\n  ")}` : "",
        stale.length > 0 ? `routes documented but absent from the table:\n  ${stale.join("\n  ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return table.size;
}

// The desktop app must boot on a FIXED loopback port. Everything the UI
// remembers (filters, sort, grouping, theme, project tabs, sidebar width) lives
// in localStorage, which the browser engine keys by ORIGIN: back on an
// ephemeral port, every launch would open a brand-new empty store and the
// settings would silently reset themselves. Read as text — importing the
// Electron entry here would need Electron itself.
async function checkDesktopPortIsFixed() {
  const source = await readFile(path.join(ROOT, "electron", "main.mjs"), "utf8");
  const first = /startServer\(\{\s*port:\s*([^,\s]+)/.exec(source);
  if (!first) throw new Error("no startServer({ port: … }) call found in electron/main.mjs");
  if (first[1] === "0") {
    throw new Error("electron/main.mjs boots on an ephemeral port: the UI's saved settings would reset at every launch");
  }
  if (!source.includes("DESKTOP_PORT")) {
    throw new Error("electron/main.mjs no longer names DESKTOP_PORT: the fixed port is what keeps the page origin stable");
  }
  return first[1];
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

// Runs one of the project's gates in a child node process and rejects with
// everything it printed. These tools report their findings on stdout and only
// their own crashes on stderr: both streams are surfaced.
/**
 * @param {string[]} args
 * @param {string} failure how to name the gate in the error message
 */
function runGate(args, failure) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${failure}:\n${output.trim()}`));
    });
  }));
}

// Local bins, not shell names: the checks work the same on every platform.
/** @param {string[]} segments */
const localBin = (...segments) => path.join(ROOT, "node_modules", ...segments);

// Lint gate: ESLint recommended rules over the server-side sources.
const runLint = () => runGate([localBin("eslint", "bin", "eslint.js"), "."], "eslint failed");

// Type gate: tsc in checkJs mode over the files jsconfig.json includes. No
// emit, no .ts sources — the types live in JSDoc, next to the code.
const runTypeCheck = () =>
  runGate([localBin("typescript", "bin", "tsc"), "--noEmit", "-p", "jsconfig.json"], "tsc --noEmit failed");

// Unit tests run before the smoke test: they are cheaper and fail faster.
// A bare directory argument fails to resolve on Windows: use a glob.
const runUnitTests = () =>
  runGate(["--test", "test/*.test.mjs"], "unit tests failed (node --test test/)");

function findFreePort() {
  return /** @type {Promise<number>} */ (new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, SMOKE_HOST, () => {
      // A TCP server always gets an AddressInfo here; the string form is for
      // unix sockets, which this probe never uses.
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  }));
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
// script-src has no 'unsafe-inline' since the page logic moved to /app.js, and
// letting it back in would silently reopen the injection surface.
async function checkHtmlCsp(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}/`);
  const csp = res.headers.get("content-security-policy");
  if (!csp || !csp.includes("default-src 'none'")) {
    throw new Error(`GET /: Content-Security-Policy is "${csp}", expected a restrictive policy`);
  }
  const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  if (scriptSrc !== "script-src 'self'") {
    throw new Error(`GET /: CSP has "${scriptSrc}", expected exactly "script-src 'self'"`);
  }
}

// The page is useless without its two assets, and a wrong Content-Type is fatal
// under nosniff: the browser refuses the module and the UI stays blank.
const PAGE_ASSET_TYPES = {
  "/app.js": "text/javascript; charset=utf-8",
  "/app.css": "text/css; charset=utf-8",
};

async function checkPageAssets(port) {
  for (const [pathname, type] of Object.entries(PAGE_ASSET_TYPES)) {
    const res = await fetch(`http://${SMOKE_HOST}:${port}${pathname}`);
    if (res.status !== 200) throw new Error(`GET ${pathname} returned ${res.status}, expected 200`);
    const actual = res.headers.get("content-type");
    if (actual !== type) {
      throw new Error(`GET ${pathname}: Content-Type is "${actual}", expected "${type}"`);
    }
  }
}

// A request-target the URL parser refuses used to throw out of the 'request'
// listener and kill the process — in the desktop app, the whole window with it.
// It has to be a 400, and the server has to still be there afterwards.
async function checkMalformedTargetRejected(port) {
  const res = await fetch(`http://${SMOKE_HOST}:${port}//`);
  if (res.status !== 400) throw new Error(`GET // returned ${res.status}, expected 400`);
  const after = await fetch(`http://${SMOKE_HOST}:${port}/api/state`);
  if (after.status !== 200) {
    throw new Error(`GET /api/state after a malformed target returned ${after.status}: the server did not survive it`);
  }
}

// Every /vendor/ URL the page names must actually be served. A missing one is
// silent in the network tab but fatal in the page: a library that never loads
// takes the whole UI down with it (a failed ES import aborts its module, and a
// missing global strands every call site that needs it).
async function checkVendorAssets(port) {
  const sources = await Promise.all(
    ["public/index.html", "public/app.js"].map(async (rel) => ({
      rel,
      text: await readFile(path.join(ROOT, rel), "utf8"),
    })),
  );
  let count = 0;
  for (const { rel, text } of sources) {
    for (const [url] of text.matchAll(/\/vendor\/[\w@./-]+/g)) {
      const res = await fetch(`http://${SMOKE_HOST}:${port}${url}`);
      if (res.status !== 200) {
        throw new Error(`${rel} asks for ${url}, which the server answers with ${res.status}`);
      }
      count += 1;
    }
  }
  if (count === 0) throw new Error("no /vendor/ asset found in the page: the scan is broken, not the page");
  return count;
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
  const outside = encodeURIComponent(path.join(ROOT, "package.json"));
  const res = await fetch(`${origin}/api/sessions/${outside}/activate`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status !== 400) {
    throw new Error(`activating a file outside SESSIONS_DIR returned ${res.status}, expected 400`);
  }
}

// Same confinement on the fork route: an id that does not resolve must not slip
// through to useContext, which would silently fork the most recent chat around.
async function checkSessionForkConfined(port) {
  const origin = `http://${SMOKE_HOST}:${port}`;
  const outside = encodeURIComponent(path.join(ROOT, "package.json"));
  const res = await fetch(`${origin}/api/sessions/${outside}/fork`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ entryId: "whatever" }),
  });
  if (res.status !== 400) {
    throw new Error(`forking a file outside SESSIONS_DIR returned ${res.status}, expected 400`);
  }
}

// LAN access is off by default: a non-loopback Host must not get through, even
// on a plain GET (the request never reaches a route).
function checkLanHostRejected(port) {
  // fetch() refuses to override the Host header, so this one goes through the
  // raw http client.
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
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
  }));
}

async function smokeTest() {
  const port = await findFreePort();
  // The server rewrites its state files at boot (first-run archiving sweep), so
  // it must never see the real ~/.pi/agent of whoever runs the test suite.
  // PI_WEB_UI_AGENT_DIR moves this project's stores, PI_CODING_AGENT_DIR the
  // agent dir of the pi library where the SessionManager writes sessions, and
  // PI_WEB_UI_TEST=1 is what makes the first one honoured outside a real run.
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-ui-verify-"));
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
      PI_WEB_UI_TEST: "1",
      PI_WEB_UI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
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
    await checkPageAssets(port);
    vendorAssets = await checkVendorAssets(port);
    await checkMalformedTargetRejected(port);
    await checkLanHostRejected(port);
    await checkConfigSecretsRedacted(port);
    await checkMalformedJsonRejected(port);
    await checkInvalidStatusRejected(port);
    await checkSessionOpenConfined(port);
    await checkSessionForkConfined(port);
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
  const { code } = await runIsolated(script);
  if (code !== 0) throw new Error("an org id containing a path traversal was accepted");
}

// The path the desktop shell rides on: import the server, run it on an
// ephemeral loopback port, take it down and get the port back. The child is
// left to exit on its own — a clean exit is the assertion that stop() released
// every handle (listener, keep-alive sockets, idle sweep timer, agent runs),
// which is what "close the window, nothing survives" rests on. Electron itself
// is not needed, and not launched.
async function checkEmbeddedLifecycle() {
  const serverUrl = pathToFileURL(path.join(ROOT, "server.mjs")).href;
  const script = `
    import { createServer } from "node:net";
    const { startServer } = await import(${JSON.stringify(serverUrl)});
    const server = await startServer({ port: 0 });
    if (!Number.isInteger(server.port) || server.port <= 0) {
      throw new Error(\`port 0 did not yield an ephemeral port (got \${server.port})\`);
    }
    if (!server.url.includes(String(server.port))) {
      throw new Error(\`url \${server.url} does not point at port \${server.port}\`);
    }
    const res = await fetch(server.url);
    if (res.status !== 200) throw new Error(\`GET \${server.url} returned \${res.status}, expected 200\`);
    await res.arrayBuffer();
    await server.stop();
    await server.stop(); // idempotent: the shell may stop an already stopped server
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.on("error", (err) => reject(new Error(\`port \${server.port} still held after stop(): \${err.code}\`)));
      probe.listen(server.port, ${JSON.stringify(SMOKE_HOST)}, () => probe.close(resolve));
    });
  `;
  const { code, stderr } = await runIsolated(script, { timeout: BOOT_TIMEOUT_MS });
  if (code === 0) return;
  if (code === null) {
    throw new Error(
      `the embedded server kept the process alive for more than ${BOOT_TIMEOUT_MS}ms after stop()`,
    );
  }
  throw new Error(`embedded start/stop failed:\n${stderr.trim()}`);
}

async function main() {
  const fileCount = await checkSyntax();
  console.log(`✓ syntax: ${fileCount} .mjs file(s) parsed without errors`);
  // Both wording gates live in scripts/check-language.mjs: separate steps here,
  // separate lines in the output, one file to open when either one fires.
  const scanned = await checkNoItalianStrings();
  console.log(`✓ language: no known Italian words in ${scanned} source file(s)`);
  const named = await checkOneProductName();
  console.log(`✓ naming: no retired product name in ${named} source file(s)`);
  const routes = await checkApiDocumented();
  console.log(`✓ api docs: ${routes} route(s) in server.mjs match docs/api.md`);
  const desktopPort = await checkDesktopPortIsFixed();
  console.log(`✓ desktop: the app boots on a fixed port (${desktopPort}), so localStorage survives a restart`);
  await runLint();
  console.log("✓ lint: eslint passed");
  await runTypeCheck();
  console.log("✓ types: tsc --noEmit passed with checkJs over jsconfig.json");
  await checkOrgIdTraversalRejected();
  console.log("✓ validation: org id with a path traversal is rejected");
  await runUnitTests();
  console.log("✓ unit tests: node --test test/*.test.mjs passed");
  await checkEmbeddedLifecycle();
  console.log("✓ embedded: startServer({ port: 0 }) serves /, stop() frees the port, no handle left");
  const port = await smokeTest();
  console.log(`✓ smoke test: GET http://${SMOKE_HOST}:${port}/api/state -> 200`);
  console.log("✓ smoke test: POST with foreign Origin -> 403");
  console.log("✓ smoke test: responses carry nosniff and no-store");
  console.log("✓ smoke test: GET / carries a restrictive Content-Security-Policy");
  console.log("✓ smoke test: /app.js and /app.css are served with their own Content-Type");
  console.log(`✓ smoke test: ${vendorAssets} /vendor/ asset(s) named by the page are served`);
  console.log("✓ smoke test: POST with a malformed JSON body -> 400");
  console.log("✓ smoke test: GET with a malformed request target -> 400, server still serving");
  console.log("✓ smoke test: POST /api/status with a value outside the whitelist -> 400");
  console.log("✓ smoke test: GET with a LAN Host (lanAccess off) -> 403");
  console.log("✓ smoke test: secret values are redacted from /api/config");
  console.log("✓ smoke test: activating a chat outside the sessions directory -> 400");
  console.log("✓ smoke test: forking a chat outside the sessions directory -> 400");
  console.log("✓ smoke test: agent state isolated in a temporary PI_WEB_UI_AGENT_DIR + PI_CODING_AGENT_DIR");
}

main().catch((err) => {
  console.error(`✗ verify failed: ${err.message}`);
  process.exit(1);
});
