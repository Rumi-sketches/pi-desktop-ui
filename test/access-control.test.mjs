import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitAuthority,
  isLoopbackAuthority,
  isLoopbackPeer,
  originMatchesHost,
  readCookie,
  isSameOriginRequest,
  provesSameOrigin,
  classifyRequest,
  ACCESS_COOKIE,
} from "../access-control.mjs";

const PORT = 3141;
const TOKEN = "s3cret-token";
const matchesToken = (value) => value === TOKEN;

const LAN_PEER = "192.168.1.99";

function request({ method = "GET", headers = {}, search = "", remoteAddress = "127.0.0.1" } = {}) {
  return { method, headers, searchParams: new URLSearchParams(search), remoteAddress };
}

function policy({ lanAccess = false, matchesToken: tokenCheck = matchesToken } = {}) {
  return { port: PORT, lanAccess, matchesToken: tokenCheck };
}

test("splitAuthority parses hostname and port, IPv6 brackets kept", () => {
  assert.deepEqual(splitAuthority("localhost:3141"), { hostname: "localhost", port: "3141" });
  assert.deepEqual(splitAuthority("[::1]:3141"), { hostname: "[::1]", port: "3141" });
  assert.deepEqual(splitAuthority("example.com"), { hostname: "example.com", port: "" });
  assert.equal(splitAuthority(""), null);
  assert.equal(splitAuthority(null), null);
});

