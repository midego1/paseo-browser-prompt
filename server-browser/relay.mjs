// Relay for the browser-prompt signed-in Server browser: the only way into the neko desktop (the
// owner's signed-in Chromium) from outside Docker. It runs in its own container, published only on
// the daemon host's Tailscale address (or 127.0.0.1), and talks to neko on the stack's internal
// network. It does three things:
//   1. Owner login with the plugin's key: Paseo hands the owner a link whose URL fragment holds a
//      one-time ticket signed with the plugin's secret (never in a query string, so never in logs).
//      The page at /bp/open posts it to /bp/session; the relay checks it (signature, expiry, used
//      once), logs in to neko as an admin with a generated password the owner never sees, and sets
//      an HttpOnly, SameSite=Strict cookie. neko's own token never reaches the browser: the relay
//      adds it to every request it forwards.
//   2. A narrow allowlist: neko's web client files, the WebSocket and the few API routes the client
//      needs to watch and take control. Everything else (member and session management, uploads,
//      file transfer, broadcast, metrics, health, debug) is refused. Host and Origin are checked on
//      every request (DNS rebinding, cross-site WebSocket).
//   3. WebRTC over ICE-TCP: a plain TCP forward of the mux port to neko.
// Node's standard library only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";

export const TICKET_VERSION = "v1";
/** A ticket is valid for at most this long after it was issued (the link in the app's history dies with it). */
export const TICKET_MAX_TTL_S = 600;
export const TICKET_PURPOSES = ["login", "takeover"];
export const SESSION_COOKIE = "bp_viewer";
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const MAX_SESSIONS = 32;
/** Failed ticket checks allowed per minute before /bp/session answers 429 for the rest of it. */
export const MAX_FAILURES_PER_MINUTE = 20;
export const BLOCKED_TEXT = "Blocked by the browser-prompt relay.";

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
      m.textContent = r.status === 429 ? "Too many attempts. Wait a minute, then open the viewer again from Paseo." : "This link has expired or was already used. Open the viewer again from Paseo: each link works once, for a few minutes.";
      return;
    }
    location.replace("/");
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
<body><p>Open the signed-in browser from Paseo: the card's Take over button, or Settings → Signed-in Server browser → Log in to sites.</p></body></html>`;

/** `WxH@rate` to the body neko's screen API takes; null when malformed. */
export function parseScreen(text) {
  const match = /^(\d{3,4})x(\d{3,4})@(\d{1,2})$/.exec(String(text ?? ""));
  return match ? { width: Number(match[1]), height: Number(match[2]), rate: Number(match[3]) } : null;
}

/**
 * Starts the relay. Options: `nekoHost`, `nekoPort`, `listenPort`, `listenHost`, `rtcPort` (0: no
 * ICE-TCP forward), `origins` (list), `secret`, `statusToken`, `adminPassword`, `landscape`,
 * `portrait`, `log`, `now`, `nekoRequest` (tests). Returns `{ port, rtcPort, close(), state() }`.
 */
