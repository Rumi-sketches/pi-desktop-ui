/**
 * http.mjs — the plumbing every route sits on.
 *
 * Four things live here and nothing else: the request/response helpers (body
 * parsing with a cap, JSON answers, the security headers), the single write
 * point of every SSE stream, the router that turns a `[method, path, handler]`
 * table into a dispatch decision, and the two static-file surfaces of the page
 * (its own assets and the vendored browser libraries).
 *
 * No agent, no session, no persisted state: this module knows about HTTP only,
 * which is why it can be exercised without booting a server.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PRODUCT_ID } from "./product.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A value that is present and means something: the shape most endpoints ask
// of the fields they read from a JSON body.
export const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

// hosts every chat: the body is capped. 32 MB covers the base64 images that
// /api/prompt legitimately carries.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {Error & { status: number }} HttpError an error carrying the status
 *   the request it aborted must be answered with.
 */

/**
 * @param {number} status
 * @param {string} message
 * @returns {HttpError}
 */
export function httpError(status, message) {
  const err = /** @type {HttpError} */ (new Error(message));
  err.status = status;
  return err;
}

export async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

// Applied to every dynamic response: the payloads carry chat content, so they
// must never be sniffed as another type nor cached by an intermediary.
// Locks the HTML page down to same-origin resources. The page carries no inline
// script (it lives in public/app.js), so script-src stays on 'self' alone;
// 'unsafe-inline' survives on style-src for the few inline style attributes.
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export function send(res, code, data, type = "application/json; charset=utf-8") {
  // Defensive: a handler that already sent a response (e.g. /api/restart sends
  // 200 then does risky follow-up work) must never crash the whole process by
  // trying to write headers twice if that follow-up throws.
  if (res.headersSent) {
    console.error(`${PRODUCT_ID}: tried to send twice on the same response (code ${code}), ignored`);
    return;
  }
  res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

// The normalized failure shape: `{ error: { code, message } }` with a 4xx.
// `code` is for the program (stable, snake_case), `message` for the human.
// Only the endpoints that used to answer a failure with 200 speak it — the
// rest of the API still answers the flat `{ error: "message" }`, and the page
// reads both (see errorInfo() in public/app.js).
// `details` is for the rare failure the page has to *do* something with rather
// than only show — the number of terminals a restart would close, say. It rides
// inside the error object so the payload keeps carrying nothing but `error`.
/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export function sendError(res, status, code, message, details) {
  return send(res, status, { error: { code, message, ...details } });
}

// ---- server-sent events ----------------------------------------------------
// One write point for every SSE stream of the project (see the SSE entry in
// DECISIONS.md). An SSE response outlives the request that
// opened it: the browser can vanish at any moment, and a write on the corpse
// either throws or — worse — emits an asynchronous `error` on a response with
// no listener, which is an uncaught exception that takes the whole process
// down with nothing in the logs.

// A comment line: EventSource ignores it, but it keeps a proxy, a NAT or an
// antivirus from dropping a socket that carried nothing for minutes.
export const SSE_PING = ": ping\n\n";
export const SSE_PING_MS = 15_000;

/**
 * The only place an SSE stream is written to.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} chunk raw SSE text, framing included.
 * @returns {boolean} false when the response is already gone.
 */
export function sseWrite(res, chunk) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(chunk);
  return true;
}

/**
 * One `data:` frame. Payloads travel as JSON because chat content and terminal
 * output carry newlines, which the SSE framing would otherwise eat.
 *
 * An `id` makes the frame resumable: the browser remembers the last one it saw
 * and sends it back as `Last-Event-ID` when it reconnects. Only finite numbers
 * are accepted, which is also what keeps a newline out of the id line and the
 * framing intact.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} event
 * @param {number} [id] the offset this frame brings the client to
 * @returns {boolean} false when the response is already gone.
 */
