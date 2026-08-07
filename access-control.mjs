// Request guard, extracted from server.mjs so it can be unit-tested.
// The UI drives a coding agent, so a stray request from any web page must never
// reach it. Two attacks are blocked before routing:
//   - DNS rebinding: the `Host` header must be a loopback name on our port;
//   - CSRF: state-changing methods must prove they are same-origin.
// Everything here is pure: no node:http types, no global state. Token checks
// are delegated to the `matchesToken` callback in the policy, so the
// constant-time comparison and the token itself stay in server.mjs.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export const ACCESS_COOKIE = "pi_web_ui_access";
export const ACCESS_PARAM = "k";

// Splits a `Host`/origin authority into hostname + port, IPv6 brackets kept.
export function splitAuthority(authority) {
  if (typeof authority !== "string" || !authority) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority.trim());
  if (!match) return null;
  return { hostname: match[1].toLowerCase(), port: match[2] ?? "" };
}

export function isLoopbackAuthority(authority, port) {
  const parsed = splitAuthority(authority);
  if (!parsed) return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname) && parsed.port === String(port);
}

// True when the TCP peer itself is the local machine. This is the only
// trustworthy signal: every header, `Host` included, is client-supplied.
export function isLoopbackPeer(remoteAddress) {
  if (typeof remoteAddress !== "string" || !remoteAddress) return false;
  const address = remoteAddress.toLowerCase();
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return ipv4.startsWith("127.");
}

export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

// An Origin is acceptable only if it is http(s) on the very authority we serve.
export function originMatchesHost(origin, hostHeader) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.host.toLowerCase() === String(hostHeader).trim().toLowerCase();
}

// True when the request proves it comes from our own page (CSRF check).
// `request` is a plain descriptor: { method, headers }.
export function isSameOriginRequest(request, hostHeader) {
  if (SAFE_METHODS.has(request.method)) return true;

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "same-origin") return true;

  const origin = request.headers.origin;
  if (origin) return originMatchesHost(origin, hostHeader);
  // No Origin at all: only a direct navigation (Sec-Fetch-Site: none) qualifies.
  return fetchSite === "none";
}

// Verdict for one request: "allow" (route it), "handshake" (a valid ?k= arrived:
// turn it into a cookie and redirect to a clean URL) or "deny" (403).
// `request` is { method, headers, searchParams, remoteAddress }; `policy` is
// { port, lanAccess, matchesToken } with matchesToken a callback.
// Trust comes from the socket peer, never from the forgeable `Host` header:
// a remote peer must prove the token no matter what `Host` claims. The `Host`
// check stays *in addition* for local peers, as a DNS-rebinding defense.
export function classifyRequest(request, policy) {
  const hostHeader = request.headers.host;
  // A remote peer must always earn access; a local peer only when its `Host`
  // is not our loopback authority (DNS rebinding).
  if (!isLoopbackPeer(request.remoteAddress) || !isLoopbackAuthority(hostHeader, policy.port)) {
    // Acceptable only on the port we serve, with LAN access explicitly
    // enabled, and with the token proven.
    const parsed = splitAuthority(hostHeader);
    if (!parsed || parsed.port !== String(policy.port)) return "deny";
    if (!policy.lanAccess) return "deny";
    if (SAFE_METHODS.has(request.method) && policy.matchesToken(request.searchParams.get(ACCESS_PARAM))) {
      return "handshake";
    }
    if (!policy.matchesToken(readCookie(request.headers.cookie, ACCESS_COOKIE))) return "deny";
  }
  return isSameOriginRequest(request, hostHeader) ? "allow" : "deny";
}
