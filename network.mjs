/**
 * network.mjs — where this server listens, and who is allowed to reach it.
 *
 * LAN access is off by default: exposing an agent that runs commands on the
 * network is an explicit choice, and it is guarded by a token that lives in
 * `web-ui-network.json` (owner-only) and never travels in a log, in the address
 * bar or in a Referer header — the handshake moves it into an HttpOnly cookie
 * on first use.
 *
 * The listening address lives here too, and not in server.mjs, because
 * everything that reads it (the status shown in the settings panel, the access
 * URL, the request guard) is about reachability. startServer() is the only
 * writer: it calls setServerAddress() once the socket is bound, since `port: 0`
 * resolves to a real port only then.
 */
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PRODUCT_ID } from "./product.mjs";
import { ACCESS_COOKIE, ACCESS_PARAM, isLoopbackPeer } from "./access-control.mjs";
import { AGENT_DIR, jsonFile } from "./session-store.mjs";
import { send } from "./http.mjs";

export const DEFAULT_PORT = 3777;
const LOOPBACK_HOST = "127.0.0.1";
const ALL_INTERFACES_HOST = "0.0.0.0";
// The address is decided by startServer(), never at import time: it depends on
// the LAN access state (loopback only unless the user opted in, see
// resolveHost) and on the port the socket actually got.
let PORT = DEFAULT_PORT;
let HOST = LOOPBACK_HOST;
export const serverPort = () => PORT;
export const serverHost = () => HOST;
export function setServerAddress(port, host) {
  PORT = port;
  HOST = host;
}

// ---- LAN access (off by default) -------------------------------------------
const NETWORK_PATH = path.join(AGENT_DIR, "web-ui-network.json");
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours
// The file holds the LAN access token: owner-only. No-op on Windows.
const AGENT_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const defaultNetwork = () => ({ lanAccess: false, token: null });
const networkStore = jsonFile(NETWORK_PATH, {
  fallback: defaultNetwork,
  revive: (raw) =>
    raw && typeof raw === "object"
      ? {
          lanAccess: raw.lanAccess === true,
          token: typeof raw.token === "string" && raw.token ? raw.token : null,
        }
      : undefined,
  mode: SECRET_FILE_MODE,
  dirMode: AGENT_DIR_MODE,
});
let network = defaultNetwork();
export async function loadNetwork() {
  network = await networkStore.load();
}
async function saveNetwork() {
  await networkStore.save(network);
}
export const lanAccessEnabled = () => network.lanAccess;

// Every activation starts from a fresh token: turning access off invalidates
// the URLs already handed out.
export async function setLanAccess(enabled) {
  network.lanAccess = enabled;
  network.token = enabled ? newAccessToken() : null;
  await saveNetwork();
}

// False when there is nothing to regenerate: no LAN access, no token.
export async function regenerateAccessToken() {
  if (!network.lanAccess) return false;
  network.token = newAccessToken();
  await saveNetwork();
  return true;
}

function newAccessToken() {
  return randomBytes(32).toString("base64url");
}
// First non-loopback IPv4 address: only used to build the URL shown in
// settings, never to decide who is allowed in.
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}
export function networkStatus() {
  // Deliberately token-free: the URL that embeds the token is only handed out
  // by an explicit `reveal` POST, never by the default status response.
  return {
    lanAccess: network.lanAccess,
    ip: lanAddress(),
    port: Number(PORT),
    listening: HOST,
    restartRequired: network.lanAccess !== (HOST !== "127.0.0.1"),
  };
}
// The URL carries the token: it is the only way to get it to the other
// device, and it works once (then it becomes an HttpOnly cookie).
export function accessUrl() {
  const ip = lanAddress();
  // One read of network.token: the guard and the interpolation must never see
  // two different values (nor interpolate a null into the URL).
  const token = network.token;
  return network.lanAccess && ip && token ? `http://${ip}:${PORT}/?${ACCESS_PARAM}=${token}` : null;
}

// Loopback until LAN access is opened on purpose; an explicit override (HOST=…
// or options.host) wins. Binding beyond loopback with LAN access disabled would
// expose the agent with no token gate at all: refuse to start rather than start
// exposed. Throws instead of exiting, so an embedder can handle it.
export function resolveHost(hostOverride = null) {
  const host = hostOverride ?? (network.lanAccess ? ALL_INTERFACES_HOST : LOOPBACK_HOST);
  if (!network.lanAccess && host !== "localhost" && !isLoopbackPeer(host)) {
    throw new Error(
      `refusing to listen on ${host} while LAN access is disabled. ` +
        "Enable LAN access from the settings panel, or unset HOST.",
    );
  }
  return host;
}

// ---- request guard ---------------------------------------------------------
// The guard logic lives in access-control.mjs (pure and unit-tested); only the
// token check stays here, because it needs `crypto` and the `network` state.

// Constant-time comparison that also tolerates different lengths.
function secretEquals(candidate, secret) {
  if (typeof candidate !== "string" || typeof secret !== "string" || !secret) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const hasAccessToken = (value) => secretEquals(value, network.token ?? "");

// Move the token out of the URL and into an HttpOnly cookie, so it never stays
// in the address bar, in history or in a Referer header.
export function completeAccessHandshake(res, url) {
  // No token, no handshake: interpolating a null here would hand the peer a
  // `pi_web_ui_access=null` cookie, which is a credential nobody issued.
  const token = network.token;
  if (!token) return send(res, 403, { error: "forbidden origin" });
  const clean = new URL(url);
  clean.searchParams.delete(ACCESS_PARAM);
  res.writeHead(302, {
    Location: clean.pathname + clean.search,
    "Set-Cookie": `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ACCESS_COOKIE_MAX_AGE}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

// The URL to open on this machine. No token is appended: a loopback peer is
// trusted by the request guard (see access-control.mjs), and putting the token
// in the address bar is exactly what the cookie handshake exists to avoid. A
// non-loopback bind is only reachable with the token, so there it goes in.
// 0.0.0.0 is a bind address, not something a client can open: use loopback.
export function localUrl() {
  const reachable = HOST === ALL_INTERFACES_HOST || HOST === "localhost" ? LOOPBACK_HOST : HOST;
  const token = network.token;
  const needsToken = !isLoopbackPeer(reachable) && network.lanAccess && token;
  return `http://${reachable}:${PORT}/${needsToken ? `?${ACCESS_PARAM}=${token}` : ""}`;
}

// A denied remote peer is worth a log line (it may be a probe), but a port
// scan must not flood the terminal: at most one line per window, with a
// count of what was suppressed in between.
const REMOTE_DENY_LOG_MS = 5000;
let remoteDenyLogAt = 0;
let remoteDenySuppressed = 0;
export function warnRemoteDeny(req) {
  const now = Date.now();
  if (now - remoteDenyLogAt < REMOTE_DENY_LOG_MS) {
    remoteDenySuppressed++;
    return;
  }
  const suppressed = remoteDenySuppressed ? ` (+${remoteDenySuppressed} more suppressed)` : "";
  // remoteAddress is undefined once the socket is destroyed, and a log line
  // reading "from undefined" is worse than one that says so.
  const peer = req.socket.remoteAddress ?? "unknown peer";
  remoteDenyLogAt = now;
  remoteDenySuppressed = 0;
  console.warn(`${PRODUCT_ID}: denied remote request from ${peer} — ${req.method} ${req.url}${suppressed}`);
}