test("isLoopbackAuthority accepts loopback names on the given port only", () => {
  assert.equal(isLoopbackAuthority(`localhost:${PORT}`, PORT), true);
  assert.equal(isLoopbackAuthority(`127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isLoopbackAuthority(`[::1]:${PORT}`, PORT), true);
  assert.equal(isLoopbackAuthority(`localhost:${PORT + 1}`, PORT), false); // wrong port
  assert.equal(isLoopbackAuthority("localhost", PORT), false); // no port
  assert.equal(isLoopbackAuthority(`evil.example:${PORT}`, PORT), false);
});

test("originMatchesHost requires http(s) on the exact served authority", () => {
  assert.equal(originMatchesHost(`http://localhost:${PORT}`, `localhost:${PORT}`), true);
  assert.equal(originMatchesHost(`https://localhost:${PORT}`, `localhost:${PORT}`), true);
  assert.equal(originMatchesHost(`http://evil.example:${PORT}`, `localhost:${PORT}`), false);
  assert.equal(originMatchesHost(`ftp://localhost:${PORT}`, `localhost:${PORT}`), false);
  assert.equal(originMatchesHost("not a url", `localhost:${PORT}`), false);
});

test("readCookie extracts one cookie by name", () => {
  assert.equal(readCookie("a=1; pi_web_ui_access=tok; b=2", "pi_web_ui_access"), "tok");
  assert.equal(readCookie("a=1", "missing"), null);
  assert.equal(readCookie(undefined, "any"), null);
});

test("isSameOriginRequest: safe methods always pass", () => {
  assert.equal(isSameOriginRequest(request({ method: "GET" }), `localhost:${PORT}`), true);
  assert.equal(isSameOriginRequest(request({ method: "HEAD" }), `localhost:${PORT}`), true);
});

test("isSameOriginRequest: the three Sec-Fetch-Site branches", () => {
  const host = `localhost:${PORT}`;
  // same-origin passes outright
  const sameOrigin = request({ method: "POST", headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(isSameOriginRequest(sameOrigin, host), true);
  // none (direct navigation) passes only without an Origin header
  const direct = request({ method: "POST", headers: { "sec-fetch-site": "none" } });
  assert.equal(isSameOriginRequest(direct, host), true);
  // cross-site with a foreign Origin fails
  const crossSite = request({
    method: "POST",
    headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
  });
  assert.equal(isSameOriginRequest(crossSite, host), false);
});

test("isSameOriginRequest: Origin decides when Sec-Fetch-Site is absent", () => {
  const host = `localhost:${PORT}`;
  const good = request({ method: "POST", headers: { origin: `http://localhost:${PORT}` } });
  assert.equal(isSameOriginRequest(good, host), true);
  const bad = request({ method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(isSameOriginRequest(bad, host), false);
  const none = request({ method: "POST" });
  assert.equal(isSameOriginRequest(none, host), false);
});

// /api/usage?force=1 leans on this: a GET must earn the refresh, unlike the
// guard, which lets every safe method through.
test("provesSameOrigin: a GET gets no exemption", () => {
  const host = `localhost:${PORT}`;
  const headers = (extra) => request({ method: "GET", headers: extra });
  assert.equal(provesSameOrigin(headers({ "sec-fetch-site": "same-origin" }), host), true);
  assert.equal(provesSameOrigin(headers({ origin: `http://localhost:${PORT}` }), host), true);
  assert.equal(provesSameOrigin(headers({ "sec-fetch-site": "none" }), host), true);
  assert.equal(provesSameOrigin(headers({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), host), false);
  assert.equal(provesSameOrigin(headers({ origin: "https://evil.example" }), host), false);
  assert.equal(provesSameOrigin(headers({}), host), false);
});

test("classifyRequest: loopback GET is allowed", () => {
  const req = request({ headers: { host: `localhost:${PORT}` } });
  assert.equal(classifyRequest(req, policy()), "allow");
});

test("classifyRequest: non-loopback Host is denied when LAN access is off", () => {
  const req = request({ headers: { host: `192.168.1.50:${PORT}` } });
  assert.equal(classifyRequest(req, policy({ lanAccess: false })), "deny");
});

test("classifyRequest: non-loopback Host on the wrong port is denied", () => {
  const req = request({ headers: { host: `192.168.1.50:${PORT + 1}` } });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "deny");
});

test("isLoopbackPeer recognises loopback in all three notations", () => {
  assert.equal(isLoopbackPeer("127.0.0.1"), true);
  assert.equal(isLoopbackPeer("127.0.0.53"), true);
  assert.equal(isLoopbackPeer("::1"), true);
  assert.equal(isLoopbackPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeer(LAN_PEER), false);
  assert.equal(isLoopbackPeer("::ffff:192.168.1.99"), false);
  assert.equal(isLoopbackPeer(undefined), false);
  assert.equal(isLoopbackPeer(""), false);
});

test("classifyRequest: LAN peer with forged loopback Host and perfect CSRF headers is denied", () => {
  const req = request({
    method: "POST",
    remoteAddress: LAN_PEER,
    headers: { host: `localhost:${PORT}`, "sec-fetch-site": "same-origin" },
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "deny");
});

test("classifyRequest: LAN peer with forged loopback Host is denied when LAN access is off", () => {
  const req = request({
    remoteAddress: LAN_PEER,
    headers: { host: `localhost:${PORT}` },
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: false })), "deny");
});

test("classifyRequest: LAN peer with forged loopback Host and the cookie is allowed", () => {
  const req = request({
    remoteAddress: LAN_PEER,
    headers: {
      host: `localhost:${PORT}`,
      cookie: `${ACCESS_COOKIE}=${TOKEN}`,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "allow");
});

test("classifyRequest: foreign Origin on a POST is denied", () => {
  const req = request({
    method: "POST",
    headers: { host: `localhost:${PORT}`, origin: "https://evil.example" },
  });
  assert.equal(classifyRequest(req, policy()), "deny");
});

test("classifyRequest: valid ?k= on a LAN GET triggers the handshake", () => {
  const req = request({
    remoteAddress: LAN_PEER,
    headers: { host: `192.168.1.50:${PORT}` },
    search: `k=${TOKEN}`,
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "handshake");
});

test("classifyRequest: wrong ?k= from LAN is denied", () => {
  const req = request({
    remoteAddress: LAN_PEER,
    headers: { host: `192.168.1.50:${PORT}` },
    search: "k=wrong",
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "deny");
});

test("classifyRequest: LAN request with the access cookie is allowed", () => {
  const req = request({
    remoteAddress: LAN_PEER,
    headers: { host: `192.168.1.50:${PORT}`, cookie: `${ACCESS_COOKIE}=${TOKEN}` },
  });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "allow");
});

test("classifyRequest: LAN request without cookie nor token is denied", () => {
  const req = request({ remoteAddress: LAN_PEER, headers: { host: `192.168.1.50:${PORT}` } });
  assert.equal(classifyRequest(req, policy({ lanAccess: true })), "deny");
});

// Rotating the LAN token (POST /api/network {regenerate:true}) has to revoke
// the cookies already handed out: every verdict goes through matchesToken,
// which compares against the token as it is *now*. Cache the old token, or
// accept the mere presence of the cookie, and a device kicked off the LAN
// keeps its access forever.
test("classifyRequest: a cookie minted before a token rotation is denied", () => {
  let currentToken = TOKEN;
  const afterRotation = policy({ lanAccess: true, matchesToken: (value) => value === currentToken });
  const lanRequest = (headers) =>
    request({ remoteAddress: LAN_PEER, headers: { host: `192.168.1.50:${PORT}`, ...headers } });

  const oldCookie = lanRequest({ cookie: `${ACCESS_COOKIE}=${TOKEN}` });
  assert.equal(classifyRequest(oldCookie, afterRotation), "allow");

  currentToken = "rotated-token";

  assert.equal(classifyRequest(oldCookie, afterRotation), "deny");
  // The stale token is worthless in the query string too: no second handshake.
  const oldLink = request({
    remoteAddress: LAN_PEER,
    headers: { host: `192.168.1.50:${PORT}` },
    search: `k=${TOKEN}`,
  });
  assert.equal(classifyRequest(oldLink, afterRotation), "deny");

  // ...and the freshly issued one works, so the denial is the rotation, not a
  // malformed request.
  assert.equal(classifyRequest(lanRequest({ cookie: `${ACCESS_COOKIE}=${currentToken}` }), afterRotation), "allow");
});
