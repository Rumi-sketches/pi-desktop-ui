/**
 * usage-tracker.mjs — reads *real* account usage limits directly from the
 * providers' own web apps (claude.ai / kimi.com), using session credentials
 * captured manually by the user from their browser DevTools.
 *
 * This is NOT a public/documented API. It replicates what the browser itself
 * does when you open the account's usage page. Endpoints can change without
 * notice; failures are reported to the caller instead of throwing.
 *
 * Credentials are stored locally in ~/.pi/agent/web-usage.json (never
 * committed, never sent anywhere except the provider's own endpoint).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(AGENT_DIR, "web-usage.json");
const TTL_MS = 45_000; // don't hammer the providers; UI polls faster than this

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

let cache = { anthropic: null, kimi: null };

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeConfig(cfg) {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/** Status without leaking secrets, for the settings page. */
export async function usageConfigStatus() {
  const cfg = await readConfig();
  return {
    anthropic: {
      configured: Boolean(cfg.anthropic?.orgId && cfg.anthropic?.cookie),
      orgId: cfg.anthropic?.orgId ?? "",
    },
    kimi: {
      configured: Boolean(cfg.kimi?.bearer),
    },
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// DevTools shortens long values *in the display* with a horizontal ellipsis; people
// copy the shortened text and end up with two cookies welded together. Catch it.
const ELLIPSIS_RE = /[\u2026]|\.\.\.(?=[A-Za-z0-9])/;

/**
 * Turn whatever the user pasted into `{ cookie, orgId, bearer }`.
 * Three accepted shapes, in order of preference:
 *   1. a `curl '...' -H 'Cookie: ...'` command (DevTools → Copy → Copy as cURL)
 *   2. the DevTools Cookies *table*: `name<TAB>"value"` on separate lines
 *   3. a plain `Cookie:` header value: `a=1; b=2`
 */
export function parsePastedCredentials(text) {
  let raw = String(text ?? "").trim();
  if (!raw) return {};
  const out = {};

  // "Copy as cURL (cmd/Windows)" quotes with ^" and continues lines with a
  // trailing ^. Dropping every caret turns it back into the POSIX shape.
  if (/\^"/.test(raw)) raw = raw.replace(/\^(.|\n)/gs, "$1");

  const url = raw.match(/https?:\/\/[^\s'"^\\]+/)?.[0];
  if (url) {
    out.url = url;
    out.orgId = url.match(/organizations\/([0-9a-f-]{36})/i)?.[1] ?? undefined;
  }
  if (!out.orgId) out.orgId = raw.match(/organizations\/([0-9a-f-]{36})/i)?.[1] ?? undefined;

  // 1. curl: every -H / -b argument, in either quoting style. The double-quoted
  //    branch must tolerate \" escapes (cookies like g_state carry JSON).
  const args = [...raw.matchAll(/(?:-H|--header|-b|--cookie)\s+(?:'([^']*)'|"((?:\\.|[^"])*)")/g)]
    .map((m) => (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim());
  const header = (name) => args.find((a) => a.toLowerCase().startsWith(name))?.slice(name.length).trim();

  out.bearer = header("authorization:")?.replace(/^Bearer\s+/i, "")
    ?? raw.match(/[Aa]uthorization:\s*Bearer\s+([\w.\-]+)/)?.[1]
    ?? (/^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(raw) ? raw : undefined);

  const fromCurl = header("cookie:")
    ?? args.find((a) => /(^|;\s*)sessionKey=/.test(a));
  if (fromCurl) {
    out.cookie = fromCurl;
    return out;
  }

  // 2. DevTools cookies table (tab- or multi-space-separated name / "value" pairs)
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = lines
    .map((l) => l.match(/^([\w.\-]+)[\t ]+["']?([^"']*)["']?$/))
    .filter(Boolean);
  if (pairs.length >= 2 && pairs.length === lines.length) {
    out.cookie = pairs.map((m) => `${m[1]}=${m[2].trim()}`).join("; ");
    return out;
  }

  // 3. plain Cookie header (possibly prefixed with "Cookie:")
  const flat = raw.replace(/^\s*[Cc]ookie:\s*/, "").replace(/\s*\n\s*/g, " ").trim();
  if (/^[\w.\-]+=/.test(flat)) out.cookie = flat;
  return out;
}

function cookieNames(cookie) {
  return new Set(cookie.split(";").map((c) => c.split("=")[0].trim()));
}

/** Throws a user-facing (Italian) message when the paste can't possibly work. */
function validate(provider, values) {
  if (provider === "anthropic") {
    const { cookie, orgId } = values;
    if (!cookie) throw new Error(values.orgId
      ? "Ho trovato l'org id ma nessun cookie: hai incollato solo l'URL. Serve l'intero comando: tasto destro sulla richiesta → Copy → Copy as cURL."
      : "Non ho trovato nessun cookie nel testo incollato. Usa DevTools → Network → tasto destro sulla richiesta 'usage' → Copy → Copy as cURL.");
    if (ELLIPSIS_RE.test(cookie)) throw new Error("Il cookie è troncato (contiene '…'): è il testo abbreviato che DevTools mostra a schermo, non il valore vero. Usa Copy as cURL (bash).");
    if (!cookieNames(cookie).has("sessionKey")) throw new Error("Manca il cookie 'sessionKey', che è quello che autentica: senza, claude.ai risponde vuoto. Copia la richiesta con Copy as cURL (bash).");
    if (!orgId) throw new Error("Manca l'org id. Se incolli il comando cURL viene ricavato da solo dall'URL; altrimenti scrivilo a mano.");
    if (!UUID_RE.test(orgId)) throw new Error(`L'org id '${orgId}' non è un UUID valido (formato: 8-4-4-4-12 caratteri esadecimali).`);
  }
  if (provider === "kimi") {
    const { bearer } = values;
    if (!bearer) throw new Error("Non ho trovato nessun token. Usa DevTools → Network → tasto destro sulla richiesta 'GetUsages' → Copy → Copy as cURL (bash).");
    if (ELLIPSIS_RE.test(bearer)) throw new Error("Il token è troncato (contiene '…'). Usa Copy as cURL (bash).");
    if (bearer.split(".").length !== 3) throw new Error("Il token non ha la forma di un JWT (tre parti separate da '.'). Copia solo il valore dopo 'Bearer '.");
  }
}

/**
 * provider: 'anthropic' | 'kimi'.
 * `values.paste` (free-form) is parsed and merged under the explicit fields,
 * which still win if provided (e.g. an org id typed by hand).
 */
export async function saveUsageConfig(provider, values) {
  if (!["anthropic", "kimi"].includes(provider)) throw new Error("unknown provider");
  const { paste, ...explicit } = values ?? {};
  const parsed = paste ? parsePastedCredentials(paste) : {};
  const merged = { ...parsed, ...explicit };
  const clean = Object.fromEntries(
    Object.entries(merged)
      .filter(([k, v]) => k !== "url" && typeof v === "string" && v.trim() !== "")
      .map(([k, v]) => [k, v.trim()]),
  );
  const cfg = await readConfig();
  const next = { ...(cfg[provider] ?? {}), ...clean };
  validate(provider, next);
  cfg[provider] = next;
  await writeConfig(cfg);
  cache[provider] = null; // force refetch with the new creds
  return next;
}

export async function clearUsageConfig(provider) {
  if (!["anthropic", "kimi"].includes(provider)) throw new Error("unknown provider");
  const cfg = await readConfig();
  delete cfg[provider];
  await writeConfig(cfg);
  cache[provider] = null;
}

function fresh(entry) {
  return entry && Date.now() - entry.at < TTL_MS;
}

/** Anthropic (claude.ai) — GET /api/organizations/{orgId}/usage */
export async function fetchAnthropicUsage({ force = false } = {}) {
  if (!force && fresh(cache.anthropic)) return cache.anthropic.data;
  const cfg = await readConfig();
  const { orgId, cookie } = cfg.anthropic ?? {};
  if (!orgId || !cookie) {
    const data = { configured: false };
    cache.anthropic = { at: Date.now(), data };
    return data;
  }
  let data;
  try {
    // claude.ai sits behind Cloudflare bot management that fingerprints the
    // TLS/HTTP2 handshake: Node's built-in fetch (undici) gets blocked (403)
    // even with a fully valid cookie, while curl's handshake passes through
    // fine. So we shell out to the system curl for this one request.
    const { stdout } = await execFileP(
      "curl",
      [
        "-s",
        "--max-time", "10",
        "-H", `Cookie: ${cookie}`,
        "-H", "Accept: application/json",
        "-H", `User-Agent: ${UA}`,
        `https://claude.ai/api/organizations/${orgId}/usage`,
      ],
      // windowsHide: this runs on a 30s poll — without it every call flashes a
      // console window on screen.
      { maxBuffer: 2 * 1024 * 1024, windowsHide: true },
    );
    if (stdout.trim().startsWith("<")) {
      data = { configured: true, error: "Cloudflare ha bloccato la richiesta (challenge) — riprova tra poco o aggiorna il cookie" };
    } else if (!stdout.trim()) {
      data = { configured: true, error: "risposta vuota — sessione probabilmente scaduta, aggiorna il cookie" };
    } else {
      const j = JSON.parse(stdout);
      const fiveHour = j.five_hour ?? null;
      data = {
        configured: true,
        fetchedAt: new Date().toISOString(),
        fiveHour: fiveHour && {
          percent: fiveHour.utilization ?? null,
          resetsAt: fiveHour.resets_at ?? null,
        },
        sevenDay: j.seven_day && { percent: j.seven_day.utilization ?? null, resetsAt: j.seven_day.resets_at ?? null },
        limits: (j.limits ?? []).map((l) => ({
          kind: l.kind,
          percent: l.percent,
          severity: l.severity,
          resetsAt: l.resets_at,
          isActive: l.is_active,
        })),
        raw: j,
      };
    }
  } catch (err) {
    data = { configured: true, error: String(err?.message ?? err) };
  }
  cache.anthropic = { at: Date.now(), data };
  return data;
}

/** Kimi (kimi.com) — POST /apiv2/kimi.gateway.billing.v1.BillingService/GetUsages */
export async function fetchKimiUsage({ force = false } = {}) {
  if (!force && fresh(cache.kimi)) return cache.kimi.data;
  const cfg = await readConfig();
  const { bearer, body } = cfg.kimi ?? {};
  if (!bearer) {
    const data = { configured: false };
    cache.kimi = { at: Date.now(), data };
    return data;
  }
  let data;
  try {
    const res = await fetch("https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body: body && body.trim() ? body : JSON.stringify({ scope: ["FEATURE_CODING"] }),
    });
    if (!res.ok) {
      data = { configured: true, error: `HTTP ${res.status}${res.status === 401 ? " — token scaduto, aggiornalo" : ""}` };
    } else {
      const j = await res.json();
      // usages[].detail = longer-window quota (resets in ~days, effectively "weekly");
      // usages[].limits[] = shorter rolling windows (e.g. 300min = 5h), same shape as
      // Anthropic's five_hour. We surface both so the UI can pick what fits.
      const usages = (j.usages ?? []).map((u) => ({
        scope: u.scope,
        period: {
          limit: Number(u.detail?.limit ?? NaN),
          used: Number(u.detail?.used ?? NaN),
          remaining: Number(u.detail?.remaining ?? NaN),
          resetsAt: u.detail?.resetTime ?? null,
        },
        windows: (u.limits ?? []).map((w) => ({
          durationMinutes: w.window?.duration ?? null,
          limit: Number(w.detail?.limit ?? NaN),
          used: Number(w.detail?.used ?? NaN),
          remaining: Number(w.detail?.remaining ?? NaN),
          resetsAt: w.detail?.resetTime ?? null,
        })),
      }));
      const totalQuota = j.totalQuota
        ? {
            limit: Number(j.totalQuota.limit ?? NaN),
            used: Number(j.totalQuota.used ?? NaN),
            remaining: Number(j.totalQuota.remaining ?? NaN),
          }
        : null;
      data = { configured: true, fetchedAt: new Date().toISOString(), usages, totalQuota, raw: j };
    }
  } catch (err) {
    data = { configured: true, error: String(err?.message ?? err) };
  }
  cache.kimi = { at: Date.now(), data };
  return data;
}

export async function fetchAllUsage({ force = false } = {}) {
  const [anthropic, kimi] = await Promise.all([
    fetchAnthropicUsage({ force }),
    fetchKimiUsage({ force }),
  ]);
  return { anthropic, kimi };
}