export function sseSend(res, event, id) {
  const head = typeof id === "number" && Number.isFinite(id) ? `id: ${id}\n` : "";
  return sseWrite(res, `${head}data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Open a stream: the headers, the socket options every SSE here wants, the
 * error listener that keeps a dead client from killing the server, and the
 * reconnection delay the browser honours on its own.
 *
 * @param {import("node:http").ServerResponse} res
 */
export function openSseStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    // tells nginx and friends not to buffer the stream
    "X-Accel-Buffering": "no",
  });
  // These frames are small and latency-sensitive, and the socket must outlive
  // a long silent turn of the agent or an idle terminal.
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  // Half of the rule: the guard above cannot see a socket that dies between
  // the check and the flush, and that failure surfaces here, asynchronously.
  res.on("error", () => {});
  sseWrite(res, "retry: 1000\n\n");
}

// ---- vendored browser libraries --------------------------------------------
// marked, highlight.js, DOMPurify and xterm.js are served from node_modules instead of a CDN, so
// the UI works offline and no third party sees the traffic of a page that drives an
// agent. Only the sub-trees listed here are reachable.
const VENDOR_PREFIX = "/vendor/";
const VENDOR_ROOT = path.join(__dirname, "node_modules");
// highlight.js comes from @highlightjs/cdn-assets, not from the `highlight.js`
// package: the latter ships only CommonJS under lib/ and ES shims that re-import
// it, which no browser can load. The cdn-assets build is the browser one.
const VENDOR_ALLOWED = [
  "marked/lib/",
  "@highlightjs/cdn-assets/highlight.min.js",
  "@highlightjs/cdn-assets/styles/",
  "dompurify/dist/",
  // the integrated terminals: the UMD builds (globals `Terminal` and
  // `FitAddon`), not the .mjs ones — the page has no bundler.
  "@xterm/xterm/lib/",
  "@xterm/xterm/css/",
  "@xterm/addon-fit/lib/",
];
const VENDOR_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function vendorFilePath(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(VENDOR_PREFIX.length));
  } catch {
    // A malformed percent-escape (URIError) is a bad request for a file that
    // cannot exist: answer like any other miss instead of blowing up into a 500.
    return null;
  }
  if (!VENDOR_ALLOWED.some((prefix) => rel.startsWith(prefix))) return null;
  if (!Object.hasOwn(VENDOR_TYPES, path.extname(rel))) return null;
  const file = path.resolve(VENDOR_ROOT, rel);
  // Defence in depth: a crafted ".." must never escape node_modules.
  if (file !== VENDOR_ROOT && !file.startsWith(VENDOR_ROOT + path.sep)) return null;
  return file;
}

async function serveVendor(res, pathname) {
  const file = vendorFilePath(pathname);
  if (!file) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": VENDOR_TYPES[path.extname(file)],
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

// ---- page assets -----------------------------------------------------------
// The page ships as three files (index.html + app.js + app.css) so the HTML can
// carry a CSP without 'unsafe-inline'. This is a fixed whitelist, not a static
// file server rooted at public/: the pathname is a key, never a path fragment,
// so no traversal is possible.
const PUBLIC_DIR = path.join(__dirname, "public");
const PAGE_ASSETS = {
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

// Not cached, unlike /vendor: these two change with every release of the UI,
// and a stale app.js against a fresh server is a bug report nobody can explain.
async function servePageAsset(res, asset) {
  try {
    const body = await readFile(path.join(PUBLIC_DIR, asset.file));
    res.writeHead(200, { "Content-Type": asset.type, ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

// ---- the page itself -------------------------------------------------------
async function handleIndex({ res }) {
  const html = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": HTML_CSP,
    ...SECURITY_HEADERS,
  });
  return res.end(html);
}

// Adapters: the two static-file helpers take the pieces they need, while a
// route handler is always called with the request bag.
async function handlePageAsset({ res, url }) {
  return servePageAsset(res, PAGE_ASSETS[url.pathname]);
}

async function handleVendorFile({ res, url }) {
  return serveVendor(res, url.pathname);
}

// The static part of the route table, ready to be spread into it: the page, its
// two assets, and the sub-tree of vendored libraries (a prefix route, since
// there the pathname is data for the handler instead of a key).
export const PAGE_ROUTES = [
  ["GET", "/", handleIndex],
  ...Object.keys(PAGE_ASSETS).map((pathname) => ["GET", pathname, handlePageAsset]),
];
export const VENDOR_ROUTE = ["GET", VENDOR_PREFIX, handleVendorFile];

// ---- router ----------------------------------------------------------------
// path → (method → handler), built once at boot. The two-level shape is what
// lets dispatch tell "unknown path" (404) from "known path, wrong verb" (405).
function buildRouteTable(routes) {
  const table = new Map();
  for (const [method, pathname, handler] of routes) {
    const byMethod = table.get(pathname) ?? new Map();
    if (byMethod.has(method)) throw new Error(`${PRODUCT_ID}: duplicate route ${method} ${pathname}`);
    byMethod.set(method, handler);
    table.set(pathname, byMethod);
  }
  return table;
}

// Patterns are pre-split at boot and grouped by path, for the same reason the
// exact table is a two-level map: a parametric path called with the wrong verb
// deserves the same accurate 405 as any other.
function buildParamRoutes(routes) {
  const byPattern = new Map();
  for (const [method, pattern, handler] of routes) {
    const compiled = byPattern.get(pattern) ?? { segments: pattern.split("/"), byMethod: new Map() };
    if (compiled.byMethod.has(method)) throw new Error(`${PRODUCT_ID}: duplicate route ${method} ${pattern}`);
    compiled.byMethod.set(method, handler);
    byPattern.set(pattern, compiled);
  }
  return [...byPattern.values()];
}

// A session id is a file path, so the client percent-encodes it. A malformed
// escape is the caller's problem, not a crash: the raw segment flows on and the
// handler rejects it like any other bad value.
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// null when the pattern does not apply, otherwise the captured `:name` values.
function matchSegments(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (const [i, expected] of pattern.entries()) {
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeSegment(segments[i]);
    else if (expected !== segments[i]) return null;
  }
  return params;
}

// HEAD is answered by the GET handler: node suppresses the body of a HEAD
// response on its own, so the headers come out right and nothing leaks.
function routingMethod(method) {
  return method === "HEAD" ? "GET" : method;
}

// The verbs a path really answers, header-ready. Sorted so the value is stable
// (and so HEAD lands next to the GET it rides on).
function allowHeader(methods) {
  const supported = [...methods];
  if (supported.includes("GET")) supported.push("HEAD");
  return supported.sort().join(", ");
}

export function sendMethodNotAllowed(res, methods) {
  const allow = allowHeader(methods);
  res.setHeader("Allow", allow);
  return send(res, 405, { error: `method not allowed, try: ${allow}` });
}

/**
 * Compile the three route tables into the single function dispatch asks.
 * Duplicates throw here, at boot, rather than shadowing each other at runtime.
 *
 * @param {object} tables
 * @param {any[][]} tables.routes exact `[method, path, handler]` triples.
 * @param {any[][]} [tables.paramRoutes] patterns with `:name` segments.
 * @param {any[][]} [tables.prefixRoutes] sub-trees, matched by path prefix.
 * @returns {(pathname: string, method: string) => RouteHit|RouteVerbMismatch|null}
 *   a {@link RouteHit} when the request can be served, a {@link RouteVerbMismatch}
 *   when the path exists but not for this verb, and null when nothing matches (404).
 *
 * @typedef {{ handler: Function, params?: Record<string,string> }} RouteHit
 *   the handler to call, with the `:name` segments a pattern route captured.
 * @typedef {{ allow: string[] }} RouteVerbMismatch
 *   the verbs that path does answer, for the `Allow` header of the 405.
 */
export function createRouter({ routes, paramRoutes = [], prefixRoutes = [] }) {
  const exact = buildRouteTable(routes);
  const patterns = buildParamRoutes(paramRoutes);

  return function matchRoute(pathname, verb) {
    const method = routingMethod(verb);
    const byMethod = exact.get(pathname);
    if (byMethod) {
      const handler = byMethod.get(method);
      return handler ? { handler } : { allow: [...byMethod.keys()] };
    }
    const segments = pathname.split("/");
    for (const route of patterns) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      const handler = route.byMethod.get(method);
      return handler ? { handler, params } : { allow: [...route.byMethod.keys()] };
    }
    for (const [routeMethod, prefix, handler] of prefixRoutes) {
      if (!pathname.startsWith(prefix)) continue;
      return routeMethod === method ? { handler } : { allow: [routeMethod] };
    }
    return null;
  };
}