export async function startRelay(options) {
  const {
    nekoHost,
    nekoPort = 8080,
    listenPort = 8080,
    listenHost = "0.0.0.0",
    rtcPort = 0,
    secret,
    statusToken,
    adminPassword,
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
  if (!nekoHost) throw new Error("the neko address is missing");
  if (origins.length === 0) throw new Error("no viewer origin");

  /** bp session id -> { token, expires, portrait } */
  const sessions = new Map();
  /** ticket nonces already used -> expiry (s) */
  const usedNonces = new Map();
  let failures = { windowStart: now(), count: 0 };
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

  async function nekoLogin(prefix) {
    const username = `${prefix}-${randomBytes(3).toString("hex")}`;
    const result = await nekoJson("POST", "/api/login", { username, password: adminPassword });
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

  function prune() {
    const t = now();
    for (const [id, session] of sessions) if (session.expires <= t) sessions.delete(id);
    const s = Math.floor(t / 1000);
    for (const [nonce, exp] of usedNonces) if (exp <= s) usedNonces.delete(nonce);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function sessionOf(req) {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expires <= now()) {
      sessions.delete(id);
      return null;
    }
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

  function rateLimited() {
    const t = now();
    if (t - failures.windowStart > 60_000) failures = { windowStart: t, count: 0 };
    return failures.count >= MAX_FAILURES_PER_MINUTE;
  }

  async function createSession(req, res) {
    if (!originOk(req)) return sendJson(res, 403, { error: "origin" });
    if (rateLimited()) return sendJson(res, 429, { error: "slow down" });
    let input;
    try {
      input = JSON.parse(await readBody(req, 4096));
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    const checked = verifyTicket(secret, input?.ticket, Math.floor(now() / 1000));
    prune();
    if (!checked.ok || usedNonces.has(checked.nonce)) {
      failures.count++;
      log(`refused a viewer ticket (${checked.ok ? "already used" : checked.reason})`);
      return sendJson(res, 401, { error: "invalid or expired link" });
    }
    usedNonces.set(checked.nonce, checked.exp);
    let token;
    try {
      token = await nekoLogin("owner");
    } catch (error) {
      log(`could not log in to neko: ${error instanceof Error ? error.message : String(error)}`);
      return sendJson(res, 502, { error: "the browser is not ready yet" });
    }
    const id = randomBytes(32).toString("base64url");
    const wantsPortrait = input?.portrait === true;
    sessions.set(id, { token, expires: now() + SESSION_TTL_MS, portrait: wantsPortrait });
    touch();
    if (wantsPortrait && !screenIsPortrait) {
      if (await setScreen(portrait)) screenIsPortrait = true;
    }
    const cookie = [`${SESSION_COOKIE}=${id}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
    if (secureFor(req)) cookie.push("Secure");
    log(`viewer session started (${checked.purpose}${wantsPortrait ? ", portrait" : ""})`);
    return send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json", "Set-Cookie": cookie.join("; ") });
  }

  function forward(req, res, session) {
    const url = new URL(req.url, "http://relay");
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (FORWARD_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value;
    headers.host = `${nekoHost}:${nekoPort}`;
    headers.authorization = `Bearer ${session.token}`;
    // Query strings never go on (neko reads `?token=`); the client's own file URLs need none.
    const upstream = httpRequest({ host: nekoHost, port: nekoPort, method: req.method, path: url.pathname, headers, timeout: 30_000 }, (response) => {
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) if (!DROP_RESPONSE_HEADERS.has(name) && value !== undefined) out[name] = value;
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
        return sendJson(res, 200, { viewers, idleMs: Math.max(0, now() - lastActivity), nekoUp, portrait: screenIsPortrait });
      }
      if (!hostOk(req)) return send(res, 421, "Unknown host.", { "Content-Type": "text/plain" });
      if (path === "/bp/open" && (req.method === "GET" || req.method === "HEAD")) {
        return send(res, 200, OPEN_PAGE, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": OPEN_PAGE_CSP });
      }
      if (path === "/bp/session" && req.method === "POST") return await createSession(req, res);
      const session = sessionOf(req);
      if (!session) {
        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
          return send(res, 401, LOCKED_PAGE, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        }
        return sendJson(res, 401, { message: "Open the signed-in browser from Paseo." });
      }
      const kind = classifyRequest(req.method, path);
      if (kind === "logout") {
        sessions.delete(session.id);
        return send(res, 200, "true", { "Content-Type": "application/json", "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (kind !== "static" && kind !== "api") {
        log(`refused ${req.method} ${path.slice(0, 80)}`);
        return sendJson(res, 403, { message: BLOCKED_TEXT });
      }
      // Writes need the viewer's own origin (no cross-site form posts).
      if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req)) return sendJson(res, 403, { message: BLOCKED_TEXT });
      touch();
      forward(req, res, session);
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, "Error.", { "Content-Type": "text/plain" });
    }
  });
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
    if (classifyRequest(req.method, url.pathname) !== "ws") return refuse(403, "Forbidden");
    const session = sessionOf(req);
    if (!session) return refuse(401, "Unauthorized");
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
        if (viewers === 0) scheduleLandscape();
        socket.destroy();
        upstream.destroy();
      };
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.on("close", done);
      upstream.on("close", done);
      socket.on("data", touch);
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

  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : listenPort,
    rtcPort: rtc ? rtc.address().port : 0,
    state: () => ({ viewers, sessions: sessions.size, idleMs: now() - lastActivity, portrait: screenIsPortrait }),
    close: () =>
      new Promise((resolve) => {
        if (landscapeTimer) clearTimeout(landscapeTimer);
        server.closeAllConnections?.();
        rtc?.close();
        server.close(() => resolve());
      }),
  };
}
