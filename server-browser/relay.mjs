// Relay for the browser-prompt signed-in Server browser: the only way into the neko desktop (the
// owner's signed-in Chromium) from outside Docker. It runs in its own container, published only on
// the daemon host's Tailscale address (or 127.0.0.1), and talks to neko on the stack's internal
// network. It does three things:
//   1. Owner login with the plugin's key: Paseo hands the owner a link whose URL fragment holds a
//      one-time ticket signed with this relay start's key (never in a query string, so never in
//      logs). The page at /bp/open posts it to /bp/session; the relay checks it (signature, expiry,
//      used once), logs in to neko as a regular member (watch and take control, no admin rights) with
//      a generated password the owner never sees, and
//      sets an HttpOnly, SameSite=Strict cookie with a random name, scoped to a random path prefix
//      of this relay start (the viewer lives under it), valid 2 hours and 20 minutes without use,
//      and bound to the peer address. neko's own token never reaches the browser: the relay adds
//      it to every request it forwards. Not an admin: neko's client then neither shows nor calls its
//      admin actions (room locks and settings, broadcast, kicking members), which the relay refuses
//      anyway. Only the relay's own service login (screen size, control state and reset) is an admin.
//   2. A narrow allowlist: neko's web client files, the WebSocket and the few API routes the client
//      needs to watch and take control. Everything else (member and session management, uploads,
//      file transfer, broadcast, metrics, health, debug) is refused. Host and Origin are checked on
//      every request (DNS rebinding, cross-site WebSocket).
//   3. WebRTC over ICE-TCP: a plain TCP forward of the mux port to neko.
//   4. Takeover state for the run's agent: it polls neko's control state and answers GET /control
//      on an unpublished port (8081) on the stack's networks, so the run's MCP filter refuses tool
//      calls while the owner holds control. With Bitwarden in the browser (lockOnRelease), the run
//      also stays paused after every takeover until the daemon has locked the vault: from the
//      relay's start, after control is released or reset, and when the last viewer leaves, until
//      the daemon confirms the lock for that release (POST /bp/locked with the status token).
// Node's standard library only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";

export const TICKET_VERSION = "v1";
/** A ticket is valid for at most this long after it was issued (the link in the app's history dies with it). */
export const TICKET_MAX_TTL_S = 600;
export const TICKET_PURPOSES = ["login", "takeover"];
/** Prefix of the session cookie's name; each relay start adds a random part. */
export const SESSION_COOKIE = "bp_viewer";
/** A viewer session ends this long after it started ... */
export const SESSION_TTL_MS = 2 * 60 * 60_000;
/** ... and after this long without a request or viewer input. */
export const SESSION_IDLE_MS = 20 * 60_000;
export const MAX_SESSIONS = 32;
/**
 * A refused ticket is answered after this delay. No lockout: with rootless Docker every client has
 * the port forwarder's address, so a lockout would lock the owner out too, and an HMAC-SHA256 ticket
 * cannot be guessed anyway.
 */
export const BAD_TICKET_DELAY_MS = 500;
export const BLOCKED_TEXT = "Blocked by the browser-prompt relay.";
/**
 * The web app manifest neko's page links to. Browsers fetch it without cookies (Safari/WebKit does,
 * so it never had a session), so the relay answers it itself under the viewer prefix, session or
 * not: a constant, nothing of neko's.
 */
export const MANIFEST = JSON.stringify({ name: "Signed-in browser", short_name: "Signed-in browser", display: "browser", background_color: "#111111", theme_color: "#19bd9c" });

const TICKET = /^v1\.(\d{10})\.([A-Za-z0-9_-]{16,64})\.(login|takeover)\.([A-Za-z0-9_-]{43})$/;

function mac(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `v1.<exp>.<nonce>.<purpose>.<hmac>`: what the plugin puts in the viewer link's fragment. */
export function signTicket(secret, { exp, nonce, purpose }) {
  const payload = `${TICKET_VERSION}.${exp}.${nonce}.${purpose}`;
  return `${payload}.${mac(secret, payload)}`;
}

/**
 * Checks a ticket: shape, signature (constant time), not expired, not valid for longer than
 * TICKET_MAX_TTL_S. `{ ok: true, nonce, exp, purpose }` or `{ ok: false, reason }`. Whether the
 * nonce was used before is the caller's check.
 */
export function verifyTicket(secret, ticket, nowS = Math.floor(Date.now() / 1000)) {
  const match = TICKET.exec(String(ticket ?? ""));
  if (!match || !secret) return { ok: false, reason: "malformed" };
  const [, expText, nonce, purpose, given] = match;
  const expected = mac(secret, `${TICKET_VERSION}.${expText}.${nonce}.${purpose}`);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  const exp = Number(expText);
  if (exp <= nowS) return { ok: false, reason: "expired" };
  if (exp > nowS + TICKET_MAX_TTL_S) return { ok: false, reason: "too long" };
  return { ok: true, nonce, exp, purpose };
}

/** `name=value` pairs of a Cookie header. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Origins (scheme://host[:port]) the owner's viewer is served from; anything else is dropped. */
export function parseOrigins(text) {
  const out = [];
  for (const raw of String(text ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "null") out.push(url.origin);
    } catch {
      // not an origin
    }
  }
  return [...new Set(out)];
}

/** The Host values those origins are reached with. */
export function hostsOf(origins) {
  return [...new Set(origins.map((origin) => new URL(origin).host.toLowerCase()))];
}

const STATIC_PATH =
  /^\/$|^\/index\.html$|^\/assets\/(?:[A-Za-z0-9_-]{1,50}\/)?[A-Za-z0-9._-]{1,200}$|^\/locales\/[A-Za-z0-9._/-]{1,200}$|^\/[A-Za-z0-9._-]{1,100}\.(png|ico|json|mp3|xml|svg|webmanifest|txt)$/;
const API_ROUTES = [
  ["GET", /^\/api\/whoami$/],
  ["GET", /^\/api\/oauth\/config$/],
  ["GET", /^\/api\/room\/settings$/],
  ["GET", /^\/api\/room\/screen$/],
  ["GET", /^\/api\/room\/screen\/configurations$/],
  ["POST", /^\/api\/room\/screen$/],
  ["GET", /^\/api\/room\/control$/],
  ["POST", /^\/api\/room\/control\/(take|release|request|reset)$/],
  ["POST", /^\/api\/room\/control\/give\/[A-Za-z0-9_-]{1,64}$/],
  ["GET", /^\/api\/room\/keyboard\/(map|modifiers)$/],
  ["POST", /^\/api\/room\/keyboard\/(map|modifiers)$/],
];

/**
 * What a request to neko may be: `static` (the web client's files), `api` (an allowed route), `ws`
 * (the WebSocket), `logout` (handled by the relay), or null (refused). Path traversal and encoded
 * paths are refused outright.
 */
export function classifyRequest(method, pathname) {
  const path = String(pathname ?? "");
  if (path.includes("..") || path.includes("%") || path.includes("//") || path.includes("\\")) return null;
  if ((method === "GET" || method === "HEAD") && STATIC_PATH.test(path)) return "static";
  if (method === "GET" && path === "/api/ws") return "ws";
  if (method === "POST" && path === "/api/logout") return "logout";
  for (const [allowed, pattern] of API_ROUTES) if (method === allowed && pattern.test(path)) return "api";
  return null;
}

/** Request headers passed on to neko; cookies, credentials and forwarding headers never are. */
const FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "accept-encoding",
  "cache-control",
  "content-type",
  "content-length",
  "if-none-match",
  "if-modified-since",
  "range",
  "user-agent",
]);
const DROP_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "trailer"]);
/** Response headers never passed back from neko: cookies, hop-by-hop headers and every CORS header. */
export function dropResponseHeader(name) {
  const lower = String(name).toLowerCase();
  return DROP_RESPONSE_HEADERS.has(lower) || lower.startsWith("access-control-");
}

/** The client's address without an IPv4-mapped prefix. */
export function peerOf(socket) {
  return String(socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
}

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const OPEN_SCRIPT = `(async () => {
  const m = document.getElementById("m");
  const h = new URLSearchParams(location.hash.slice(1));
  const t = h.get("t");
  history.replaceState(null, "", location.pathname);
  if (!t) { m.textContent = "This link has no key. Open the viewer again from Paseo."; return; }
  const phone = h.get("p") === "1" || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700);
  try {
    const r = await fetch("/bp/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: t, portrait: phone }) });
    if (!r.ok) {
      m.textContent = "This link has expired or was already used. Open the viewer again from Paseo: each link works once, for a few minutes.";
      return;
    }
    const body = await r.json();
    location.replace(typeof body.path === "string" && new RegExp("^/s-[0-9a-f]{32}/$").test(body.path) ? body.path : "/");
  } catch {
    m.textContent = "Could not reach the signed-in browser.";
  }
})();`;
const OPEN_SCRIPT_HASH = createHash("sha256").update(OPEN_SCRIPT).digest("base64");

/** The page the viewer link opens: trades the ticket in its fragment for the session cookie. */
export const OPEN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Signed-in browser</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#eee}p{max-width:30em;padding:24px;text-align:center;line-height:1.5}</style></head>
<body><p id="m">Opening the signed-in browser…</p><script>${OPEN_SCRIPT}</script></body></html>`;
export const OPEN_PAGE_CSP = `default-src 'none'; script-src 'sha256-${OPEN_SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const LOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed-in browser</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#eee}p{max-width:30em;padding:24px;text-align:center;line-height:1.5}</style></head>
<body><p>Open the signed-in browser from Paseo: the card's Take over button, or Settings → Signed-in Server browser → Log in to sites. Viewer sessions end after 2 hours, or 20 minutes without use.</p></body></html>`;

/** `WxH@rate` to the body neko's screen API takes; null when malformed. */
export function parseScreen(text) {
  const match = /^(\d{3,4})x(\d{3,4})@(\d{1,2})$/.exec(String(text ?? ""));
  return match ? { width: Number(match[1]), height: Number(match[2]), rate: Number(match[3]) } : null;
}

/**
 * Starts the relay. Options: `nekoHost`, `nekoPort`, `listenPort`, `listenHost`, `rtcPort` (0: no
 * ICE-TCP forward), `origins` (list), `secret`, `statusToken`, `adminPassword` (the relay's own
 * service login), `userPassword` (the owner's viewer logins, no admin rights), `landscape`,
 * `portrait`, `log`, `now`, `nekoRequest` (tests). Returns `{ port, rtcPort, close(), state() }`.
 */
export async function startRelay(options) {
  const {
    nekoHost,
    nekoPort = 8080,
    listenPort = 8080,
    listenHost = "0.0.0.0",
    rtcPort = 0,
    controlPollMs = 1000,
    lockOnRelease = false,
    secret,
    statusToken,
    adminPassword,
    userPassword,
    log = () => {},
    now = Date.now,
  } = options;
  const origins = options.origins ?? [];
  const hosts = hostsOf(origins);
  const httpsHosts = new Set(origins.filter((origin) => origin.startsWith("https:")).map((origin) => new URL(origin).host.toLowerCase()));
  const landscape = parseScreen(options.landscape ?? "1280x720@30");
  const portrait = parseScreen(options.portrait ?? "720x1280@30");
  if (!secret || secret.length < 32) throw new Error("the viewer secret is missing");
  if (!statusToken || statusToken.length < 32) throw new Error("the status token is missing");
  if (!adminPassword) throw new Error("the neko admin password is missing");
  if (!userPassword || userPassword === adminPassword) throw new Error("the neko user password is missing");
  if (!nekoHost) throw new Error("the neko address is missing");
  if (origins.length === 0) throw new Error("no viewer origin");

  // Per relay start: the viewer's path prefix and the cookie's name, so the cookie only goes to this
  // relay's viewer paths (cookies ignore ports, so other services on the same host name would get a
  // cookie with Path=/).
  const prefix = options.prefix ?? `/s-${randomBytes(16).toString("hex")}`;
  const cookieName = options.cookieName ?? `${SESSION_COOKIE}_${randomBytes(8).toString("hex")}`;
  if (!/^\/s-[0-9a-f]{32}$/.test(prefix) || !/^bp_viewer_[0-9a-f]{16}$/.test(cookieName)) throw new Error("bad prefix or cookie name");
  /** bp session id -> { token, created, lastSeen, peer, portrait } */
  const sessions = new Map();
  /** ticket nonces used (or being used) -> expiry (s) */
  const usedNonces = new Map();
  let ownerControl = false;
  let controlKnown = false;
  // Bitwarden: whether the vault must be locked before the run may go on, and which release that is
  // (a confirmation for an earlier release does not clear a later one).
  let lockPending = lockOnRelease;
  let lockGeneration = lockOnRelease ? 1 : 0;
  /** The daemon could not lock the vault for this release: the run is told the owner has to act. */
  let lockFailed = false;
  let wasHeld = false;
  /** After a takeover ends (released, reset, or the viewer gone): the run waits for the lock. */
  function requireLock(reason) {
    if (!lockOnRelease) return;
    lockGeneration++;
    if (!lockPending) log(`vault lock needed (${reason})`);
    lockPending = true;
    lockFailed = false;
  }
  /** Notes the end of a held period (held or unsure while a viewer is connected). */
  function noteControl() {
    const held = controlHeld();
    if (wasHeld && !held) requireLock("control released");
    wasHeld = held;
  }
  let lastPeer = "";
  let viewers = 0;
  let lastActivity = now();
  let screenIsPortrait = false;
  let landscapeTimer = null;
  let serviceToken = null;

  const touch = () => {
    lastActivity = now();
  };

  /** One JSON request to neko; resolves `{ status, body }` or rejects. */
  function nekoJson(method, path, body, token) {
    if (options.nekoRequest) return options.nekoRequest(method, path, body, token);
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          host: nekoHost,
          port: nekoPort,
          method,
          path,
          headers: {
            Host: `${nekoHost}:${nekoPort}`,
            Accept: "application/json",
            ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size <= 256 * 1024) chunks.push(chunk);
          });
          res.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** A neko login: the relay's service login as an admin, the owner's viewer logins as a regular member. */
  async function nekoLogin(prefix, password = adminPassword) {
    const username = `${prefix}-${randomBytes(3).toString("hex")}`;
    const result = await nekoJson("POST", "/api/login", { username, password });
    const token = result.body && typeof result.body.token === "string" ? result.body.token : null;
    if (result.status !== 200 || !token) throw new Error(`neko login failed (${result.status})`);
    return token;
  }

  async function setScreen(size) {
    if (!size) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        serviceToken ??= await nekoLogin("relay");
        const result = await nekoJson("POST", "/api/room/screen", size, serviceToken);
        if (result.status === 401) {
          serviceToken = null;
          continue;
        }
        return result.status >= 200 && result.status < 300;
      } catch {
        serviceToken = null;
      }
    }
    return false;
  }

  const alive = (session, t = now()) => t - session.created < SESSION_TTL_MS && t - session.lastSeen < SESSION_IDLE_MS;

  function prune() {
    const t = now();
    for (const [id, session] of sessions) if (!alive(session, t)) sessions.delete(id);

    const s = Math.floor(t / 1000);
    for (const [nonce, exp] of usedNonces) if (exp <= s) usedNonces.delete(nonce);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  /** The request's live session: right cookie, not expired or idle, from the address it started from. */
  function sessionOf(req) {
    const id = parseCookies(req.headers.cookie)[cookieName];
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (!alive(session)) {
      sessions.delete(id);
      return null;
    }
    if (session.peer !== peerOf(req.socket)) {
      log("refused a viewer session from another address");
      return null;
    }
    session.lastSeen = now();
    return { id, ...session };
  }

  function hostOk(req) {
    return hosts.includes(String(req.headers.host ?? "").toLowerCase());
  }
  function originOk(req) {
    const origin = req.headers.origin;
    return typeof origin === "string" && origins.includes(origin);
  }
  function secureFor(req) {
    return httpsHosts.has(String(req.headers.host ?? "").toLowerCase());
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers });
    res.end(body);
  }
  const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json" });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const badTicketDelay = options.badTicketDelayMs ?? BAD_TICKET_DELAY_MS;

  async function createSession(req, res) {
    if (!originOk(req)) return sendJson(res, 403, { error: "origin" });
    const peer = peerOf(req.socket);
    prune();
    let input;
    try {
      input = JSON.parse(await readBody(req, 4096));
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    const checked = verifyTicket(secret, input?.ticket, Math.floor(now() / 1000));
    if (!checked.ok || usedNonces.has(checked.nonce)) {
      await new Promise((resolve) => setTimeout(resolve, badTicketDelay));
      log(`refused a viewer ticket (${checked.ok ? "already used" : checked.reason})`);
      return sendJson(res, 401, { error: "invalid or expired link" });
    }
    // Held while neko is asked, so a second request with the same ticket fails; given back when the
    // login fails (the link may be tried again until it expires).
    usedNonces.set(checked.nonce, checked.exp);
    let token;
    try {
      token = await nekoLogin("owner", userPassword);
    } catch (error) {
      usedNonces.delete(checked.nonce);
      log(`could not log in to neko: ${error instanceof Error ? error.message : String(error)}`);
      return sendJson(res, 502, { error: "the browser is not ready yet" });
    }
    const id = randomBytes(32).toString("base64url");
    const wantsPortrait = input?.portrait === true;
    lastPeer = peer;
    sessions.set(id, { token, created: now(), lastSeen: now(), peer, portrait: wantsPortrait });
    touch();
    if (wantsPortrait && !screenIsPortrait) {
      if (await setScreen(portrait)) screenIsPortrait = true;
    }
    const cookie = [`${cookieName}=${id}`, "HttpOnly", "SameSite=Strict", `Path=${prefix}/`, `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
    if (secureFor(req)) cookie.push("Secure");
    log(`viewer session started (${checked.purpose}${wantsPortrait ? ", portrait" : ""})`);
    return send(res, 200, JSON.stringify({ ok: true, path: `${prefix}/` }), { "Content-Type": "application/json", "Set-Cookie": cookie.join("; ") });
  }

  function forward(req, res, session, innerPath) {
    const url = { pathname: innerPath };
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (FORWARD_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value;
    headers.host = `${nekoHost}:${nekoPort}`;
    headers.authorization = `Bearer ${session.token}`;
    // Query strings never go on (neko reads `?token=`); the client's own file URLs need none.
    const upstream = httpRequest({ host: nekoHost, port: nekoPort, method: req.method, path: url.pathname, headers, timeout: 30_000 }, (response) => {
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) if (!dropResponseHeader(name) && value !== undefined) out[name] = value;
      if (url.pathname.startsWith("/api/")) out["cache-control"] = "no-store";
      res.writeHead(response.statusCode ?? 502, { ...out, ...SECURITY_HEADERS });
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => send(res, 502, "The signed-in browser is not reachable.", { "Content-Type": "text/plain" }));
    req.pipe(upstream);
  }

  function scheduleLandscape() {
    if (landscapeTimer) clearTimeout(landscapeTimer);
    landscapeTimer = setTimeout(() => {
      landscapeTimer = null;
      if (viewers === 0 && screenIsPortrait) void setScreen(landscape).then((ok) => ok && (screenIsPortrait = false));
    }, 20_000);
    landscapeTimer.unref?.();
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      const path = url.pathname;
      if (path === "/bp/status") {
        const auth = String(req.headers.authorization ?? "");
        const expected = `Bearer ${statusToken}`;
        if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return sendJson(res, 401, { error: "status token" });
        let nekoUp = false;
        try {
          nekoUp = (await nekoJson("GET", "/health")).status === 200;
        } catch {
          nekoUp = false;
        }
        return sendJson(res, 200, { viewers, idleMs: Math.max(0, now() - lastActivity), nekoUp, portrait: screenIsPortrait, ownerControl: controlHeld(), lastPeer, lockPending, lockGeneration, lockFailed });
      }
      if (path === "/bp/locked" && req.method === "POST") {
        // The daemon locked the vault (Bitwarden's own Lock command) for release `generation`.
        const auth = String(req.headers.authorization ?? "");
        const expected = `Bearer ${statusToken}`;
        if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return sendJson(res, 401, { error: "status token" });
        let generation = -1;
        try {
          generation = Number(JSON.parse((await readBody(req, 256)) || "{}").generation);
        } catch {
          return sendJson(res, 400, { error: "body" });
        }
        // Only while nobody holds control: a lock pressed while the owner works is no lock for later.
        const cleared = lockPending && generation === lockGeneration && !controlHeld();
        if (cleared) {
          lockPending = false;
          lockFailed = false;
          log("vault locked; the run may go on");
        }
        return sendJson(res, 200, { lockPending, lockGeneration, cleared });
      }
      if (path === "/bp/lock-failed" && req.method === "POST") {
        // The daemon could not lock the vault for release `generation`: the run stays paused and is
        // told that the owner has to act (Lock now, Restart browser, Bitwarden's settings).
        const auth = String(req.headers.authorization ?? "");
        const expected = `Bearer ${statusToken}`;
        if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return sendJson(res, 401, { error: "status token" });
        let generation = -1;
        try {
          generation = Number(JSON.parse((await readBody(req, 256)) || "{}").generation);
        } catch {
          return sendJson(res, 400, { error: "body" });
        }
        if (lockPending && generation === lockGeneration) lockFailed = true;
        return sendJson(res, 200, { lockPending, lockGeneration, lockFailed });
      }
      if (!hostOk(req)) return send(res, 421, "Unknown host.", { "Content-Type": "text/plain" });
      if (path === "/bp/open" && (req.method === "GET" || req.method === "HEAD")) {
        return send(res, 200, OPEN_PAGE, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": OPEN_PAGE_CSP });
      }
      if (path === "/bp/session" && req.method === "POST") return await createSession(req, res);
      // Everything else of the viewer lives under this relay start's prefix.
      const inner = path === prefix ? "/" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
      if (inner === "/site.webmanifest" && (req.method === "GET" || req.method === "HEAD")) {
        return send(res, 200, req.method === "HEAD" ? undefined : MANIFEST, { "Content-Type": "application/manifest+json" });
      }
      const session = inner === null ? null : sessionOf(req);
      if (!session) {
        if (req.method === "GET" && (path === "/" || path === "/index.html" || inner === "/" || inner === "/index.html")) {
          return send(res, 401, LOCKED_PAGE, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        }
        return sendJson(res, 401, { message: "Open the signed-in browser from Paseo." });
      }
      const kind = classifyRequest(req.method, inner);
      if (kind === "logout") {
        sessions.delete(session.id);
        return send(res, 200, "true", { "Content-Type": "application/json", "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=${prefix}/; Max-Age=0` });
      }
      if (kind !== "static" && kind !== "api") {
        log(`refused ${req.method} ${inner.slice(0, 80)}`);
        return sendJson(res, 403, { message: BLOCKED_TEXT });
      }
      // Writes need the viewer's own origin (no cross-site form posts).
      if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req)) {
        log(`refused ${req.method} ${inner.slice(0, 80)} (origin)`);
        return sendJson(res, 403, { message: BLOCKED_TEXT });
      }
      touch();
      forward(req, res, session, inner);
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, "Error.", { "Content-Type": "text/plain" });
    }
  });
  /** Open viewer WebSockets: closed when their session ends (2 hours, logout). */
  const openSockets = new Set();
  const sweeper = setInterval(() => {
    prune();
    for (const entry of openSockets) {
      if (entry.socket.destroyed) openSockets.delete(entry);
      else if (!sessions.has(entry.id)) {
        entry.socket.destroy();
        openSockets.delete(entry);
      }
    }
  }, 30_000);
  sweeper.unref?.();

  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.maxConnections = 256;

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const refuse = (status, text) => {
      log(`refused a WebSocket (${text})`);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const url = new URL(req.url ?? "/", "http://relay");
    if (!hostOk(req)) return refuse(421, "Misdirected Request");
    if (!originOk(req)) return refuse(403, "Forbidden");
    if (url.pathname !== `${prefix}/api/ws`) return refuse(403, "Forbidden");
    const session = sessionOf(req);
    if (!session) return refuse(401, "Unauthorized");
    const live = sessions.get(session.id);
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9+/=]{16,64}$/.test(key)) return refuse(400, "Bad Request");
    const upstream = connect({ host: nekoHost, port: nekoPort });
    upstream.on("error", () => socket.destroy());
    upstream.once("connect", () => {
      const lines = [
        "GET /api/ws HTTP/1.1",
        `Host: ${nekoHost}:${nekoPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${String(req.headers["sec-websocket-version"] ?? "13").replace(/[^0-9]/g, "") || "13"}`,
        `Origin: http://${nekoHost}:${nekoPort}`,
        `Authorization: Bearer ${session.token}`,
      ];
      const protocol = req.headers["sec-websocket-protocol"];
      if (typeof protocol === "string" && /^[A-Za-z0-9 ,._-]{1,200}$/.test(protocol)) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      viewers++;
      touch();
      if (landscapeTimer) clearTimeout(landscapeTimer);
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        viewers = Math.max(0, viewers - 1);
        touch();
        if (viewers === 0) {
          // Whatever the owner did in that viewer, the vault is locked before the run goes on.
          requireLock("the last viewer left");
          wasHeld = false;
          scheduleLandscape();
          // A closed viewer must not leave control held (the run would stay paused).
          void resetControl();
        }
        socket.destroy();
        upstream.destroy();
      };
      upstream.pipe(socket);
      socket.pipe(upstream);
      // A half-close (FIN) from either side ends the viewer: no lingering sockets, an exact viewer count.
      socket.on("close", done);
      upstream.on("close", done);
      socket.on("end", done);
      upstream.on("end", done);
      socket.on("data", () => {
        touch();
        if (live) live.lastSeen = now();
      });
      openSockets.add({ id: session.id, socket });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => resolve());
  });

  let rtc = null;
  if (rtcPort) {
    rtc = createTcpServer((client) => {
      client.on("error", () => {});
      const upstream = connect({ host: nekoHost, port: rtcPort });
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    rtc.maxConnections = 64;
    await new Promise((resolve, reject) => {
      rtc.once("error", reject);
      rtc.listen(rtcPort, listenHost, () => resolve());
    });
  }

  // Takeover state: whether someone (only the owner logs in to neko) holds control right now. One
  // poll at a time; a result older than the last applied one is ignored.
  let polling = null;
  let pollIssued = 0;
  let pollApplied = 0;
  /** One poll at a time: a call while one runs gets that one. */
  function pollControl() {
    polling ??= pollOnce().finally(() => {
      polling = null;
    });
    return polling;
  }
  async function pollOnce() {
    const seq = ++pollIssued;
    try {
      serviceToken ??= await nekoLogin("relay");
      const result = await nekoJson("GET", "/api/room/control", undefined, serviceToken);
      if (result.status === 401) serviceToken = null;
      if (result.status !== 200 || !result.body) throw new Error(`control state ${result.status}`);
      if (seq > pollApplied) {
        pollApplied = seq;
        ownerControl = result.body.has_host === true;
        controlKnown = true;
      }
    } catch {
      if (seq > pollApplied) {
        pollApplied = seq;
        controlKnown = false;
        // Nobody can hold control without a viewer: a stale value must not pause the run.
        if (viewers === 0) ownerControl = false;
      }
    }
    noteControl();
    // Control still held with no viewer (a reset that failed): try again.
    if (viewers === 0 && ownerControl) await resetControl();
  }
  /**
   * Whether the run must pause: only while a viewer is connected, when it holds control or the relay
   * cannot tell (fail closed). Without a viewer nobody can hold control, so the run never waits on a
   * stale or unknown state.
   */
  function controlHeld() {
    return viewers > 0 && (ownerControl || !controlKnown);
  }
  async function resetControl() {
    try {
      serviceToken ??= await nekoLogin("relay");
      const result = await nekoJson("POST", "/api/room/control/reset", undefined, serviceToken);
      if (result.status === 401) serviceToken = null;
      if (result.status < 200 || result.status >= 300) throw new Error(`reset ${result.status}`);
      ownerControl = false;
      noteControl();
      log("no viewer left: control reset");
    } catch {
      // the next poll shows the state
    }
  }
  let poller = null;
  let control = null;
  /**
   * Serves GET /control ({ ownerControl, known }) on `host:port`: the relay's address on the stack's
   * internal network (relay-main.mjs finds it), never published. Polls neko every `controlPollMs`.
   */
  async function startControl(host, port) {
    if (control) return control.address().port;
    void pollControl();
    poller = setInterval(() => void pollControl(), Math.max(200, controlPollMs));
    poller.unref?.();
    control = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/control") return res.writeHead(404).end();
      // While the vault waits to be locked, the run stays paused as if the owner still held control.
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(
          JSON.stringify({
            ownerControl: controlHeld() || lockPending,
            known: controlKnown || viewers === 0,
            // Paused only because the vault is being locked (nobody holds control): the run waits, it does not ask the owner.
            ...(lockOnRelease ? { lockPending, securing: lockPending && !controlHeld() && !lockFailed, lockFailed: lockPending && lockFailed && !controlHeld() } : {}),
          }),
        );
    });
    await new Promise((resolve, reject) => {
      control.once("error", reject);
      control.listen(port, host, () => resolve());
    });
    return control.address().port;
  }

  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : listenPort,
    rtcPort: rtc ? rtc.address().port : 0,
    startControl,
    prefix,
    cookieName,
    pollControl,
    state: () => ({ viewers, sessions: sessions.size, idleMs: now() - lastActivity, portrait: screenIsPortrait, ownerControl: controlHeld(), lockPending, lockGeneration }),
    close: () =>
      new Promise((resolve) => {
        if (landscapeTimer) clearTimeout(landscapeTimer);
        clearInterval(sweeper);
        if (poller) clearInterval(poller);
        control?.close();
        control?.closeAllConnections?.();
        for (const entry of openSockets) entry.socket.destroy();
        server.closeAllConnections?.();
        rtc?.close();
        server.close(() => resolve());
      }),
  };
}
