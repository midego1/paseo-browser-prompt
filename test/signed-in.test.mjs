// Run: npm test. The signed-in Server browser: the relay (ticket, session cookie, route allowlist,
// Host and Origin checks, WebSocket, status, rate limit) end to end against a fake neko on
// 127.0.0.1, the stack's docker arguments and their checks, the signed-in launcher plan, the run
// gate, the idle rule, the daemon side (status, explicit build, start, busy, viewer link, stop,
// log out, key rotation) against a fake docker, the neko image overrides, the prompt variant, the
// settings, and the card and settings surfaces.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildAgentPrompt,
  CHROME_KEEP_TABS_RULE,
  describeLaunch,
  parseBrowserAgent,
  runBrowserOf,
  SERVER_SCREENSHOT_RULE,
  SIGNED_IN_BROWSER_TOOLS,
  SIGNED_IN_CLOSE_TABS_RULE,
  SIGNED_IN_REMOVED_TOOLS,
  SIGNED_IN_SAFETY_PREAMBLE,
  SERVER_SAFETY_PREAMBLE,
} from "../shared/agent-prompt.ts";
import {
  BROWSER_LABEL,
  CONTAINER_AGENT_LABEL,
  CONTAINER_LABEL,
  INSTANCE_LABEL,
  isServerBrowserRun,
  serverRunLabels,
  serverRunRecorded,
  shouldAttachServerBrowser,
  shouldAttachSignedIn,
  TICKET_LABEL,
} from "../shared/server-browser.ts";
import {
  BITWARDEN,
  bitwardenIdFromPin,
  bitwardenImageTag,
  bitwardenToolArgs,
  parseBitwardenTool,
  bindHostAllowed,
  checkStackRun,
  DEFAULT_SIGNED_IN_PORT,
  IDLE_STOP_MS,
  isSignedInRun,
  NEKO_BASE_IMAGE,
  shouldStopForIdle,
  SIGNED_IN_AGENT_ROLE,
  SIGNED_IN_LABEL_VALUE,
  SIGNED_IN_RUN_MARKER,
  SIGNED_IN_STATE_MESSAGES,
  SIGNED_IN_STATES,
  signedInImageTag,
  signedInPlan,
  signedInRunLabels,
  STACK_LABEL,
  stackNames,
  stackNekoArgs,
  stackNetworkArgs,
  stackProxyArgs,
  stackRelayArgs,
  validateHttpsBase,
  viewerLink,
  viewerOrigins,
} from "../shared/signed-in.ts";
import { createServerBrowser } from "../server/server-browser.ts";
import { createSignedIn, loadKeys, relaySecret, signViewerTicket } from "../server/signed-in.ts";
import { SIGNED_IN_BITWARDEN_FILES, SIGNED_IN_FILES } from "../server/server-browser-files.ts";
import { checkPlan, launch } from "../server-browser/launch.mjs";
import {
  createCallTracker,
  createControlGuard,
  EXTENSION_URL_TEXT,
  SECURING_TEXT,
  filterClientLine,
  namesExtensionPage,
  filterServerLine,
  OWNER_CONTROL_TEXT,
  SIGNED_IN_ALLOWED_TOOLS,
  SIGNED_IN_REMOVED_TOOLS as FILTER_REMOVED,
  toolAllowed,
} from "../server-browser/mcp-filter.mjs";
import { createTargetFilter, FOCUS_WORLD, HELD_REFUSED, isExtensionUrl, REFUSED_METHODS } from "../server-browser/cdp-filter.mjs";
import { isLocked, LOCK_EXPRESSION, STATUS_EXPRESSION } from "../server-browser/bitwarden-lock.mjs";
import {
  BLOCKED_TEXT,
  classifyRequest,
  hostsOf,
  MANIFEST,
  OPEN_PAGE,
  OPEN_PAGE_CSP,
  parseCookies,
  parseOrigins,
  SESSION_COOKIE,
  startRelay,
  TICKET_MAX_TTL_S,
  verifyTicket,
} from "../server-browser/relay.mjs";

const SECRET = "s".repeat(43);
const STATUS = "t".repeat(43);
const INSTANCE = "paseo-box-11111111-2222-3333-4444-555555555555";
const SERVER_IMAGE = "browser-prompt-server-browser:pw1.65.1-mcp0.0.84-0123456789ab";
const NEKO_IMAGE = "browser-prompt-signed-in:neko3.2.0-0123456789ab";

const input = (extra = {}) => ({
  stackId: "0a1b2c3d",
  instance: INSTANCE,
  serverImage: SERVER_IMAGE,
  nekoImage: NEKO_IMAGE,
  seccompProfile: "/state/runtime/seccomp.json",
  blockedIps: ["100.96.145.38", "152.53.114.172"],
  bindHost: "100.96.145.38",
  port: DEFAULT_SIGNED_IN_PORT,
  origins: viewerOrigins("100.96.145.38", DEFAULT_SIGNED_IN_PORT, ""),
  ...extra,
});
const KEYS = { viewerSecret: SECRET, statusToken: STATUS, nekoAdminPassword: "a".repeat(43), nekoUserPassword: "u".repeat(43) };
const value = (args, flag) => args.filter((_, i) => args[i - 1] === flag);

// ---------------------------------------------------------------- tickets

test("viewer tickets: the plugin signs, the relay checks signature, expiry, length of validity and shape", () => {
  const now = 1_800_000_000;
  const ticket = signViewerTicket(SECRET, { exp: now + 300, nonce: "abcdefghijklmnopqrstuvwx", purpose: "takeover" });
  assert.deepEqual(verifyTicket(SECRET, ticket, now), { ok: true, nonce: "abcdefghijklmnopqrstuvwx", exp: now + 300, purpose: "takeover" });
  assert.equal(verifyTicket("x".repeat(43), ticket, now).reason, "signature");
  assert.equal(verifyTicket(SECRET, ticket, now + 300).reason, "expired");
  const long = signViewerTicket(SECRET, { exp: now + TICKET_MAX_TTL_S + 1, nonce: "abcdefghijklmnopqrstuvwx", purpose: "login" });
  assert.equal(verifyTicket(SECRET, long, now).reason, "too long");
  assert.equal(verifyTicket(SECRET, ticket.replace("takeover", "login"), now).reason, "signature", "the purpose is signed");
  for (const bad of ["", "v1", `${ticket}x`, ticket.replace("v1.", "v2."), "v1.1.abc.login.x", null]) assert.equal(verifyTicket(SECRET, bad, now).ok, false);
});

test("the viewer link carries the ticket only in the fragment", () => {
  const url = viewerLink("http://100.96.145.38:5301", "v1.1.a.login.b", true);
  assert.equal(url, "http://100.96.145.38:5301/bp/open#t=v1.1.a.login.b&p=1");
  assert.equal(new URL(url).search, "");
  assert.deepEqual(viewerOrigins("100.96.145.38", 5301, "https://box.tail.ts.net:8443/"), ["http://100.96.145.38:5301", "https://box.tail.ts.net:8443"]);
  assert.deepEqual(viewerOrigins("127.0.0.1", 5301, "http://insecure.example"), ["http://127.0.0.1:5301"], "an invalid https base is ignored");
  assert.equal(validateHttpsBase(""), null);
  assert.equal(validateHttpsBase("https://box.tail.ts.net"), null);
  assert.notEqual(validateHttpsBase("http://box.tail.ts.net"), null);
  assert.notEqual(validateHttpsBase("https://box.tail.ts.net/path?x=1"), null);
});

test("the open page keeps the ticket out of history and logs, under a strict CSP", () => {
  assert.match(OPEN_PAGE, /history\.replaceState\(null, "", location\.pathname\)/);
  assert.match(OPEN_PAGE, /location\.hash/);
  assert.match(OPEN_PAGE, /fetch\("\/bp\/session", \{ method: "POST", credentials: "same-origin"/);
  assert.match(OPEN_PAGE_CSP, /default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(OPEN_PAGE_CSP, /frame-ancestors 'none'/);
});

// ---------------------------------------------------------------- relay routing

test("relay allowlist: client files, the WebSocket and the control routes only", () => {
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/assets/index-D45dbpnU.js"],
    ["GET", "/assets/locales/en-common-D9Vc06Ql.js"],
    ["GET", "/favicon-32x32.png"],
    ["GET", "/keyboard_layouts.json"],
  ])
    assert.equal(classifyRequest(method, path), "static", path);
  assert.equal(classifyRequest("GET", "/api/ws"), "ws");
  assert.equal(classifyRequest("POST", "/api/logout"), "logout");
  for (const [method, path] of [
    ["GET", "/api/whoami"],
    ["POST", "/api/room/control/take"],
    ["POST", "/api/room/control/give/abc_1"],
    ["POST", "/api/room/screen"],
  ])
    assert.equal(classifyRequest(method, path), "api", path);
  for (const [method, path] of [
    ["GET", "/metrics"],
    ["GET", "/health"],
    ["GET", "/debug/pprof/"],
    ["POST", "/api/login"],
    ["GET", "/api/members"],
    ["POST", "/api/members/x"],
    ["POST", "/api/members_bulk/update"],
    ["GET", "/api/sessions"],
    ["DELETE", "/api/sessions/x"],
    ["POST", "/api/room/broadcast/start"],
    ["POST", "/api/room/settings"],
    ["POST", "/api/room/upload/drop"],
    ["GET", "/api/filetransfer"],
    ["POST", "/api/openinapp/openlink"],
    ["POST", "/api/batch"],
    ["GET", "/api/stats"],
    ["GET", "/api/room/screen/shot.jpg"],
    ["GET", "/assets/../api/members"],
    ["GET", "/assets/%2e%2e/x"],
    ["GET", "//api/members"],
    ["POST", "/index.html"],
  ])
    assert.equal(classifyRequest(method, path), null, `${method} ${path}`);
});

test("relay helpers: cookies, origins and hosts", () => {
  assert.deepEqual(parseCookies("a=1; bp_viewer=xyz; a=2"), { a: "1", bp_viewer: "xyz" });
  assert.deepEqual(parseOrigins("http://100.96.145.38:5301, https://Box.tail.ts.net:8443/x, javascript:alert(1), nonsense"), [
    "http://100.96.145.38:5301",
    "https://box.tail.ts.net:8443",
  ]);
  assert.deepEqual(hostsOf(["http://100.96.145.38:5301", "https://box.tail.ts.net"]), ["100.96.145.38:5301", "box.tail.ts.net"]);
});

/** A fake neko: records requests, answers login, whoami, control state, screen and health, upgrades /api/ws. */
async function fakeNeko() {
  const seen = [];
  const state = { hasHost: false, failLogin: false };
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === "/api/login") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { password, username } = JSON.parse(body);
        if (state.failLogin) return res.writeHead(503).end("{}");
        // The relay's service login is an admin ("neko-token"); the owner's viewer logins are not ("user-token").
        const token = password === "admin-pw" ? "neko-token" : password === "user-pw" ? "user-token" : null;
        if (!token) return res.writeHead(401).end("{}");
        (state.logins ??= []).push({ username, admin: token === "neko-token" });
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "NEKO_SESSION=leak" }).end(JSON.stringify({ id: "s1", token }));
      });
      return;
    }
    if (req.url === "/health") return res.writeHead(200).end("true");
    if (req.headers.authorization !== "Bearer neko-token" && req.headers.authorization !== "Bearer user-token") return res.writeHead(401).end("{}");
    if (req.url === "/api/room/control") {
      if (state.controlFails) return res.writeHead(500).end("{}");
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ has_host: state.hasHost }));
    }
    if (req.url === "/api/room/control/reset") {
      state.resets = (state.resets ?? 0) + 1;
      state.hasHost = false;
      return res.writeHead(204).end();
    }
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "NEKO_SESSION=leak",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
      })
      .end(JSON.stringify({ ok: true, path: req.url }));
  });
  const upgraded = new Set();
  server.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    seen.push({ method: "UPGRADE", url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function http(port, method, path, headers = {}, body, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", (error) => resolve({ status: 0, body: error.message }));
    if (body) req.write(body);
    req.end();
  });
}

function upgrade(port, headers, path = "/api/ws?token=evil") {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [`GET ${path} HTTP/1.1`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (data.includes("\r\n")) {
        resolve(data.split("\r\n")[0]);
        socket.destroy();
      }
    });
    socket.on("error", () => resolve("error"));
  });
}

const HOST = { Host: "127.0.0.1:5301" };
const ORIGIN_HEADERS = { ...HOST, Origin: "http://127.0.0.1:5301" };

async function relayFor(neko, extra = {}) {
  return startRelay({
    nekoHost: "127.0.0.1",
    nekoPort: neko.port,
    listenHost: "127.0.0.1",
    listenPort: 0,
    origins: ["http://127.0.0.1:5301"],
    secret: SECRET,
    statusToken: STATUS,
    adminPassword: "admin-pw",
    userPassword: "user-pw",
    badTicketDelayMs: 0,
    ...extra,
  });
}
const ticketAt = (now, nonce, purpose = "login") => signViewerTicket(SECRET, { exp: Math.floor(now / 1000) + 300, nonce, purpose });
const postTicket = (relay, ticket, headers = ORIGIN_HEADERS, host) =>
  http(relay.port, "POST", "/bp/session", { ...headers, "Content-Type": "application/json" }, JSON.stringify({ ticket }), host);

test("relay end to end: ticket to a scoped cookie, forwarding under the prefix with neko's token only, Host, Origin, WebSocket, status, rate limit", async () => {
  const neko = await fakeNeko();
  const logs = [];
  let now = 1_800_000_000_000;
  const relay = await relayFor(neko, { log: (m) => logs.push(m), now: () => now });
  const P = relay.prefix;
  assert.match(P, /^\/s-[0-9a-f]{32}$/);
  assert.match(relay.cookieName, /^bp_viewer_[0-9a-f]{16}$/);
  try {
    const ticket = ticketAt(now, "nonce-nonce-nonce-1");
    assert.equal((await http(relay.port, "GET", "/bp/open", HOST)).status, 200);
    assert.equal((await http(relay.port, "GET", "/bp/open", { Host: "evil.example" })).status, 421, "DNS rebinding: unknown Host");
    assert.equal((await postTicket(relay, ticket, HOST)).status, 403, "no Origin");
    assert.equal((await postTicket(relay, ticket, { ...HOST, Origin: "http://evil.example" })).status, 403, "foreign Origin");
    const created = await postTicket(relay, ticket);
    assert.equal(created.status, 200);
    assert.deepEqual(JSON.parse(created.body), { ok: true, path: `${P}/` });
    const setCookie = String(created.headers["set-cookie"]);
    assert.equal(setCookie.replace(/=[A-Za-z0-9_-]{43};/, "=<id>;"), `${relay.cookieName}=<id>; HttpOnly; SameSite=Strict; Path=${P}/; Max-Age=7200`);
    const cookie = setCookie.split(";")[0];
    assert.equal((await postTicket(relay, ticket)).status, 401, "a ticket works once");

    // Only paths under the prefix carry and accept the session.
    assert.equal((await http(relay.port, "GET", "/api/whoami", { ...HOST, Cookie: cookie })).status, 401, "outside the prefix");
    assert.equal((await http(relay.port, "GET", "/", { ...HOST, Cookie: cookie })).status, 401, "the root is the locked page");
    const whoami = await http(relay.port, "GET", `${P}/api/whoami?token=evil`, { ...HOST, Cookie: `${cookie}; NEKO_SESSION=x`, Authorization: "Bearer evil" });
    assert.equal(whoami.status, 200);
    assert.equal(whoami.headers["set-cookie"], undefined, "neko's cookies are dropped");
    assert.equal(whoami.headers["access-control-allow-origin"], undefined, "CORS headers are dropped");
    assert.equal(whoami.headers["access-control-allow-credentials"], undefined);
    assert.equal(whoami.headers["x-frame-options"], "DENY");
    const forwarded = neko.seen.findLast((r) => r.url.startsWith("/api/whoami"));
    assert.equal(forwarded.url, "/api/whoami", "prefix and query string stripped");
    assert.equal(forwarded.headers.authorization, "Bearer user-token", "the owner's own login, not the relay's admin one");
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal((await http(relay.port, "GET", `${P}/`, { ...HOST, Cookie: cookie })).status, 200, "the client under the prefix");
    assert.equal((await http(relay.port, "GET", `${P}/api/whoami`, HOST)).status, 401, "no session");
    assert.equal((await http(relay.port, "GET", `/s-${"0".repeat(32)}/api/whoami`, { ...HOST, Cookie: cookie })).status, 401, "another prefix");
    for (const path of ["/metrics", "/health", "/api/members", "/api/sessions", "/debug/pprof/"]) {
      assert.equal((await http(relay.port, "GET", `${P}${path}`, { ...HOST, Cookie: cookie })).status, 403, path);
    }
    assert.equal((await http(relay.port, "POST", `${P}/api/room/control/take`, { ...HOST, Cookie: cookie })).status, 403, "writes need the viewer's Origin");
    assert.equal((await http(relay.port, "POST", `${P}/api/room/control/take`, { ...ORIGIN_HEADERS, Cookie: cookie })).status, 200);
    assert.ok(!neko.seen.some((r) => r.url === "/metrics" || r.url === "/api/members"), "refused routes never reach neko");

    // The owner logs in to neko as a regular member, so neko's client (the iPad and desktop layout)
    // neither shows nor calls its admin actions; those routes stay refused all the same.
    assert.deepEqual(
      neko.state.logins.filter((l) => l.username.startsWith("owner-")).map((l) => l.admin),
      [false],
      "the owner's viewer login is not an admin",
    );
    for (const [method, path] of [
      ["POST", "/api/room/settings"],
      ["POST", "/api/room/broadcast/start"],
      ["POST", "/api/room/broadcast/stop"],
      ["POST", "/api/members/abc"],
      ["DELETE", "/api/sessions/abc"],
      ["POST", "/api/room/upload/drop"],
      ["POST", "/api/filetransfer"],
      ["GET", "/api/filetransfer"],
    ]) {
      const refused = await http(relay.port, method, `${P}${path}`, { ...ORIGIN_HEADERS, Cookie: cookie });
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.equal(JSON.parse(refused.body).message, BLOCKED_TEXT);
    }
    assert.ok(!neko.seen.some((r) => /^\/api\/(room\/settings|room\/broadcast|members|sessions|room\/upload|filetransfer)/.test(r.url)), "admin routes never reach neko");
    assert.ok(logs.includes("refused POST /api/room/settings"), "refusals are logged by method and path");
    assert.equal((await http(relay.port, "POST", `${P}/api/room/control/request`, { ...HOST, Cookie: cookie })).status, 403);
    assert.ok(logs.includes("refused POST /api/room/control/request (origin)"), "an Origin refusal is logged too");

    // The web app manifest: WebKit fetches it without cookies, so the relay answers it itself (a
    // constant, never neko's file), under the prefix only.
    const seenBefore = neko.seen.length;
    for (const headers of [HOST, { ...HOST, Cookie: cookie }]) {
      const manifest = await http(relay.port, "GET", `${P}/site.webmanifest`, headers);
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers["content-type"], "application/manifest+json");
      assert.equal(manifest.body, MANIFEST);
      assert.equal(manifest.headers["set-cookie"], undefined);
    }
    assert.equal((await http(relay.port, "HEAD", `${P}/site.webmanifest`, HOST)).status, 200);
    assert.equal(neko.seen.length, seenBefore, "the manifest never goes to neko");
    assert.equal((await http(relay.port, "POST", `${P}/site.webmanifest`, ORIGIN_HEADERS)).status, 401, "only GET and HEAD without a session");
    assert.equal((await http(relay.port, "GET", "/site.webmanifest", HOST)).status, 401, "not outside the prefix");
    assert.equal((await http(relay.port, "GET", `/s-${"0".repeat(32)}/site.webmanifest`, HOST)).status, 401, "not under another prefix");

    // WebSocket: only under the prefix, own Origin and session; upstream carries neko's token, no query.
    assert.match(await upgrade(relay.port, { ...HOST, Cookie: cookie, Origin: "http://evil.example" }, `${P}/api/ws`), / 403 /);
    assert.match(await upgrade(relay.port, { ...HOST, Cookie: cookie }, `${P}/api/ws`), / 403 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS }, `${P}/api/ws`), / 401 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS, Cookie: cookie }, "/api/ws"), / 403 /, "outside the prefix");
    assert.match(await upgrade(relay.port, { Host: "evil.example", Cookie: cookie, Origin: "http://127.0.0.1:5301" }, `${P}/api/ws`), / 421 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS, Cookie: cookie }, `${P}/api/ws?token=evil`), / 101 /);
    const ws = neko.seen.findLast((r) => r.method === "UPGRADE");
    assert.equal(ws.url, "/api/ws");
    assert.equal(ws.headers.authorization, "Bearer user-token");
    assert.equal(ws.headers.cookie, undefined);

    // Status: only with the daemon's token.
    assert.equal((await http(relay.port, "GET", "/bp/status", HOST)).status, 401);
    const status = await http(relay.port, "GET", "/bp/status", { ...HOST, Authorization: `Bearer ${STATUS}` });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).nekoUp, true);

    // Logout drops the session.
    assert.equal((await http(relay.port, "POST", `${P}/api/logout`, { ...ORIGIN_HEADERS, Cookie: cookie })).status, 200);
    assert.equal((await http(relay.port, "GET", `${P}/api/whoami`, { ...HOST, Cookie: cookie })).status, 401);

    // No lockout (with rootless Docker every client has the same address): after many bad tickets a good one works.
    for (let i = 0; i < 25; i++) assert.equal((await postTicket(relay, `v1.${Math.floor(now / 1000) + 60}.aaaaaaaaaaaaaaaa.login.${"A".repeat(43)}`)).status, 401);
    assert.equal((await postTicket(relay, ticketAt(now, "nonce-nonce-nonce-2"))).status, 200);
    assert.ok(logs.every((line) => !line.includes(SECRET) && !line.includes("neko-token") && !line.includes("user-token") && !line.includes(ticket)), "logs hold no secrets or tickets");
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("relay sessions: 2 hours at most, 20 minutes without use, bound to the address they started from; bad tickets are slowed down, not locked out", async () => {
  const neko = await fakeNeko();
  let now = 1_800_000_000_000;
  const relay = await startRelay({
    nekoHost: "127.0.0.1",
    nekoPort: neko.port,
    listenHost: "::",
    listenPort: 0,
    origins: ["http://127.0.0.1:5301"],
    secret: SECRET,
    statusToken: STATUS,
    adminPassword: "admin-pw",
    userPassword: "user-pw",
    now: () => now,
  });
  const P = relay.prefix;
  const login = async (nonce, host = "127.0.0.1") => String((await postTicket(relay, ticketAt(now, nonce), ORIGIN_HEADERS, host)).headers["set-cookie"]).split(";")[0];
  const whoami = (cookie, host = "127.0.0.1") => http(relay.port, "GET", `${P}/api/whoami`, { ...HOST, Cookie: cookie }, undefined, host).then((r) => r.status);
  try {
    let cookie = await login("idle-idle-idle-01");
    now += 19 * 60_000;
    assert.equal(await whoami(cookie), 200, "used within 20 minutes");
    now += 19 * 60_000;
    assert.equal(await whoami(cookie), 200, "sliding: 38 minutes in, 19 since the last use");
    now += 21 * 60_000;
    assert.equal(await whoami(cookie), 401, "20 minutes without use");

    cookie = await login("ttl-ttl-ttl-ttl-01");
    for (let i = 0; i < 7; i++) {
      now += 15 * 60_000;
      assert.equal(await whoami(cookie), 200);
    }
    now += 16 * 60_000;
    assert.equal(await whoami(cookie), 401, "2 hours at most, however busy");

    cookie = await login("peer-peer-peer-01", "127.0.0.1");
    assert.equal(await whoami(cookie, "::1"), 401, "the cookie from another address is refused");
    assert.equal(await whoami(cookie, "127.0.0.1"), 200);

    // A bad ticket is answered after the constant delay (this relay uses the default 500 ms).
    const started = Date.now();
    assert.equal((await postTicket(relay, `v1.${Math.floor(now / 1000) + 60}.bbbbbbbbbbbbbbbb.login.${"B".repeat(43)}`, ORIGIN_HEADERS, "::1")).status, 401);
    assert.ok(Date.now() - started >= 450, "slowed down");
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("relay: a ticket counts as used only once neko let the owner in", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { log: () => {} });
  try {
    const ticket = ticketAt(Date.now(), "retry-retry-retry-1");
    neko.state.failLogin = true;
    assert.equal((await postTicket(relay, ticket)).status, 502, "neko not ready");
    neko.state.failLogin = false;
    assert.equal((await postTicket(relay, ticket)).status, 200, "the same link works once neko is up");
    assert.equal((await postTicket(relay, ticket)).status, 401, "and then never again");
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("relay: takeover state follows neko's control only while a viewer is connected, unsure counts as held then, and the last viewer leaving resets control", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  const read = async () => JSON.parse((await http(port, "GET", "/control")).body);
  const settle = async (check) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  try {
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: false, known: true });
    assert.equal((await http(port, "GET", "/other")).status, 404);
    assert.equal((await http(port, "POST", "/control")).status, 404);
    // A viewer connects (its WebSocket stays open).
    const created = await postTicket(relay, ticketAt(Date.now(), "ctrl-ctrl-ctrl-001"));
    const cookie = String(created.headers["set-cookie"]).split(";")[0];
    const socket = connect(relay.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(
      [`GET ${relay.prefix}/api/ws HTTP/1.1`, "Host: 127.0.0.1:5301", "Origin: http://127.0.0.1:5301", `Cookie: ${cookie}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    await new Promise((resolve) => socket.once("data", resolve));
    assert.equal(relay.state().viewers, 1);
    neko.state.hasHost = true;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: true, known: true });
    neko.state.hasHost = false;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: false, known: true });
    neko.state.controlFails = true;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: true, known: false }, "unsure while a viewer is connected: held");
    neko.state.controlFails = false;
    neko.state.hasHost = true;
    await relay.pollControl();
    // The last viewer leaves: control is reset.
    socket.destroy();
    await settle(() => relay.state().viewers === 0 && (neko.state.resets ?? 0) >= 1);
    assert.equal(relay.state().viewers, 0);
    assert.equal(neko.state.resets, 1, "control reset when the last viewer left");
    assert.deepEqual(await read(), { ownerControl: false, known: true });
    // Control still held with no viewer (a reset that did not take): the poll loop resets it again;
    // the run is never paused meanwhile.
    neko.state.hasHost = true;
    await relay.pollControl();
    assert.equal(neko.state.resets, 2, "reset retried from the poll loop");
    assert.deepEqual(await read(), { ownerControl: false, known: true });
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("relay: an https origin gets Secure cookies, and the relay refuses to start without its secrets", async () => {
  const neko = await fakeNeko();
  const base = { nekoHost: "127.0.0.1", nekoPort: neko.port, listenHost: "127.0.0.1", listenPort: 0, secret: SECRET, statusToken: STATUS, adminPassword: "admin-pw", userPassword: "user-pw" };
  const relay = await startRelay({ ...base, origins: ["http://127.0.0.1:5301", "https://box.tail.ts.net"] });
  try {
    const ticket = signViewerTicket(SECRET, { exp: Math.floor(Date.now() / 1000) + 300, nonce: "nonce-nonce-nonce-3", purpose: "takeover" });
    const created = await http(relay.port, "POST", "/bp/session", { Host: "box.tail.ts.net", Origin: "https://box.tail.ts.net", "Content-Type": "application/json" }, JSON.stringify({ ticket }));
    assert.equal(created.status, 200);
    assert.match(String(created.headers["set-cookie"]), /; Secure$/);
  } finally {
    await relay.close();
    await neko.close();
  }
  await assert.rejects(startRelay({ ...base, origins: ["http://127.0.0.1:5301"], secret: "" }), /secret/);
  await assert.rejects(startRelay({ ...base, origins: [] }), /origin/);
  await assert.rejects(startRelay({ ...base, origins: ["http://127.0.0.1:5301"], adminPassword: "" }), /password/);
  await assert.rejects(startRelay({ ...base, origins: ["http://127.0.0.1:5301"], userPassword: "" }), /user password/);
  await assert.rejects(startRelay({ ...base, origins: ["http://127.0.0.1:5301"], userPassword: "admin-pw" }), /user password/, "the owner never logs in as an admin");
});

test("the run's MCP filter pauses every tool call while the owner holds control", () => {
  const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
  assert.deepEqual(filterClientLine(call), { forward: call });
  const refused = filterClientLine(call, { ownerControl: true });
  const reply = JSON.parse(refused.reply);
  assert.equal(reply.id, 7);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, OWNER_CONTROL_TEXT);
  assert.match(OWNER_CONTROL_TEXT, /ask the owner with AskUserQuestion/);
  const list = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" });
  assert.deepEqual(filterClientLine(list, { ownerControl: true }), { forward: list }, "listing tools still works");
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entry, /const verdict = filterClientLine\(line, \{ ownerControl: guard\.held\(\), securing: guard\.securing\(\), signedIn \}\);/);
  assert.match(entry, /if \(signedIn\) calls\.started\(verdict\.forward\);/);
  assert.match(entry, /if \(kept !== null && signedIn\) kept = calls\.finish\(kept, guard\.held\(\)\);/);
  assert.match(entry, /if \(polling\) return;/, "never two polls at once");
  assert.match(entry, /setInterval\(\(\) => void poll\(\), 1000\)/);
});

// ---------------------------------------------------------------- docker arguments

test("bind addresses: only 127.0.0.1 or a Tailscale address", () => {
  for (const ok of ["127.0.0.1", "100.96.145.38", "100.64.0.1", "100.127.255.254"]) assert.equal(bindHostAllowed(ok), true, ok);
  for (const bad of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "152.53.114.172", "100.128.0.1", "100.63.255.255", "::", "localhost", "", "256.1.1.1"]) {
    assert.equal(bindHostAllowed(bad), false, bad);
  }
});

test("stack: names, networks, a profile volume, and labels that keep it out of the launcher sweep", () => {
  assert.deepEqual(stackNames("0a1b2c3d"), {
    network: "bp-si-0a1b2c3d-net",
    publicNetwork: "bp-si-0a1b2c3d-pub",
    proxy: "bp-si-0a1b2c3d-proxy",
    neko: "bp-si-0a1b2c3d-neko",
    relay: "bp-si-0a1b2c3d-relay",
    volume: "bp-si-0a1b2c3d-profile",
  });
  assert.throws(() => stackNames("../x"), /stack id/);
  const networks = stackNetworkArgs(input());
  assert.ok(networks.internal.includes("--internal"));
  assert.ok(!networks.public.includes("--internal"));
  for (const args of [stackProxyArgs(input()), stackNekoArgs(input(), KEYS), stackRelayArgs(input(), KEYS)]) {
    assert.ok(value(args, "--label").some((label) => label.startsWith(`${STACK_LABEL}=`)));
    assert.ok(value(args, "--label").includes(`${INSTANCE_LABEL}=${INSTANCE}`));
    assert.ok(!value(args, "--label").some((label) => label.startsWith(`${CONTAINER_LABEL}=`)), "never swept by launcher pid");
  }
  assert.equal(signedInImageTag("af349826d882ffff"), "browser-prompt-signed-in:neko3.2.0-af349826d882");
  assert.throws(() => signedInImageTag("zz"), /hash/);
});

test("neko: internal network only, four capabilities, sandbox profile, read-only, the profile volume, no metrics, passwords only as env", () => {
  const args = stackNekoArgs(input(), KEYS);
  assert.deepEqual(value(args, "--network"), ["bp-si-0a1b2c3d-net"]);
  assert.deepEqual(value(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(value(args, "--cap-add").sort(), ["CHOWN", "SETGID", "SETUID", "SYS_CHROOT"]);
  assert.ok(value(args, "--security-opt").includes("no-new-privileges"));
  assert.ok(value(args, "--security-opt").includes("seccomp=/state/runtime/seccomp.json"));
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(value(args, "--mount"), ["type=volume,source=bp-si-0a1b2c3d-profile,target=/home/neko/.config/chromium"]);
  assert.equal(value(args, "--publish").length + value(args, "-p").length, 0, "neko publishes nothing");
  const env = value(args, "--env");
  for (const expected of [
    "NEKO_SERVER_METRICS=false",
    "NEKO_SESSION_COOKIE_ENABLED=false",
    "NEKO_PLUGINS_ENABLED=false",
    "NEKO_FILETRANSFER_ENABLED=false",
    "NEKO_WEBRTC_TCPMUX=5302",
    "NEKO_WEBRTC_NAT1TO1=100.96.145.38",
    "NEKO_WEBRTC_ICESERVERS_FRONTEND=[]",
    "NEKO_WEBRTC_ICESERVERS_BACKEND=[]",
    "BP_PROXY=http://bp-si-0a1b2c3d-proxy:3128",
    `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${KEYS.nekoAdminPassword}`,
  ])
    assert.ok(env.includes(expected), expected);
  assert.equal(args.at(-1), NEKO_IMAGE);
  assert.ok(value(args, "--log-driver").includes("none"));
  assert.throws(() => stackNekoArgs(input({ nekoImage: "ghcr.io/m1k1o/neko/chromium:latest" }), KEYS), /pinned/);
  assert.throws(() => stackNekoArgs(input({ bindHost: "0.0.0.0" }), KEYS), /binds only/);
  assert.doesNotThrow(() => checkStackRun(args, "neko", input()));
});

test("relay and proxy: published only on the bind address, no capabilities, no mounts", () => {
  const relay = stackRelayArgs(input(), KEYS);
  assert.deepEqual(value(relay, "--publish"), ["100.96.145.38:5301:8080/tcp", "100.96.145.38:5302:5302/tcp"]);
  assert.deepEqual(value(relay, "--network"), ["bp-si-0a1b2c3d-pub"]);
  assert.equal(value(relay, "--cap-add").length, 0);
  assert.equal(value(relay, "--mount").length, 0);
  assert.ok(value(relay, "--env").includes("BP_PUBLIC_ORIGINS=http://100.96.145.38:5301"));
  assert.ok(value(relay, "--env").includes("BP_NEKO_HOST=bp-si-0a1b2c3d-neko"));
  assert.ok(value(relay, "--env").includes(`BP_NEKO_USER_PASSWORD=${KEYS.nekoUserPassword}`), "the owner's viewer logs in as a regular member");
  assert.ok(value(relay, "--env").includes(`BP_NEKO_ADMIN_PASSWORD=${KEYS.nekoAdminPassword}`), "the relay's own service login");
  assert.ok(value(relay, "--env").includes("BP_CONTROL_PORT=8081"));
  assert.ok(value(relay, "--env").includes("BP_CONTROL_SUBNET=__BP_SUBNET__"));
  assert.ok(value(relay, "--env").includes("BP_MAX_LIFETIME_S=604800"));
  assert.ok(!value(relay, "--publish").some((p) => p.includes("8081")), "the control port is never published");
  const relayMain = readFileSync(new URL("../server-browser/relay-main.mjs", import.meta.url), "utf8");
  assert.match(relayMain, /reached the maximum lifetime; stopping/);
  assert.equal(relay.at(-1), "/opt/browser-prompt/relay-main.mjs");
  assert.doesNotThrow(() => checkStackRun(relay, "relay", input()));
  const local = stackRelayArgs(input({ bindHost: "127.0.0.1", origins: viewerOrigins("127.0.0.1", 5301, "") }), KEYS);
  assert.deepEqual(value(local, "--publish"), ["127.0.0.1:5301:8080/tcp", "127.0.0.1:5302:5302/tcp"]);
  const proxy = stackProxyArgs(input());
  assert.deepEqual(value(proxy, "--network"), ["bp-si-0a1b2c3d-pub"]);
  assert.ok(value(proxy, "--env").includes("BP_ALLOW_CLIENTS=__BP_SUBNET__"));
  assert.ok(value(proxy, "--env").includes("BP_BLOCKED_IPS=100.96.145.38,152.53.114.172"));
  assert.doesNotThrow(() => checkStackRun(proxy, "proxy", input()));
});

test("checkStackRun refuses anything that lifts the isolation", () => {
  const neko = stackNekoArgs(input(), KEYS);
  const relay = stackRelayArgs(input(), KEYS);
  const proxy = stackProxyArgs(input());
  const insert = (args, ...extra) => [...args.slice(0, 1), ...extra, ...args.slice(1)];
  assert.throws(() => checkStackRun(insert(neko, "--privileged"), "neko", input()), /--privileged/);
  assert.throws(() => checkStackRun(insert(neko, "-v", "/:/host"), "neko", input()), /-v/);
  assert.throws(() => checkStackRun(insert(neko, "--mount", "type=bind,source=/,target=/host"), "neko", input()), /profile volume/);
  assert.throws(() => checkStackRun(insert(neko, "--cap-add", "SYS_ADMIN"), "neko", input()), /capability/);
  assert.throws(() => checkStackRun(insert(neko, "--security-opt", "seccomp=unconfined"), "neko", input()), /security option/);
  assert.throws(() => checkStackRun(neko.filter((a) => a !== "--read-only"), "neko", input()), /read-only/);
  assert.throws(() => checkStackRun(neko.map((a) => (a === "bp-si-0a1b2c3d-net" ? "bridge" : a)), "neko", input()), /network/);
  assert.throws(() => checkStackRun(insert(neko, "--publish", "0.0.0.0:9222:9222"), "neko", input()), /published/);
  assert.throws(() => checkStackRun(relay.map((a) => a.replace("100.96.145.38:5301", "0.0.0.0:5301")), "relay", input()), /bind address/);
  assert.throws(() => checkStackRun(insert(relay, "--publish", "100.96.145.38:9222:9222/tcp"), "relay", input()), /bind address/);
  assert.throws(() => checkStackRun(insert(relay, "-p", "100.96.145.38:1:1"), "relay", input()), /-p/);
  assert.throws(() => checkStackRun(insert(relay, "--cap-add", "SYS_CHROOT"), "relay", input()), /capability/);
  assert.throws(() => checkStackRun(insert(proxy, "--network", "host"), "proxy", input()), /network/);
  assert.throws(() => checkStackRun(insert(proxy, "--mount", `type=volume,source=bp-si-0a1b2c3d-profile,target=/x`), "proxy", input()), /mounts/);
  assert.throws(() => checkStackRun(relay.map((a) => (a === SERVER_IMAGE ? "evil:latest" : a)), "relay", input()), /pinned/);
});

// ---------------------------------------------------------------- the run's MCP container and launcher

const agentInput = { stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE, agentId: "agent-1", nonce: "abcdef123456", blockedIps: ["100.96.145.38"] };

test("signed-in plan: the MCP container joins neko's network namespace, attaches to the DevTools port only, and is swept like a run's", () => {
  const plan = signedInPlan("/usr/bin/docker", agentInput);
  assert.equal(plan.kind, "signed-in");
  assert.equal(plan.neko, "bp-si-0a1b2c3d-neko");
  const args = plan.agent.run;
  assert.deepEqual(value(args, "--network"), ["container:bp-si-0a1b2c3d-neko"]);
  assert.deepEqual(value(args, "--cap-drop"), ["ALL"]);
  assert.equal(value(args, "--cap-add").length, 0);
  assert.ok(args.includes("--read-only") && args.includes("-i") && args.includes("--rm"));
  assert.ok(value(args, "--env").includes("BP_CDP_ENDPOINT=http://127.0.0.1:9222"));
  assert.ok(value(args, "--env").includes("BP_CONTROL_URL=http://bp-si-0a1b2c3d-relay:8081/control"));
  assert.ok(value(args, "--label").includes(`${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`));
  assert.ok(value(args, "--label").includes(`${CONTAINER_AGENT_LABEL}=agent-1`));
  assert.equal(args.at(-1), SERVER_IMAGE);
  assert.doesNotThrow(() => checkPlan(JSON.parse(JSON.stringify(plan))));
});

test("the launcher refuses tampered signed-in plans", () => {
  const plan = () => JSON.parse(JSON.stringify(signedInPlan("/usr/bin/docker", agentInput)));
  const tamper = (fn) => {
    const p = plan();
    fn(p);
    return p;
  };
  assert.throws(() => checkPlan(tamper((p) => (p.neko = "some-other-container"))), /signed-in browser name/);
  assert.throws(() => checkPlan(tamper((p) => p.agent.run.splice(1, 0, "--privileged"))), /--privileged/);
  assert.throws(() => checkPlan(tamper((p) => p.agent.run.splice(1, 0, "-v", "/:/host"))), /-v/);
  assert.throws(() => checkPlan(tamper((p) => p.agent.run.splice(1, 0, "--cap-add", "SYS_CHROOT"))), /cap-add/);
  assert.throws(() => checkPlan(tamper((p) => (p.agent.run = p.agent.run.map((a) => (a.startsWith("container:") ? "container:paseo-hub" : a))))), /network/);
  assert.throws(() => checkPlan(tamper((p) => (p.agent.run = p.agent.run.map((a) => (a.startsWith("container:") ? "host" : a))))), /network/);
  assert.throws(() => checkPlan(tamper((p) => (p.agent.run = p.agent.run.map((a) => a.replace("127.0.0.1:9222", "evil:9222"))))), /DevTools/);
  assert.throws(() => checkPlan(tamper((p) => (p.agent.run[p.agent.run.length - 1] = "alpine:latest"))), /pinned/);
  assert.throws(() => checkPlan(tamper((p) => (p.agent.run = p.agent.run.map((a) => a.replace("bp-si-0a1b2c3d-relay:8081", "evil.example:80"))))), /takeover state/);
  assert.throws(() => checkPlan(tamper((p) => (p.docker = "docker"))), /absolute/);
});

test("the launcher waits for neko, runs the MCP container on stdio, and removes it afterwards", async () => {
  const plan = JSON.parse(JSON.stringify(signedInPlan("/usr/bin/docker", agentInput)));
  const calls = [];
  let inspections = 0;
  let spawned = null;
  const code = await launch(plan, {
    run: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") return { ok: true, stdout: ++inspections < 3 ? "false\n" : "true\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
    sleep: async () => {},
    pid: 4242,
    now: () => 1_800_000_000_000,
    onSignal: () => {},
    spawnBrowser: (args) => {
      spawned = args;
      const handlers = {};
      setTimeout(() => handlers.exit?.(0, null), 5);
      return { on: (event, fn) => (handlers[event] = fn), kill: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(inspections, 3);
  assert.ok(spawned.includes(`browser-prompt.launcher-pid=4242`));
  assert.deepEqual(calls.at(-1), ["rm", "-f", plan.agent.name]);
  assert.ok(!calls.some((args) => args.includes(plan.neko) && (args[0] === "rm" || args[0] === "stop")), "never touches neko");

  let t = 0;
  const gone = await launch(plan, {
    run: async () => ({ ok: false, stdout: "", stderr: "No such container" }),
    sleep: async () => {
      t += 2000;
    },
    now: () => t,
    waitMs: 10_000,
    onSignal: () => {},
    log: () => {},
    spawnBrowser: () => assert.fail("must not start without neko"),
  });
  assert.equal(gone, 1);
});

test("the CDP mode of the entry point refuses any endpoint but neko's loopback DevTools port", () => {
  const result = spawnSync(process.execPath, [new URL("../server-browser/entrypoint.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, BP_CDP_ENDPOINT: "http://100.96.145.38:9222" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BP_CDP_ENDPOINT may only be http:\/\/127\.0\.0\.1:9222/);
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entry, /const attachedBrowser = \{ browserName: "chromium", isolated: false, cdpEndpoint, cdpTimeout: 30_000 \};/);
  assert.match(entry, /network: \{ blockedOrigins \}/, "the same origin rules in both modes");
});

// ---------------------------------------------------------------- gate

test("gate: signed-in runs need their own label, ticket and run marker; Server browser runs are not signed-in runs", async () => {
  const tickets = new Set(["ticket-ok"]);
  // As the daemon wires it: the card's record (with `recordMarker`) is checked for the signed-in marker.
  const deps = (recordMarker) => ({
    consumeTicket: (ticket) => tickets.delete(ticket),
    isRecorded: async (q) => serverRunRecorded([[`src:card-1`, q.runId, recordMarker]], q, SIGNED_IN_RUN_MARKER),
  });
  assert.deepEqual(signedInRunLabels("ticket-ok"), { [BROWSER_LABEL]: SIGNED_IN_LABEL_VALUE, [TICKET_LABEL]: "ticket-ok" });
  assert.equal(isSignedInRun(signedInRunLabels("x")), true);
  assert.equal(isServerBrowserRun(signedInRunLabels("x")), false);
  assert.equal(isSignedInRun(serverRunLabels("x")), false);
  const reportLabels = (await import("../shared/report-back.ts")).runLabels;
  const base = reportLabels("src", "card-1");
  const create = { agentId: "run-1", reason: "create", labels: { ...base, ...signedInRunLabels("ticket-ok") } };
  assert.equal(await shouldAttachServerBrowser(create, deps(SIGNED_IN_RUN_MARKER)), false, "the Server browser gate ignores signed-in runs");
  assert.equal(await shouldAttachSignedIn(create, deps(SIGNED_IN_RUN_MARKER)), true);
  assert.equal(await shouldAttachSignedIn(create, deps(SIGNED_IN_RUN_MARKER)), false, "the ticket is used once");
  const resume = { agentId: "run-1", reason: "resume", labels: { ...base, ...signedInRunLabels("x") } };
  assert.equal(await shouldAttachSignedIn(resume, deps(SIGNED_IN_RUN_MARKER)), true);
  assert.equal(await shouldAttachSignedIn(resume, deps("browser:server")), false, "a Server browser record is not a signed-in record");
  assert.equal(await shouldAttachSignedIn({ ...resume, purpose: "history" }, deps(SIGNED_IN_RUN_MARKER)), false);
});

// ---------------------------------------------------------------- idle

test("idle: stops only after 30 minutes without a run or viewer", () => {
  const base = { now: 10 * IDLE_STOP_MS, lastActive: 10 * IDLE_STOP_MS - IDLE_STOP_MS, agentRunning: false, viewers: 0, viewerIdleMs: IDLE_STOP_MS };
  assert.equal(shouldStopForIdle(base), true);
  assert.equal(shouldStopForIdle({ ...base, agentRunning: true }), false);
  assert.equal(shouldStopForIdle({ ...base, viewers: 1 }), false);
  assert.equal(shouldStopForIdle({ ...base, viewerIdleMs: 60_000 }), false, "a viewer was active recently");
  assert.equal(shouldStopForIdle({ ...base, lastActive: base.now - IDLE_STOP_MS + 1 }), false);
  assert.equal(shouldStopForIdle({ ...base, viewerIdleMs: null }), true, "relay unreachable: the run and link activity decide");
});

// ---------------------------------------------------------------- daemon side against a fake docker

/** Fake docker for the signed-in stack: images, networks, the volume and containers with labels and states. */
function fakeStackDocker({ serverImage = true, nekoImage = true } = {}) {
  const calls = [];
  const state = { images: new Set([...(serverImage ? ["server"] : []), ...(nekoImage ? ["neko"] : [])]), containers: new Map(), networks: new Set(), volumes: new Set(), agents: [] };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (_command, args) => {
    calls.push(args);
    const [sub, second] = args;
    if (sub === "info") return ok('["name=rootless"]');
    if (sub === "image" && second === "inspect") {
      const tag = args.at(-1);
      const kind = tag.startsWith("browser-prompt-signed-in:") ? (/-bw\d/.test(tag) ? "bitwarden" : "neko") : "server";
      return state.images.has(kind) ? ok("sha256:x") : { code: 1, stdout: "", stderr: "No such image" };
    }
    if (sub === "exec") {
      state.execs = [...(state.execs ?? []), args];
      if (args.includes("/opt/bitwarden/browser-prompt-pin.json")) return /-bw\d/.test(state.nekoImage ?? "") ? ok(JSON.stringify({ id: state.bitwardenId ?? "k".repeat(32) })) : { code: 1, stdout: "", stderr: "No such file" };
      if (args.at(-1) === "/home/neko/.config/chromium/.bp-bitwarden-ids") return state.idsFile === undefined ? { code: 1, stdout: "", stderr: "" } : ok(state.idsFile);
      if (args.includes("sh") && /bp-bitwarden-ids/.test(args.at(-1))) {
        state.idsFile = /'([a-p]{32})\n'/.exec(args.at(-1))?.[1] ? `${/'([a-p]{32})\n'/.exec(args.at(-1))[1]}\n` : "";
        return ok();
      }
      return ok();
    }
    if (sub === "build") {
      state.images.add(args.includes("browser-prompt.signed-in=image") ? "neko" : args.includes("browser-prompt.signed-in=bitwarden-image") ? "bitwarden" : "server");
      return ok();
    }
    if (sub === "ps") {
      const format = args[args.indexOf("--format") + 1];
      if (args.some((a) => a.startsWith(`label=${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`))) return ok(state.agents.map((a) => `${a.id}\t${a.agent}`).join("\n"));
      if (format.startsWith("{{.Names}}")) return ok([...state.containers].map(([name, s]) => `${name}\t${s}`).join("\n"));
      return ok("");
    }
    if (sub === "network" && second === "create") {
      state.networks.add(args.at(-1));
      return ok();
    }
    if (sub === "network" && second === "inspect") return ok("172.30.0.0/16 ");
    if (sub === "network" && second === "rm") {
      state.networks.delete(args[2]);
      return ok();
    }
    if (sub === "network") return ok();
    if (sub === "volume" && second === "create") {
      state.volumes.add(args.at(-1));
      return ok();
    }
    if (sub === "volume" && second === "rm") {
      state.volumes.delete(args[2]);
      return ok();
    }
    if (sub === "run" && args.includes("/opt/browser-prompt/bitwarden-lock.mjs")) {
      const at = args.indexOf("/opt/browser-prompt/bitwarden-lock.mjs");
      const mode = args[at + 1];
      state.tools = [...(state.tools ?? []), { mode, ids: args.slice(at + 2), args }];
      const answer = (state.tool ?? (() => ({ locked: true, detail: "" })))(mode, args.slice(at + 2));
      return ok(`${JSON.stringify({ mode, ...answer })}\n`);
    }
    if (sub === "run") {
      state.containers.set(value(args, "--name")[0], "running");
      if (/-neko$/.test(value(args, "--name")[0])) state.nekoImage = args.at(-1);
      const tag = value(args, "--label").find((label) => label.startsWith("browser-prompt.signed-in-config="));
      if (tag) state.relayTag = tag.split("=")[1];
      return ok("cid");
    }
    if (sub === "inspect" && args[2] === "{{.Config.Image}}") return ok(/-neko$/.test(args[3]) && state.containers.has(args[3]) ? `${state.nekoImage}\n` : "");
    if (sub === "inspect") return args[2].includes("IPAddress") ? ok("172.30.0.2\n") : ok(state.relayTag ?? "");
    if (sub === "stop") return ok();
    if (sub === "rm") {
      for (const name of args.slice(2)) state.containers.delete(name);
      state.agents = state.agents.filter((a) => !args.includes(a.id));
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { run, calls, state };
}

function makeSignedIn(docker, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bp-si-"));
  const sb = createServerBrowser({
    run: docker.run,
    env: {},
    log: () => {},
    cacheMs: 0,
    findDocker: async () => "/usr/bin/docker",
    findNode: async () => "/usr/bin/node",
    dockerHost: async () => null,
    runtimeRoot: join(dir, "rt"),
    buildRoot: join(dir, "build"),
    instanceId: INSTANCE,
    interfaces: () => ({ tailscale0: [{ address: "100.96.145.38" }] }),
  });
  let relayUp = true;
  let relayViewers = 0;
  let relayLastViewer = null;
  let t = 1_800_000_000_000;
  const si = createSignedIn({
    serverBrowser: sb,
    run: docker.run,
    log: () => {},
    keysFile: join(dir, "keys.json"),
    buildRoot: join(dir, "build"),
    bindHost: async () => "100.96.145.38",
    config: async () => ({ port: 5301, httpsBaseUrl: "" }),
    relayStatus: async () => (relayUp ? { viewers: relayViewers, idleMs: relayLastViewer === null ? 0 : t - relayLastViewer, nekoUp: true, portrait: false } : null),
    sleep: async () => {},
    now: () => t,
    ...extra,
  });
  return {
    si,
    dir,
    advance: (ms) => (t += ms),
    /** The relay answers with `viewers` and the time since its last viewer activity (now, when `lastViewerAt` is null). */
    setRelay: (up, viewers = 0, lastViewerAt = null) => {
      relayUp = up;
      relayViewers = viewers;
      relayLastViewer = lastViewerAt;
    },
    now: () => t,
  };
}

test("daemon: no image means no start and no download; Download and build builds the missing images only on request", async () => {
  const docker = fakeStackDocker({ nekoImage: false });
  const { si } = makeSignedIn(docker);
  assert.equal((await si.status()).state, "no-image");
  assert.deepEqual(await si.prepare({ sourceId: "s", cardId: "c" }), { ok: false, state: "no-image", detail: "" });
  assert.equal((await si.viewerLink({ purpose: "login", portrait: false })).ok, false);
  assert.ok(!docker.calls.some((args) => args[0] === "build" || args[0] === "pull" || args[0] === "run"), "nothing downloaded or started");
  await si.status({ build: true });
  for (let i = 0; i < 100 && (await si.status()).state === "building"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(docker.calls.some((args) => args[0] === "build" && args.includes("browser-prompt.signed-in=image")));
  assert.equal((await si.status()).state, "ready");
});

test("daemon: a viewer link starts the stack in order with checked arguments; one run at a time", async () => {
  const docker = fakeStackDocker();
  const { si, dir } = makeSignedIn(docker);
  const link = await si.viewerLink({ purpose: "login", portrait: true });
  assert.equal(link.ok, true);
  assert.match(link.url, /^http:\/\/100\.96\.145\.38:5301\/bp\/open#t=v1\.\d{10}\.[A-Za-z0-9_-]+\.login\.[A-Za-z0-9_-]{43}&p=1$/);
  const order = docker.calls.filter((args) => ["run", "network", "volume"].includes(args[0]) && args[1] !== "inspect").map((args) => (args[0] === "run" ? `run ${value(args, "--name")[0]}` : `${args[0]} ${args[1]} ${args.at(-1)}`));
  const stack = stackNames(order.find((line) => line.startsWith("run ")).split(" ")[1].replace(/^bp-si-([0-9a-f]{8}).*/, "$1"));
  assert.deepEqual(
    order.filter((line) => !line.startsWith("network rm")),
    [
      `network create ${stack.network}`,
      `network create ${stack.publicNetwork}`,
      `volume create ${stack.volume}`,
      `run ${stack.proxy}`,
      `network connect ${stack.proxy}`,
      `run ${stack.neko}`,
      `run ${stack.relay}`,
      `network connect ${stack.relay}`,
    ],
  );
  const nekoRun = docker.calls.find((args) => args[0] === "run" && value(args, "--name")[0] === stack.neko);
  assert.ok(value(nekoRun, "--env").some((e) => /^BP_PROXY=http:\/\/bp-si-[0-9a-f]{8}-proxy:3128$/.test(e)), "the proxy by name");
  const proxyRun = docker.calls.find((args) => args[0] === "run" && value(args, "--name")[0] === stack.proxy);
  assert.ok(value(proxyRun, "--env").includes("BP_ALLOW_CLIENTS=172.30.0.0/16"));
  const keysFile = join(dir, "keys.json");
  assert.equal(statSync(keysFile).mode & 0o777, 0o600, "the keys file is private");
  const keys = await loadKeys(keysFile);
  assert.ok(value(nekoRun, "--env").includes(`NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${keys.nekoAdminPassword}`));
  const ticket = decodeURIComponent(new URL(link.url).hash.slice(3).split("&")[0]);
  assert.equal(verifyTicket(relaySecret(keys), ticket, 1_800_000_000).ok, true, "the relay accepts the link's ticket");
  assert.equal(verifyTicket(keys.viewerSecret, ticket, 1_800_000_000).ok, false, "the relay never gets the viewer key itself");
  const relayRun = docker.calls.find((args) => args[0] === "run" && /-relay$/.test(value(args, "--name")[0]));
  assert.ok(value(relayRun, "--env").includes(`BP_VIEWER_SECRET=${relaySecret(keys)}`));

  // One run at a time: a ticket out, or an MCP container of another run, makes the next one busy.
  const first = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(first.ok, true);
  assert.deepEqual(await si.prepare({ sourceId: "s", cardId: "c2" }), { ok: false, state: "busy", detail: "" });
  assert.equal(si.consumeTicket(first.ticket, { sourceId: "s", cardId: "c" }), true);
  const mcp = await si.mcpServer("run-a");
  assert.ok("server" in mcp);
  assert.equal(mcp.server.command, "/usr/bin/node");
  const plan = JSON.parse(Buffer.from(mcp.server.args[1], "base64").toString("utf8"));
  assert.doesNotThrow(() => checkPlan(plan));
  assert.deepEqual(await si.mcpServer("run-b"), { refused: "busy" }, "admitted run holds it until its container shows up");
  docker.state.agents.push({ id: "abcdef123456", agent: "run-a" });
  assert.deepEqual(await si.mcpServer("run-b"), { refused: "busy" });
  assert.ok("server" in (await si.mcpServer("run-a")), "the same run may open again (resume)");
  assert.equal((await si.status()).busy, true);
});

test("daemon: stop keeps the profile, log out removes it and the keys; rotate restarts only the relay", async () => {
  const docker = fakeStackDocker();
  const { si, dir } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  const keysBefore = await loadKeys(join(dir, "keys.json"));
  docker.calls.length = 0;
  await si.rotateKey();
  const keysAfter = await loadKeys(join(dir, "keys.json"));
  assert.notEqual(keysAfter.viewerSecret, keysBefore.viewerSecret);
  assert.notEqual(relaySecret(keysAfter), relaySecret(keysBefore), "links from before are dead");
  assert.equal(keysAfter.nekoAdminPassword, keysBefore.nekoAdminPassword, "neko keeps running with its password");
  const runs = docker.calls.filter((args) => args[0] === "run").map((args) => value(args, "--name")[0]);
  assert.equal(runs.length, 1);
  assert.match(runs[0], /-relay$/);

  docker.calls.length = 0;
  await si.stop();
  assert.ok(docker.calls.some((args) => args[0] === "stop" && args[1] === "-t" && args[2] === "45" && /-neko$/.test(args[3])), "graceful: cookies are written");
  assert.ok(!docker.calls.some((args) => args[0] === "volume"), "stop keeps the logins");
  assert.equal(docker.state.containers.size, 0);
  assert.ok(docker.state.volumes.size === 1);

  await si.viewerLink({ purpose: "login", portrait: false });
  docker.state.agents.push({ id: "abcdef654321", agent: "run-x" });
  docker.calls.length = 0;
  await si.logout();
  assert.ok(docker.calls.some((args) => args[0] === "rm" && args.includes("abcdef654321")), "a run using it loses it first");
  assert.ok(docker.calls.some((args) => args[0] === "volume" && args[1] === "rm"), "the profile is removed");
  assert.equal(docker.state.volumes.size, 0);
  assert.equal(docker.state.networks.size, 0);
  assert.notEqual((await loadKeys(join(dir, "keys.json"))).viewerSecret, keysAfter.viewerSecret, "new keys after log out");
});

test("daemon: idle stop after 30 minutes without run or viewer; a changed address restarts only the relay", async () => {
  const docker = fakeStackDocker();
  const helper = makeSignedIn(docker);
  const { si } = helper;
  await si.viewerLink({ purpose: "login", portrait: false });
  helper.setRelay(true, 1);
  helper.advance(IDLE_STOP_MS * 2);
  assert.equal(await si.idleCheck(), false, "a viewer keeps it up");
  helper.setRelay(true, 0, helper.now());
  helper.advance(IDLE_STOP_MS - 1000);
  assert.equal(await si.idleCheck(), false, "the viewer left less than 30 minutes ago");
  helper.advance(2000);
  assert.equal(await si.idleCheck(), true);
  assert.equal(docker.state.containers.size, 0);

  await si.viewerLink({ purpose: "login", portrait: false });
  docker.calls.length = 0;
  docker.state.relayTag = "different";
  await si.viewerLink({ purpose: "login", portrait: false });
  const runs = docker.calls.filter((args) => args[0] === "run").map((args) => value(args, "--name")[0]);
  assert.deepEqual(runs.map((name) => name.replace(/^bp-si-[0-9a-f]{8}-/, "")), ["relay"]);
});

test("daemon: no Tailscale address means no viewer and no start", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker, { bindHost: async () => null });
  assert.equal((await si.status()).state, "no-address");
  assert.deepEqual(await si.viewerLink({ purpose: "login", portrait: false }), { ok: false, state: "no-address", detail: "" });
  const { si: lan } = makeSignedIn(fakeStackDocker(), { bindHost: async () => "192.168.1.5" });
  assert.equal((await lan.status()).state, "no-address", "a LAN address is never used");
});

// ---------------------------------------------------------------- image overrides

test("signed-in image: pinned neko, sandbox on, DevTools on loopback only, the proxy for everything, cookies kept, no forced extensions", () => {
  assert.match(NEKO_BASE_IMAGE, /^ghcr\.io\/m1k1o\/neko\/chromium:3\.2\.0@sha256:[0-9a-f]{64}$/);
  assert.ok(SIGNED_IN_FILES.Dockerfile.includes(`FROM ${NEKO_BASE_IMAGE}`));
  const conf = SIGNED_IN_FILES["chromium.conf"];
  assert.match(conf, /--remote-debugging-port=9222\n/);
  assert.match(conf, /--remote-debugging-address=127\.0\.0\.1\n/);
  assert.doesNotMatch(conf, /--no-sandbox|--bwsi/);
  const start = SIGNED_IN_FILES["chromium-start.sh"];
  assert.match(start, /--proxy-server="\$BP_PROXY" --proxy-bypass-list="<-loopback>"/);
  assert.match(start, /refusing to start Chromium without the proxy/);
  assert.match(start, /^PROFILE=\/home\/neko\/\.config\/chromium$/m);
  assert.match(start, /rm -f "\$PROFILE\/SingletonLock"/);
  const policies = JSON.parse(SIGNED_IN_FILES["policies.json"]);
  assert.equal(policies.DefaultCookiesSetting, 1);
  assert.equal(policies.DeveloperToolsAvailability, 1);
  assert.equal(policies.PasswordManagerEnabled, false);
  assert.equal(policies.DownloadRestrictions, 3);
  assert.equal(policies.ExtensionInstallForcelist, undefined);
  for (const blocked of ["file://*", "chrome://*", "chrome-untrusted://*", "chrome-search://*", "chrome-extension://*", "devtools://*", "view-source:*", "about:*", "javascript://*", "javascript:*", "data:*"]) {
    assert.ok(policies.URLBlocklist.includes(blocked), blocked);
  }
  assert.deepEqual(policies.URLAllowlist, ["about:blank", "chrome://newtab"]);
  assert.equal(policies.NewTabPageLocation, "about:blank");
  assert.equal(policies.MetricsReportingEnabled, false);
  assert.equal(policies.SafeBrowsingProtectionLevel, 1);
  assert.equal(policies.BackgroundModeEnabled, false);
  assert.equal(policies.SyncDisabled, true);
  assert.match(conf, /--disable-features=WebUIOmniboxPopup,WebUIOmniboxFullPopup,WebUIOmniboxAimPopup\n/, "the native address-bar popup: its WebUI one is a blocked chrome:// page");
  for (const flag of ["--disable-component-update", "--disable-domain-reliability", "--disable-breakpad", "--disable-sync", "--disable-quic"]) assert.ok(conf.includes(`${flag}\n`), flag);
  assert.deepEqual(policies.ExtensionInstallBlocklist, ["*"]);
  // iPad: neko shows its on-screen keyboard button only up to 768 px; the image links a stylesheet
  // that shows it on touch screens of any width (served under /assets/, which the relay allows).
  const css = SIGNED_IN_FILES["viewer.css"];
  assert.match(css, /@media \(pointer: coarse\) and \(min-width: 769px\) \{\s*\.phone\\:block \{\s*display: block;/);
  assert.match(SIGNED_IN_FILES.Dockerfile, /^COPY viewer\.css \/var\/www\/assets\/bp-viewer\.css$/m);
  // Served under a content-hashed name, so no browser keeps an old cached copy after an image update.
  assert.ok(SIGNED_IN_FILES.Dockerfile.includes(`css="bp-viewer-$(sha256sum bp-viewer.css | cut -c1-12).css"`));
  assert.ok(SIGNED_IN_FILES.Dockerfile.includes(`sed -i "s#</head>#<link rel=\\"stylesheet\\" href=\\"./assets/$css\\"><script src=\\"./assets/$js\\"></script></head>#" /var/www/index.html`));
  assert.ok(SIGNED_IN_FILES.Dockerfile.includes(`grep -q "href=\\"./assets/$css\\"" /var/www/index.html`));
  assert.equal(classifyRequest("GET", "/assets/bp-viewer-0123456789ab.css"), "static");
  for (const name of Object.keys(SIGNED_IN_FILES)) assert.equal(SIGNED_IN_FILES[name], readFileSync(new URL(`../signed-in/${name}`, import.meta.url), "utf8"), name);
});

/** Runs signed-in/viewer.js against a minimal fake DOM; returns the fakes. */
function loadViewerScript({ touch }) {
  const listeners = {};
  const calls = [];
  let observer = null;
  const textarea = {
    dataset: {},
    attrs: {},
    inputMode: "",
    spellcheck: true,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    focus() {
      calls.push(`focus:${this.inputMode}`);
      document.activeElement = this;
    },
    blur() {
      calls.push("blur");
      document.activeElement = document.body;
      this.listeners.blur?.();
    },
  };
  const toggle = { closest: (selector) => (selector === "[data-testid=keyboard-toggle]" ? toggle : null) };
  let toggleShown = false;
  const document = {
    body: { matches: () => false, isContentEditable: false },
    activeElement: null,
    documentElement: {},
    querySelector: (selector) => (selector === "canvas + textarea" ? textarea : selector === "[data-testid=keyboard-toggle]" && toggleShown ? toggle : null),
  };
  document.activeElement = document.body;
  class Element {}
  Object.setPrototypeOf(toggle, Element.prototype);
  const window = {
    addEventListener(type, fn, capture) {
      assert.equal(capture, true, `${type} listens in the capture phase`);
      (listeners[type] ??= []).push(fn);
    },
  };
  const sandbox = {
    window,
    document,
    Element,
    navigator: { maxTouchPoints: touch ? 5 : 0 },
    MutationObserver: class {
      constructor(fn) {
        observer = fn;
      }
      observe() {}
    },
  };
  if (touch) window.ontouchstart = null;
  const code = readFileSync(new URL("../signed-in/viewer.js", import.meta.url), "utf8");
  new Function(...Object.keys(sandbox), code)(...Object.values(sandbox));
  const fire = (type, event) => (listeners[type] ?? []).forEach((fn) => fn(event));
  return { window, document, textarea, calls, fire, mutate: () => observer(), showToggle: (shown) => (toggleShown = shown), toggle };
}

test("viewer.js: a tap focuses neko's key textarea without the on-screen keyboard (iPad hardware keyboard)", () => {
  const v = loadViewerScript({ touch: true });
  v.mutate();
  assert.equal(v.textarea.attrs.autocorrect, "off");
  assert.equal(v.textarea.attrs.autocapitalize, "off");
  assert.equal(v.textarea.attrs.autocomplete, "off");
  assert.equal(v.textarea.attrs.writingsuggestions, "false");
  assert.equal(v.textarea.spellcheck, false);
  assert.equal(v.textarea.inputMode, "none");
  // A tap elsewhere does nothing; a tap on the video focuses it once.
  v.fire("touchend", { target: {} });
  assert.deepEqual(v.calls, []);
  v.fire("touchend", { target: v.textarea });
  v.fire("pointerup", { target: v.textarea });
  assert.deepEqual(v.calls, ["focus:none"]);
  // Control arrives (neko shows its keyboard button): focused without a tap, unless the chat has focus.
  v.textarea.blur();
  v.calls.length = 0;
  v.showToggle(true);
  v.mutate();
  assert.deepEqual(v.calls, ["focus:none"]);
  v.showToggle(false);
  v.mutate();
  v.document.activeElement = { matches: (selector) => selector.includes("textarea"), isContentEditable: false };
  v.calls.length = 0;
  v.showToggle(true);
  v.mutate();
  assert.deepEqual(v.calls, [], "the chat keeps its focus");
});

test("viewer.js: neko's keyboard button still opens the on-screen keyboard", () => {
  const v = loadViewerScript({ touch: true });
  v.mutate();
  v.fire("touchend", { target: v.textarea });
  v.calls.length = 0;
  // Pressed while the textarea is focused silently: re-focus with inputmode="text" (neko's click focuses).
  v.fire("pointerdown", { target: v.toggle });
  assert.deepEqual(v.calls, ["blur"]);
  assert.equal(v.textarea.inputMode, "text");
  v.textarea.focus();
  // A second press closes it (neko blurs): no change by the script, and the next tap is silent again.
  v.calls.length = 0;
  v.fire("pointerdown", { target: v.toggle });
  v.fire("touchstart", { target: v.toggle });
  assert.deepEqual(v.calls, []);
  v.textarea.blur();
  assert.equal(v.textarea.inputMode, "none");
});

test("viewer.js: without touch it never moves focus (desktop Safari keeps neko's own hover focus)", () => {
  const v = loadViewerScript({ touch: false });
  v.mutate();
  assert.equal(v.textarea.attrs.autocorrect, "off");
  assert.equal(v.textarea.inputMode, "");
  v.fire("touchend", { target: v.textarea });
  v.fire("pointerup", { target: v.textarea });
  v.showToggle(true);
  v.mutate();
  assert.deepEqual(v.calls, []);
});

test("viewer.js: capitals and shifted symbols get Shift when the browser sent none", () => {
  const v = loadViewerScript({ touch: true });
  const sent = [];
  const pressed = {};
  const overlay = { client: { input: { key: (keysym, down) => sent.push(`${keysym.toString(16)}${down ? "+" : "-"}`) } }, keyboard: { pressed } };
  const press = (keysym) => {
    sent.length = 0;
    v.window.bpKeyDown(overlay, keysym);
    return sent.join(" ");
  };
  assert.equal(press(0x54), "ffe1+ 54+ ffe1-", "T");
  assert.equal(press(0x21), "ffe1+ 21+ ffe1-", "!");
  assert.equal(press(0x40), "ffe1+ 40+ ffe1-", "@");
  assert.equal(press(0x74), "74+", "t");
  assert.equal(press(0x31), "31+", "1");
  assert.equal(press(0xff08), "ff08+", "BackSpace");
  assert.equal(press(0xff0d), "ff0d+", "Return");
  assert.equal(press(0xffe1), "ffe1+", "Shift itself");
  pressed[0xffe1] = true;
  assert.equal(press(0x54), "54+", "Shift held on the hardware keyboard");
  delete pressed[0xffe1];
  pressed[0xffe2] = true;
  assert.equal(press(0x3f), "3f+", "right Shift held");
  delete pressed[0xffe2];
  v.fire("keydown", { getModifierState: (key) => key === "CapsLock" });
  assert.equal(press(0x54), "54+", "Caps Lock on: letters as they are");
  assert.equal(press(0x21), "ffe1+ 21+ ffe1-", "Caps Lock does not shift symbols");
  v.fire("keyup", { getModifierState: () => false });
  assert.equal(press(0x54), "ffe1+ 54+ ffe1-");
  // Shortcuts: no Shift while Ctrl, Alt or Meta is down (in neko's key state or the last key event).
  for (const modifier of [0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec, 0xfe03, 0xff7e]) {
    pressed[modifier] = true;
    assert.equal(press(0x54), "54+", `modifier ${modifier.toString(16)} held`);
    delete pressed[modifier];
  }
  for (const flag of ["ctrlKey", "altKey", "metaKey"]) {
    v.fire("keydown", { [flag]: true, getModifierState: () => false });
    assert.equal(press(0x41), "41+", flag);
    v.fire("keyup", { getModifierState: () => false });
  }
  assert.equal(press(0x41), "ffe1+ 41+ ffe1-", "after the modifier's keyup");
});

test("viewer.js: unknown key state means no Shift; Shift is always released", () => {
  const v = loadViewerScript({ touch: true });
  const sent = [];
  const input = { key: (keysym, down) => sent.push(`${keysym.toString(16)}${down ? "+" : "-"}`) };
  // neko's keyboard (or its `pressed` map) missing: the key goes out as neko would send it.
  for (const keyboard of [undefined, null, {}, { pressed: null }, { pressed: undefined }, { pressed: 1 }]) {
    sent.length = 0;
    v.window.bpKeyDown({ client: { input }, keyboard }, 0x54);
    assert.equal(sent.join(" "), "54+", JSON.stringify(keyboard));
  }
  // Sending the key throws: Shift is released anyway and the error goes on to neko.
  sent.length = 0;
  const failing = { key: (keysym, down) => { sent.push(`${keysym.toString(16)}${down ? "+" : "-"}`); if (keysym === 0x54) throw new Error("channel closed"); } };
  assert.throws(() => v.window.bpKeyDown({ client: { input: failing }, keyboard: { pressed: {} } }, 0x54), /channel closed/);
  assert.equal(sent.join(" "), "ffe1+ 54+ ffe1-");
});

test("signed-in image: viewer.js is linked and neko's onKeyDown calls bpKeyDown", () => {
  const dockerfile = SIGNED_IN_FILES.Dockerfile;
  assert.match(dockerfile, /^COPY viewer\.js \/var\/www\/assets\/bp-viewer\.js$/m);
  assert.ok(dockerfile.includes(`js="bp-viewer-$(sha256sum bp-viewer.js | cut -c1-12).js"`));
  assert.ok(dockerfile.includes(`mv bp-viewer.css "$css" && mv bp-viewer.js "$js"`));
  assert.equal(classifyRequest("GET", "/assets/bp-viewer-0123456789ab.js"), "static");
  // The image's sed, run on neko 3.2.0's onKeyDown (as minified in its bundle).
  const sed = dockerfile.match(/sed -i '(s\/this\\\.client[^']+)' "\$bundle"/);
  assert.ok(sed, "the bundle patch");
  const original =
    "onKeyDown(e){return this.active?this.ctrlDown&&e===$.v?(this.noKeyUp.add(e),!0):(ze(e)&&(this.ctrlDown=e),this.client.input.key(e,!0),ze(e)):(this.noKeyUp.add(e),!0)}onKeyUp(e){this.noKeyUp.delete(e)||(ze(e)&&(this.ctrlDown=0),this.client.input.key(e,!1))}";
  const result = spawnSync("sed", [sed[1]], { input: original, encoding: "utf8" });
  assert.equal(
    result.stdout,
    "onKeyDown(e){return this.active?this.ctrlDown&&e===$.v?(this.noKeyUp.add(e),!0):(ze(e)&&(this.ctrlDown=e),(window.bpKeyDown?window.bpKeyDown(this,e):this.client.input.key(e,!0)),ze(e)):(this.noKeyUp.add(e),!0)}onKeyUp(e){this.noKeyUp.delete(e)||(ze(e)&&(this.ctrlDown=0),this.client.input.key(e,!1))}",
  );
  // The build fails unless the anchor is found exactly once and the hook is in.
  assert.ok(dockerfile.includes(`[ "$(grep -o 'this\\.client\\.input\\.key(e,!0),ze(e))' "$bundle" | wc -l)" = 1 ]`));
  assert.ok(dockerfile.includes(`grep -q 'window.bpKeyDown(this,e)' "$bundle"`));
  assert.ok(dockerfile.includes(`grep -q "src=\\"./assets/$js\\"" /var/www/index.html`));
});

test("chromium-start.sh refuses to start Chromium without a valid proxy", () => {
  for (const proxy of ["", "http://evil.example:3128", "socks5://1.2.3.4:1080", "http://1.2.3.4:3128;rm -rf /"]) {
    const result = spawnSync("sh", ["-c", `sed 's/^  sleep 10$/  :/' "$0" | sh`, new URL("../signed-in/chromium-start.sh", import.meta.url).pathname], {
      env: { PATH: "/usr/bin:/bin", BP_PROXY: proxy },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, proxy);
    assert.match(result.stderr, /refusing to start Chromium without the proxy/);
  }
});

// ---------------------------------------------------------------- prompt, settings, surfaces

test("signed-in prompt: signed-in warning, own tabs only, take over for logins and 2FA, never type credentials", () => {
  const prompt = buildAgentPrompt("T", "1. x", { provider: "claude/claude-sonnet-5-5", modeId: "auto" }, undefined, undefined, true, true, false, "signed-in");
  assert.ok(prompt.includes(SIGNED_IN_SAFETY_PREAMBLE));
  assert.ok(!prompt.includes(SERVER_SAFETY_PREAMBLE));
  assert.ok(prompt.includes(SERVER_SCREENSHOT_RULE));
  assert.ok(prompt.includes(SIGNED_IN_CLOSE_TABS_RULE));
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /IS signed in to the owner's accounts/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /do NOT type anything into it\. Ask the owner with AskUserQuestion to press Take over/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /Never type, paste, guess or create credentials yourself/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /While the owner holds control of the browser, every browser tool call is refused/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /if the site allows in a NEW tab \(the \+ button; a tab the owner opens is hidden from you, your own tab is not\)/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /reload your tab with mcp__server-browser__browser_navigate/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /Work only in your own tabs and only on the sites the steps name/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /3\. HARD RULE/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /mcp__server-browser__browser_tabs/);
  assert.ok(buildAgentPrompt("T", "1. x", undefined, undefined, undefined, false, false, false, "signed-in").includes(CHROME_KEEP_TABS_RULE));
  assert.equal(parseBrowserAgent("signed-in"), "signed-in");
  assert.equal(runBrowserOf([["k", "run-1", "key:x", SIGNED_IN_RUN_MARKER]], "run-1"), "signed-in");
  assert.match(describeLaunch({ provider: "claude/claude-sonnet-5-5", modeId: "auto" }, "signed-in"), /signed-in browser on the Paseo server/);
});

test("settings: signed-in is a usual way without a version bump, and its own settings live in their own document", async () => {
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /id: "preferences",\n  scope: "host",\n  version: 18,/, "no version bump: older plugin versions still read preferences");
  assert.match(settings, /id: "signed-in",\n  scope: "host",\n  version: 1,/);
  assert.deepEqual([...SIGNED_IN_STATES].sort(), Object.keys(SIGNED_IN_STATE_MESSAGES).sort());
});

test("card and settings: Take over opens a one-time link from the daemon, and downloads, wipes and key rotation need two presses", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /viewerLink\(\{ purpose: "takeover", portrait: mobile \}\)/);
  assert.match(card, /await openExternalUrl\(link\.url\);/);
  assert.match(card, /runBrowser === "signed-in" && \(active \|\| runState === "needs-input" \|\| shownState === "asking"\)/);
  assert.match(card, /prepareSignedIn\(\{ sourceAgentId: agentId, cardId \}\), SIGNED_IN_RPC_TIMEOUT_MS/);
  assert.doesNotMatch(card, /signedInStatus\(\{ build: true \}\)|signedInState\(\{ build: true \}\)/, "the card never builds");
  const settings = readFileSync(new URL("../client/signed-in-settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /if \(armed !== "build"\) return setArmed\("build"\);/);
  assert.match(settings, /if \(armed !== "logout"\) return setArmed\("logout"\);/);
  assert.match(settings, /if \(armed !== "rotate"\) return setArmed\("rotate"\);/);
  assert.match(settings, /useEffect\(\(\) => setArmed\(null\), \[info\?\.state, info\?\.bitwarden\.state\]\);/);
  assert.equal(settings.match(/status\(\{ build: true \}\)/g)?.length, 1, "one build call, after the confirmation");
});

test("daemon: every relay start gets a new salt, so a link from before a relay restart is dead", async () => {
  const docker = fakeStackDocker();
  const { si, dir } = makeSignedIn(docker);
  const link = await si.viewerLink({ purpose: "login", portrait: false });
  const ticket = decodeURIComponent(new URL(link.url).hash.slice(3).split("&")[0]);
  const before = await loadKeys(join(dir, "keys.json"));
  assert.equal(verifyTicket(relaySecret(before), ticket, 1_800_000_000).ok, true);
  docker.state.relayTag = "changed"; // the address changed: only the relay restarts, with the same viewer key
  await si.viewerLink({ purpose: "login", portrait: false });
  const after = await loadKeys(join(dir, "keys.json"));
  assert.equal(after.viewerSecret, before.viewerSecret);
  assert.notEqual(after.relaySalt, before.relaySalt);
  assert.equal(verifyTicket(relaySecret(after), ticket, 1_800_000_000).ok, false);
});

test("daemon: a start that fails stops a running neko gracefully (cookies are written), never with rm -f first", async () => {
  const docker = fakeStackDocker();
  const failing = async (command, args) => {
    if (args[0] === "run" && value(args, "--name")[0]?.endsWith("-relay")) return { code: 1, stdout: "", stderr: "port is already allocated" };
    return docker.run(command, args);
  };
  const { si } = makeSignedIn({ ...docker, run: failing }, { run: failing });
  const result = await si.viewerLink({ purpose: "login", portrait: false });
  assert.equal(result.ok, false);
  const stops = docker.calls.map((args, i) => [args, i]).filter(([args]) => args[0] === "stop" && /-neko$/.test(args.at(-1)));
  const lastRun = docker.calls.findLastIndex((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0] ?? ""));
  const stopAfter = stops.find(([, i]) => i > lastRun);
  assert.ok(stopAfter, "neko is stopped gracefully after the failed start");
  assert.deepEqual(stopAfter[0].slice(0, 3), ["stop", "-t", "45"]);
  const rmAfter = docker.calls.findIndex((args, i) => i > lastRun && args[0] === "rm" && args.some((a) => /-neko$/.test(a)));
  assert.ok(rmAfter > stopAfter[1], "removed only after the graceful stop");
});

test("signed-in runs get no tool that reads page script state; the filter's list and the prompt's list are equal", () => {
  assert.deepEqual([...FILTER_REMOVED].sort(), [...SIGNED_IN_REMOVED_TOOLS].sort());
  assert.deepEqual([...SIGNED_IN_ALLOWED_TOOLS].sort(), [...SIGNED_IN_BROWSER_TOOLS].sort());
  for (const tool of ["browser_evaluate", "browser_console_messages", "browser_network_requests"]) {
    assert.equal(toolAllowed(tool, true), false, tool);
    assert.equal(toolAllowed(tool, false), true, `${tool} stays for the (not signed-in) Server browser`);
    const call = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: {} } });
    assert.equal(JSON.parse(filterClientLine(call, { signedIn: true }).reply).result.isError, true);
  }
  const listed = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "browser_evaluate" }, { name: "browser_snapshot" }, { name: "browser_console_messages" }] } });
  assert.deepEqual(JSON.parse(filterServerLine(listed, { signedIn: true })).result.tools, [{ name: "browser_snapshot" }]);
  assert.equal(JSON.parse(filterServerLine(listed) ?? JSON.stringify({ result: { tools: JSON.parse(listed).result.tools } })).result.tools.length, 3, "the Server browser keeps all three");
  assert.doesNotMatch(SIGNED_IN_SAFETY_PREAMBLE.split("\n").find((line) => line.startsWith("1. ")).split(";")[0], /browser_evaluate/, "rule 1 does not offer evaluate");
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /mcp__server-browser__browser_evaluate, mcp__server-browser__browser_console_messages, mcp__server-browser__browser_network_requests are turned off in this browser/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /The owner's own tabs are hidden from you/);
});

test("control guard: follows the relay's ownerControl, a held state lasts through failures for 10 s, opens only after sustained failure, ignores old results", () => {
  let t = 0;
  const guard = createControlGuard({ now: () => t });
  assert.equal(guard.held(), false);
  guard.result(guard.next(), { ownerControl: true, known: true });
  assert.equal(guard.held(), true);
  t += 3000;
  guard.failure(guard.next());
  guard.failure(guard.next());
  guard.failure(guard.next());
  assert.equal(guard.held(), true, "within 10 s of the last held state");
  t += 8000;
  guard.failure(guard.next());
  assert.equal(guard.held(), false, "11 s and four failures later");
  guard.result(guard.next(), { ownerControl: false, known: false });
  assert.equal(guard.held(), false, "the relay's ownerControl decides; it folds the unsure case in itself");
  guard.result(guard.next(), { ownerControl: true, known: false });
  assert.equal(guard.held(), true);
  guard.result(guard.next(), { ownerControl: false, known: true });
  assert.equal(guard.held(), false);
  const late = guard.next();
  guard.result(guard.next(), { ownerControl: true, known: true });
  guard.result(late, { ownerControl: false, known: true });
  assert.equal(guard.held(), true, "an older result is ignored");
  const fresh = createControlGuard({ now: () => t });
  fresh.failure(fresh.next());
  fresh.failure(fresh.next());
  assert.equal(fresh.held(), false, "never held: stays open");
});

test("call tracker: a result that arrives while the owner holds control, or whose call overlapped a takeover, is withheld", () => {
  const calls = createCallTracker();
  const call = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_snapshot" } });
  const result = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "secret value" }] } });
  calls.started(call(1));
  assert.equal(calls.finish(result(1), false), result(1), "no takeover: passed on");
  calls.started(call(2));
  calls.markHeld();
  const withheld = JSON.parse(calls.finish(result(2), false));
  assert.equal(withheld.id, 2);
  assert.equal(withheld.result.isError, true);
  assert.equal(withheld.result.content[0].text, OWNER_CONTROL_TEXT, "overlapped a held period");
  calls.started(call("x"));
  assert.equal(JSON.parse(calls.finish(result("x"), true)).result.content[0].text, OWNER_CONTROL_TEXT, "arrives while held");
  const other = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { tools: [] } });
  assert.equal(calls.finish(other, true), other, "answers to other requests are not touched");
  assert.equal(calls.size(), 0);
});

test("DevTools filter (allowlist): the run sees only pages it created and their popups opened while the owner does not hold control", () => {
  let held = false;
  const filter = createTargetFilter({ held: () => held });
  const page = (targetId, extra = {}) => ({ targetId, type: "page", ...extra });
  const attached = (info, waitingForDebugger = false, sessionId) => ({ method: "Target.attachedToTarget", ...(sessionId ? { sessionId } : {}), params: { sessionId: `S-${info.targetId}`, targetInfo: info, waitingForDebugger } });
  const delivered = (verdict) => verdict.deliver.length > 0;
  // Pages the run did not create: hidden (open at attach, restored after a restart, opened while no client was connected).
  for (const id of ["OWNER1", "RESTORED", "OPENED-LATER"]) {
    const verdict = filter.fromBrowser(attached(page(id)));
    assert.equal(delivered(verdict), false, id);
    assert.deepEqual(verdict.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  }
  assert.equal(delivered(filter.fromBrowser({ method: "Target.targetCreated", params: { targetInfo: { targetId: "TAB1", type: "tab" } } })), false, "tab targets hidden");
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "SW1", type: "service_worker" }))), false, "service workers hidden");
  // The run creates a page: the attach event that comes before the answer is held back, then both come out, attach first.
  assert.ok(filter.fromClient({ id: 11, method: "Target.createTarget", params: { url: "about:blank" } }).forward);
  let verdict = filter.fromBrowser(attached(page("AGENT1"), true));
  assert.equal(delivered(verdict), false, "held back while the create is on its way");
  verdict = filter.fromBrowser({ id: 11, result: { targetId: "AGENT1" } });
  assert.deepEqual(verdict.deliver.map((m) => m.method ?? "answer"), ["Target.attachedToTarget", "answer"]);
  assert.equal(filter.isVisible("AGENT1"), true);
  // A page the owner opens while a create is on its way, with no opener: hidden once the answer names another page.
  filter.fromClient({ id: 12, method: "Target.createTarget", params: { url: "about:blank" } });
  assert.equal(delivered(filter.fromBrowser(attached(page("OWNER-RACE"), true))), false);
  assert.equal(delivered(filter.fromBrowser(attached(page("AGENT2"), true))), false);
  verdict = filter.fromBrowser({ id: 12, result: { targetId: "AGENT2" } });
  assert.deepEqual(verdict.deliver.map((m) => m.params?.targetInfo?.targetId ?? "answer"), ["AGENT2", "answer"]);
  assert.deepEqual(verdict.toBrowser.map((m) => m.method), ["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"], "the owner's page is resumed and detached");
  // Popups: of a visible page while not held -> visible; while held -> hidden (the owner opened it); of a hidden page -> hidden.
  assert.equal(delivered(filter.fromBrowser(attached(page("POPUP1", { openerId: "AGENT1" })))), true);
  held = true;
  assert.equal(delivered(filter.fromBrowser(attached(page("POPUP2", { openerId: "AGENT1" })))), false, "opened from the agent's tab during a takeover: the owner's");
  held = false;
  assert.equal(delivered(filter.fromBrowser(attached(page("POPUP3", { openerId: "OWNER1" })))), false);
  // Frames and workers attached under a visible page's session: visible; under a hidden one: never seen.
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "FRAME1", type: "iframe" }, false, "S-AGENT1"))), true);
  assert.equal(delivered(filter.fromBrowser({ sessionId: "S-OWNER1", method: "Page.frameNavigated", params: {} })), false);
  // Commands.
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo", "Target.sendMessageToTarget", "Target.autoAttachRelated", "Target.detachFromTarget", "Browser.getWindowForTarget"]) {
    assert.ok(filter.fromClient({ id: 5, method, params: { targetId: "OWNER1" } }).reply, `${method} on an owner tab`);
    assert.ok(filter.fromClient({ id: 6, method, params: { targetId: "AGENT1" } }).forward, `${method} on the run's tab`);
  }
  for (const method of REFUSED_METHODS) assert.ok(filter.fromClient({ id: 7, method }).reply, method);
  for (const method of ["Storage.getCookies", "Storage.clearCookies", "Network.getAllCookies", "Browser.close"]) assert.ok(REFUSED_METHODS.has(method), method);
  for (const method of ["Input.dispatchKeyEvent", "Network.getCookies", "Runtime.evaluate", "Storage.getStorageKeyForFrame"]) {
    assert.ok(filter.fromClient({ id: 8, sessionId: "S-OWNER1", method }).reply, `${method} on a hidden session`);
    assert.ok(filter.fromClient({ id: 8, sessionId: "S-AGENT1", method }).forward, `${method} on the run's session`);
  }
  assert.ok(filter.fromClient({ id: 9, method: "Target.detachFromTarget", params: { sessionId: "S-OWNER1" } }).reply);
  // Windows: only those of the run's pages.
  assert.ok(filter.fromClient({ id: 20, method: "Browser.setWindowBounds", params: { windowId: 7, bounds: {} } }).reply);
  filter.fromClient({ id: 21, method: "Browser.getWindowForTarget", params: { targetId: "AGENT1" } });
  filter.fromBrowser({ id: 21, result: { windowId: 7, bounds: {} } });
  assert.ok(filter.fromClient({ id: 22, method: "Browser.setWindowBounds", params: { windowId: 7, bounds: {} } }).forward);
  // Target lists show only the run's pages; the filter's own messages' answers are dropped.
  const listed = filter.fromBrowser({ id: 30, result: { targetInfos: [page("OWNER1"), page("AGENT1"), page("NEVER-SEEN")] } });
  assert.deepEqual(listed.deliver[0].result.targetInfos.map((t) => t.targetId), ["AGENT1"]);
  assert.equal(delivered(filter.fromBrowser({ id: 2_000_000_001, result: {} })), false);
});

test("daemon: concurrent presses get one ticket, never two", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  const results = await Promise.all([1, 2, 3, 4].map((n) => si.prepare({ sourceId: "s", cardId: `c${n}` })));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => !r.ok && r.state === "busy").length, 3);
});

test("daemon: concurrent session opens admit one run", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  const results = await Promise.all(["run-1", "run-2", "run-3"].map((id) => si.mcpServer(id)));
  assert.equal(results.filter((r) => r && "server" in r).length, 1);
  assert.equal(results.filter((r) => r && r.refused === "busy").length, 2);
});

test("daemon: a missing proxy or relay is started alone; neko and the owner's sessions keep running", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  const names = [...docker.state.containers.keys()];
  const relay = names.find((n) => n.endsWith("-relay"));
  const proxy = names.find((n) => n.endsWith("-proxy"));
  docker.state.containers.set(relay, "exited");
  docker.state.containers.set(proxy, "exited");
  docker.calls.length = 0;
  await si.viewerLink({ purpose: "login", portrait: false });
  const runs = docker.calls.filter((args) => args[0] === "run").map((args) => value(args, "--name")[0].replace(/^bp-si-[0-9a-f]{8}-/, ""));
  assert.deepEqual(runs, ["proxy", "relay"]);
  assert.ok(!docker.calls.some((args) => (args[0] === "stop" || args[0] === "rm") && args.some((a) => /-neko$/.test(a))), "neko untouched");
  const relayArgs = docker.calls.find((args) => args[0] === "run" && /-relay$/.test(value(args, "--name")[0]));
  assert.ok(value(relayArgs, "--env").includes("BP_CONTROL_SUBNET=172.30.0.0/16"), "the relay learns its internal subnet");
  docker.state.containers.set(proxy, "exited");
  docker.calls.length = 0;
  assert.equal(await si.idleCheck(), false);
  assert.deepEqual(docker.calls.filter((args) => args[0] === "run").map((args) => value(args, "--name")[0].replace(/^bp-si-[0-9a-f]{8}-/, "")), ["proxy"], "the idle check repairs too");
});

test("no viewer and a failing neko control poll: the run is not paused", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  try {
    neko.state.hasHost = true;
    await relay.pollControl();
    neko.state.controlFails = true;
    for (let i = 0; i < 3; i++) await relay.pollControl();
    const body = JSON.parse((await http(port, "GET", "/control")).body);
    assert.deepEqual(body, { ownerControl: false, known: true });
    const guard = createControlGuard();
    guard.result(guard.next(), body);
    assert.equal(guard.held(), false, "the run's guard follows the relay");
    neko.state.failLogin = true; // a 401 loop on neko's login
    for (let i = 0; i < 3; i++) await relay.pollControl();
    assert.equal(JSON.parse((await http(port, "GET", "/control")).body).ownerControl, false);
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("a signed-in run that waits for the owner shows a full Take over button above the question", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const button = card.indexOf('"Take over the browser"');
  const question = card.indexOf("<OwnerPromptBox");
  assert.ok(button > 0 && button < question, "the button comes before the question box");
  assert.match(card, /runBrowser === "signed-in" && \(runState === "needs-input" \|\| shownState === "asking"\)/);
});

// ---------------------------------------------------------------- Bitwarden (optional, for the owner during a takeover)

const BW_DIR = new URL("../signed-in-bitwarden/", import.meta.url);
const bwFile = (name) => readFileSync(new URL(name, BW_DIR), "utf8");

test("Bitwarden pin: the shared constant and bitwarden.json agree; the release is Bitwarden's GitHub zip of that version", () => {
  const pin = JSON.parse(bwFile("bitwarden.json"));
  assert.deepEqual(pin, { version: BITWARDEN.version, url: BITWARDEN.url, sha256: BITWARDEN.sha256, size: BITWARDEN.size });
  assert.match(BITWARDEN.sha256, /^[0-9a-f]{64}$/);
  assert.equal(BITWARDEN.url, `https://github.com/bitwarden/clients/releases/download/browser-v${BITWARDEN.version}/bit-dist-chrome-${BITWARDEN.version}.zip`);
  for (const name of Object.keys(SIGNED_IN_BITWARDEN_FILES)) assert.equal(SIGNED_IN_BITWARDEN_FILES[name], bwFile(name), `${name} is embedded as is`);
  assert.deepEqual(Object.keys(SIGNED_IN_BITWARDEN_FILES).sort(), ["Dockerfile", "bitwarden.json", "install-bitwarden.py", "policy-overlay.json"]);
});

test("Bitwarden image: the verified release is packed unchanged into a CRX with a per-build key (deleted) and force-installed from a local manifest", () => {
  const dockerfile = bwFile("Dockerfile");
  assert.match(dockerfile, /^ARG BASE_IMAGE\nFROM \$\{BASE_IMAGE\}$/m);
  assert.match(dockerfile, /RUN python3 -I \/tmp\/bp-bitwarden\/install-bitwarden\.py \/tmp\/bp-bitwarden && rm -rf \/tmp\/bp-bitwarden/);
  const script = bwFile("install-bitwarden.py");
  for (const check of [
    /if not pin\["url"\]\.startswith\(prefix\)/,
    /if not newurl\.startswith\("https:\/\/"\)/,
    /if len\(data\) != pin\["size"\]/,
    /if digest != pin\["sha256"\]/,
    /if name\.startswith\("\/"\) or "\\\\" in name or "\.\." in name\.split\("\/"\)/,
    /if manifest\.get\("version"\) != pin\["version"\] or manifest\.get\("manifest_version"\) != 3/,
    /if "update_url" in manifest or "key" in manifest/,
    /"--pack-extension=" \+ source/,
    /if os\.path\.exists\(key_file\):\n    os\.remove\(key_file\)/,
    /if want != got:\n        sys\.exit\("refusing: the packed extension differs from the release"\)/,
    /codebase='file:\/\/\/opt\/bitwarden\/bitwarden\.crx' version='%s'/,
    /policy\["ExtensionInstallForcelist"\] = \["%s;file:\/\/\/opt\/bitwarden\/updates\.xml" % ext_id\]/,
    /policy\["ExtensionInstallAllowlist"\] = \[ext_id\]/,
    /os\.chmod\(os\.path\.join\(target, name\), 0o644\)/,
  ]) {
    assert.match(script, check);
  }
  assert.doesNotMatch(script, /suggested_key|manifest\["key"\]/, "the release's manifest is not changed");
  const tag = bitwardenImageTag("browser-prompt-signed-in:neko3.2.0-0123456789ab", "f".repeat(64));
  assert.equal(tag, `browser-prompt-signed-in:neko3.2.0-0123456789ab-bw${BITWARDEN.version}-ffffffffffff`);
  assert.throws(() => bitwardenImageTag("evil:latest", "f".repeat(64)));
  assert.throws(() => bitwardenImageTag("browser-prompt-signed-in:neko3.2.0-0123456789ab", "xyz"));
  assert.equal(bitwardenIdFromPin(JSON.stringify({ id: "a".repeat(32) })), "a".repeat(32));
  assert.equal(bitwardenIdFromPin(JSON.stringify({ id: "nope" })), null);
  assert.equal(bitwardenIdFromPin("garbage"), null);
});

test("Bitwarden policy: every other extension blocked (blocklist *, developer mode off), extension pages unblocked for its dynamic frames, store blocked, Chromium's password manager off", () => {
  const base = JSON.parse(SIGNED_IN_FILES["policies.json"]);
  const overlay = JSON.parse(bwFile("policy-overlay.json"));
  // The same steps as install-bitwarden.py.
  const id = "k".repeat(32);
  const policy = { ...base, ...overlay.set };
  for (const [name, values] of Object.entries(overlay.drop)) policy[name] = policy[name].filter((v) => !values.includes(v));
  for (const [name, values] of Object.entries(overlay.append)) policy[name] = [...(policy[name] ?? []), ...values.filter((v) => !(policy[name] ?? []).includes(v))];
  policy.ExtensionInstallAllowlist = [id];
  policy.ExtensionInstallForcelist = [`${id};file:///opt/bitwarden/updates.xml`];
  assert.deepEqual(policy.ExtensionInstallBlocklist, ["*"]);
  assert.equal(policy.ExtensionDeveloperModeSettings, 1);
  assert.deepEqual(policy.ExtensionAllowedTypes, ["extension"]);
  assert.deepEqual(policy.ExtensionInstallSources, []);
  assert.equal(policy.BlockExternalExtensions, true);
  assert.equal(policy.DeveloperToolsAvailability, 1, "DevTools on force-installed extensions: the daemon's lock check needs them (the agent never gets them)");
  assert.equal(policy.PasswordManagerEnabled, false);
  assert.equal(policy.AutofillAddressEnabled, false);
  assert.equal(policy.AutofillCreditCardEnabled, false);
  assert.ok(!policy.URLBlocklist.includes("chrome-extension://*"), "Bitwarden's inline menu frames have dynamic ids no allowlist entry can name");
  assert.deepEqual(policy.URLAllowlist, ["about:blank", "chrome://newtab"], "no dead allowlist entry");
  for (const store of ["chromewebstore.google.com", "chrome.google.com/webstore"]) assert.ok(policy.URLBlocklist.includes(store), store);
  for (const blocked of base.URLBlocklist.filter((u) => u !== "chrome-extension://*")) assert.ok(policy.URLBlocklist.includes(blocked), blocked);
});

test("chromium-start.sh: records the installed Bitwarden build and removes the data of every build that is not installed now", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-bw-start-"));
  const runStart = () =>
    spawnSync(
      "sh",
      ["-c", `sed -e "s|^PROFILE=.*|PROFILE=$T/profile|" -e "s|^PIN=.*|PIN=$T/pin.json|" -e "s|exec /usr/bin/chromium|exec echo|" "$0" | sh -s -- --flag`, new URL("../signed-in/chromium-start.sh", import.meta.url).pathname],
      { env: { PATH: "/usr/bin:/bin", BP_PROXY: "http://bp-si-0a1b2c3d-proxy:3128", T: dir }, encoding: "utf8" },
    );
  const oldId = "a".repeat(32);
  const newId = "b".repeat(32);
  const data = (id) => [
    `Default/Local Extension Settings/${id}`,
    `Default/IndexedDB/chrome-extension_${id}_0.indexeddb.leveldb`,
    `Default/Storage/ext/${id}`,
    `Default/Extensions/${id}`,
    `Profile 1/Sync Extension Settings/${id}`,
  ];
  mkdirSync(join(dir, "profile"), { recursive: true });
  for (const path of [...data(oldId), ...data(newId), "Default/Local Extension Settings/other"]) mkdirSync(join(dir, "profile", path), { recursive: true });
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), `${oldId}\n`);
  // Bitwarden with a new build (a new pin): the new id is recorded, the old build's data goes.
  writeFileSync(join(dir, "pin.json"), JSON.stringify({ version: "x", id: newId }));
  let result = runStart();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--flag --proxy-server=http:\/\/bp-si-0a1b2c3d-proxy:3128 --proxy-bypass-list=<-loopback>/);
  assert.doesNotMatch(result.stdout, /--load-extension|--disable-extensions-except/, "force-installed by policy, not loaded from the command line");
  for (const path of data(oldId)) assert.equal(existsSync(join(dir, "profile", path)), false, `${path} removed`);
  for (const path of data(newId)) assert.equal(existsSync(join(dir, "profile", path)), true, `${path} kept`);
  assert.equal(readFileSync(join(dir, "profile", ".bp-bitwarden-ids"), "utf8"), `${oldId}\n${newId}\n`);
  // Bitwarden off: every recorded build's data goes; nothing else.
  rmSync(join(dir, "pin.json"));
  result = runStart();
  assert.equal(result.status, 0, result.stderr);
  for (const path of data(newId)) assert.equal(existsSync(join(dir, "profile", path)), false, `${path} removed`);
  assert.equal(existsSync(join(dir, "profile", "Default/Local Extension Settings/other")), true, "nothing else removed");
  // A forged ids file cannot point the removal elsewhere.
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), "../../etc\n*\n");
  assert.equal(runStart().status, 0);
  assert.equal(existsSync(join(dir, "profile", "Default/Local Extension Settings/other")), true);
});

test("Bitwarden tool: a short-lived, locked-down container in neko's namespace with its own DevTools connection; only checked modes and ids; locked only when verified", () => {
  const args = bitwardenToolArgs({ stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE }, "lock", ["k".repeat(32)]);
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--init", "--pull"]);
  assert.deepEqual(value(args, "--network"), ["container:bp-si-0a1b2c3d-neko"]);
  assert.deepEqual(value(args, "--cap-drop"), ["ALL"]);
  assert.ok(value(args, "--security-opt").includes("no-new-privileges"));
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(value(args, "--user"), ["pwuser"]);
  assert.deepEqual(args.slice(-4), [SERVER_IMAGE, "/opt/browser-prompt/bitwarden-lock.mjs", "lock", "k".repeat(32)]);
  assert.ok(!args.some((a) => /^-v$|^--volume$|^--privileged$|^-p$|^--publish$/.test(a)));
  assert.throws(() => bitwardenToolArgs({ stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE }, "evaluate", []));
  assert.throws(() => bitwardenToolArgs({ stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE }, "lock", ["$(rm -rf /)"]));
  assert.throws(() => bitwardenToolArgs({ stackId: "0a1b2c3d", instance: INSTANCE, serverImage: "evil:latest" }, "lock", []));
  assert.deepEqual(parseBitwardenTool('noise\n{"mode":"lock","locked":true,"detail":""}\n'), { mode: "lock", locked: true, detail: "" });
  assert.equal(parseBitwardenTool("not json"), null);
  // The tool's verdict: Bitwarden answered, and no account is unlocked (2).
  assert.equal(isLocked({ ready: true, statuses: [] }), true, "logged out: nothing unlocked");
  assert.equal(isLocked({ ready: true, statuses: [{ status: 1 }, { status: 0 }] }), true);
  assert.equal(isLocked({ ready: true, statuses: [{ status: 1 }, { status: 2 }] }), false, "one of several accounts unlocked");
  assert.equal(isLocked({ ready: false }), false, "no answer: not locked");
  assert.equal(isLocked(null), false);
  assert.match(STATUS_EXPRESSION, /authStatuses\$/);
  assert.match(LOCK_EXPRESSION, /lockService\.lockAll\("browser-prompt"\)/);
  const tool = readFileSync(new URL("../server-browser/bitwarden-lock.mjs", import.meta.url), "utf8");
  assert.match(tool, /chrome\.storage\.session\.set\(\{ bpLockMarker/);
  assert.match(tool, /chrome\.runtime\.reload\(\)/);
  assert.match(tool, /await cdp\.send\("Browser\.close"/);
});

test("Bitwarden relay: the run stays paused from the start and after every takeover until the daemon confirms the lock for that release", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {}, lockOnRelease: true });
  const port = await relay.startControl("127.0.0.1", 0);
  const read = async () => JSON.parse((await http(port, "GET", "/control")).body);
  const status = async () => JSON.parse((await http(relay.port, "GET", "/bp/status", { ...HOST, Authorization: `Bearer ${STATUS}` })).body);
  const locked = (generation, token = STATUS) =>
    http(relay.port, "POST", "/bp/locked", { ...HOST, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, JSON.stringify({ generation }));
  const settle = async (check) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  try {
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: true, known: true, lockPending: true, securing: true }, "paused until the first lock");
    let st = await status();
    assert.equal(st.lockPending, true);
    assert.equal((await locked(st.lockGeneration, "x".repeat(43))).status, 401, "only with the status token");
    assert.equal(JSON.parse((await locked(st.lockGeneration - 1)).body).cleared, false, "an older release's lock does not count");
    assert.equal(JSON.parse((await locked(st.lockGeneration)).body).cleared, true);
    assert.deepEqual(await read(), { ownerControl: false, known: true, lockPending: false, securing: false });
    // A viewer takes control, then releases it: paused again until locked.
    const created = await postTicket(relay, ticketAt(Date.now(), "lock-lock-lock-0001"));
    const cookie = String(created.headers["set-cookie"]).split(";")[0];
    const socket = connect(relay.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(
      [`GET ${relay.prefix}/api/ws HTTP/1.1`, "Host: 127.0.0.1:5301", "Origin: http://127.0.0.1:5301", `Cookie: ${cookie}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    await new Promise((resolve) => socket.once("data", resolve));
    neko.state.hasHost = true;
    await relay.pollControl();
    st = await status();
    assert.equal(st.lockPending, false);
    assert.equal(JSON.parse((await locked(st.lockGeneration)).body).cleared, false, "nothing to clear while the owner holds control");
    neko.state.hasHost = false;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: true, known: true, lockPending: true, securing: true }, "released: paused until locked");
    const released = (await status()).lockGeneration;
    // The owner takes and releases control again before the daemon confirms: that confirmation is for an old release.
    neko.state.hasHost = true;
    await relay.pollControl();
    neko.state.hasHost = false;
    await relay.pollControl();
    assert.equal(JSON.parse((await locked(released)).body).cleared, false);
    assert.equal(JSON.parse((await locked((await status()).lockGeneration)).body).cleared, true);
    assert.equal((await read()).ownerControl, false);
    // The last viewer leaves (without holding control): locked again before the run goes on.
    socket.destroy();
    await settle(() => relay.state().viewers === 0);
    assert.deepEqual(await read(), { ownerControl: true, known: true, lockPending: true, securing: true });
  } finally {
    await relay.close();
    await neko.close();
  }
  // Without Bitwarden nothing changes.
  const neko2 = await fakeNeko();
  const plain = await relayFor(neko2, { controlPollMs: 60_000, log: () => {} });
  const port2 = await plain.startControl("127.0.0.1", 0);
  try {
    await plain.pollControl();
    assert.deepEqual(JSON.parse((await http(port2, "GET", "/control")).body), { ownerControl: false, known: true });
  } finally {
    await plain.close();
    await neko2.close();
  }
});

test("Bitwarden relay args: lock mode only with Bitwarden, and the stack checks still hold", () => {
  const plain = stackRelayArgs(input(), KEYS);
  assert.ok(!value(plain, "--env").includes("BP_LOCK_ON_RELEASE=1"));
  const withBw = stackRelayArgs(input({ bitwarden: true }), KEYS);
  assert.ok(value(withBw, "--env").includes("BP_LOCK_ON_RELEASE=1"));
  assert.doesNotThrow(() => checkStackRun(withBw, "relay", input({ bitwarden: true })));
  const bwImage = bitwardenImageTag(NEKO_IMAGE, "a".repeat(64));
  assert.doesNotThrow(() => checkStackRun(stackNekoArgs(input({ nekoImage: bwImage, bitwarden: true }), KEYS), "neko", input({ nekoImage: bwImage })));
});

test("Bitwarden daemon: nothing is downloaded without the saved consent; the variant builds on the signed-in image; the stack switches only when no run holds it (update pending meanwhile)", async () => {
  const docker = fakeStackDocker();
  let bitwarden = false;
  const relay = { lockPending: false, lockGeneration: 0 };
  const lockedCalls = [];
  const helper = makeSignedIn(docker, {
    config: async () => ({ port: 5301, httpsBaseUrl: "", bitwarden }),
    relayStatus: async () => ({ viewers: 0, idleMs: 0, nekoUp: true, portrait: false, ...relay }),
    relayLocked: async (_host, _port, _token, generation) => {
      lockedCalls.push(generation);
      return true;
    },
  });
  const { si } = helper;
  assert.equal((await si.status()).bitwarden.state, "off");
  assert.equal((await si.bitwarden("download")).ok, false, "the server refuses a download the owner has not consented to (setting off)");
  assert.ok(!docker.calls.some((args) => args[0] === "build"));
  bitwarden = true;
  assert.equal((await si.status()).bitwarden.state, "no-image", "chosen but not downloaded: nothing happens by itself");
  await si.viewerLink({ purpose: "login", portrait: false });
  assert.ok(!docker.calls.some((args) => args[0] === "build"), "a start never downloads Bitwarden");
  const nekoRun = () => docker.calls.filter((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0] ?? "")).at(-1);
  assert.doesNotMatch(nekoRun().at(-1), /-bw/, "without the variant image the plain browser runs");
  assert.equal((await si.bitwarden("download")).ok, true);
  for (let i = 0; i < 100 && (await si.status()).bitwarden.state === "building"; i++) await new Promise((r) => setTimeout(r, 5));
  const build = docker.calls.find((args) => args[0] === "build" && args.includes("browser-prompt.signed-in=bitwarden-image"));
  assert.ok(build, "built");
  assert.equal(value(build, "--build-arg")[0], `BASE_IMAGE=${si.image}`);
  assert.equal(value(build, "-t")[0], si.bitwardenImage);
  let status = await si.status();
  assert.equal(status.bitwarden.state, "ready");
  assert.equal(status.bitwarden.updatePending, true, "the running browser is the plain one");
  // A run holds the browser: neko keeps running (update pending); when the run ends, the idle check switches it.
  docker.state.agents.push({ id: "abcdef000001", agent: "run-a" });
  docker.calls.length = 0;
  await si.viewerLink({ purpose: "login", portrait: false });
  assert.ok(!docker.calls.some((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0] ?? "")), "not under a run");
  assert.ok(!docker.calls.some((args) => args[0] === "stop"), "no stop under a run");
  status = await si.status();
  assert.equal(status.bitwarden.updatePending, true);
  assert.equal(status.busy, true);
  assert.match((await si.bitwarden("apply")).message, /Update pending/);
  assert.equal(await si.idleCheck(), false);
  assert.ok(!docker.calls.some((args) => args[0] === "stop"), "the idle check waits for the run too");
  docker.state.agents = [];
  docker.calls.length = 0;
  await si.idleCheck();
  assert.ok(docker.calls.some((args) => args[0] === "stop" && args[2] === "45"), "stopped gracefully (cookies written)");
  assert.equal(nekoRun().at(-1), si.bitwardenImage, "the run ended: neko starts again with Bitwarden");
  const relayRun = docker.calls.filter((args) => args[0] === "run" && /-relay$/.test(value(args, "--name")[0] ?? "")).at(-1);
  assert.ok(value(relayRun, "--env").includes("BP_LOCK_ON_RELEASE=1"));
  status = await si.status();
  assert.equal(status.bitwarden.active, true);
  assert.equal(status.bitwarden.updatePending, false);
  // A run's MCP container fails closed with Bitwarden.
  const mcp = await si.mcpServer("run-b");
  const plan = JSON.parse(Buffer.from(mcp.server.args[1], "base64").toString("utf8"));
  assert.ok(value(plan.agent.run, "--env").includes("BP_CONTROL_FAIL_CLOSED=1"));
  // Turned off: an idle browser restarts without it.
  bitwarden = false;
  docker.state.agents = [];
  assert.match((await si.bitwarden("apply")).message, /Update pending/, "run-b was just admitted");
  helper.advance(60 * 60_000);
  assert.equal((await si.bitwarden("apply")).ok, true);
  await si.viewerLink({ purpose: "login", portrait: false });
  assert.doesNotMatch(nekoRun().at(-1), /-bw/);
});

test("Bitwarden lock: only when the relay asks; verified through DevTools (lock, then reload), retried, then a browser restart; the relay is told only after a verified lock", async () => {
  const docker = fakeStackDocker();
  const relay = { lockPending: false, lockGeneration: 0 };
  let relayUp = true;
  const lockedCalls = [];
  const { si } = makeSignedIn(docker, {
    config: async () => ({ port: 5301, httpsBaseUrl: "", bitwarden: true }),
    relayStatus: async () => (relayUp ? { viewers: 0, idleMs: 0, nekoUp: true, portrait: false, ...relay } : null),
    relayLocked: async (_host, _port, _token, generation) => {
      lockedCalls.push(generation);
      return true;
    },
  });
  docker.state.images.add("bitwarden");
  await si.viewerLink({ purpose: "login", portrait: false });
  assert.match(docker.state.nekoImage, /-bw/);
  docker.state.bitwardenId = "m".repeat(32);
  docker.state.tools = [];
  assert.equal(await si.lockCheck(), false, "nothing pending: nothing done");
  assert.equal(docker.state.tools.length, 0);
  // Pending: Bitwarden's own lock, verified, then the relay hears about that release.
  relay.lockPending = true;
  relay.lockGeneration = 7;
  assert.equal(await si.lockCheck(), true);
  assert.deepEqual(docker.state.tools.map((t) => `${t.mode} ${t.ids.join(",")}`), [`lock ${"m".repeat(32)}`]);
  assert.deepEqual(lockedCalls, [7]);
  // Not verified: the lock and a reload are tried 3 times, then Chromium is restarted and checked; the relay is not told.
  docker.state.tools = [];
  lockedCalls.length = 0;
  docker.state.tool = (mode) => (mode === "status" ? { locked: false, statuses: [{ status: 2 }], detail: "" } : mode === "restart" ? { locked: false, restarted: true } : { locked: false, statuses: [{ status: 2 }], detail: "" });
  assert.equal(await si.lockCheck(), false);
  assert.deepEqual(
    docker.state.tools.map((t) => t.mode),
    ["lock", "reload", "lock", "reload", "lock", "reload", "restart", "status"],
  );
  assert.deepEqual(lockedCalls, [], "the run stays paused (fail closed)");
  const status = await si.status();
  assert.equal(status.bitwarden.lockPending, true);
  assert.equal(status.bitwarden.lastLock.ok, false);
  assert.match(status.bitwarden.lastLock.detail, /vault timeout set to Never/);
  // The restart helps: locked, the relay is told.
  docker.state.tools = [];
  docker.state.tool = (mode) => (mode === "status" ? { locked: true, statuses: [{ status: 1 }] } : mode === "restart" ? { restarted: true } : { locked: false, detail: "no service worker" });
  assert.equal(await si.lockCheck(), true);
  assert.deepEqual(lockedCalls, [7]);
  // The owner's Lock now and Restart browser.
  docker.state.tool = () => ({ locked: true });
  lockedCalls.length = 0;
  assert.equal((await si.bitwarden("lock")).ok, true);
  assert.deepEqual(lockedCalls, [7], "a waiting run goes on");
  docker.state.tools = [];
  assert.equal((await si.bitwarden("restart-browser")).ok, true);
  assert.deepEqual(docker.state.tools.map((t) => t.mode), ["restart", "lock"]);
  // The relay does not answer while a run uses the Bitwarden browser: the vault is locked anyway (and the run's guard stays paused).
  relayUp = false;
  docker.state.agents.push({ id: "abcdef000002", agent: "run-c" });
  docker.state.tools = [];
  assert.equal(await si.lockCheck(), false);
  assert.deepEqual(docker.state.tools.map((t) => t.mode), ["lock"]);
  docker.state.tools = [];
  assert.equal(await si.lockCheck(), false);
  assert.equal(docker.state.tools.length, 0, "at most every 15 seconds");
});

test("Bitwarden cleanup: the storage of builds no longer installed is cleared through DevTools once Chromium runs, then forgotten", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker, { config: async () => ({ port: 5301, httpsBaseUrl: "", bitwarden: false }) });
  await si.viewerLink({ purpose: "login", portrait: false });
  const oldA = "a".repeat(32);
  const oldB = "b".repeat(32);
  docker.state.idsFile = `${oldA}\n${oldB}\n../etc\n`;
  docker.state.tools = [];
  docker.state.tool = (mode, ids) => (mode === "cleanup" ? { cleared: ids } : { locked: true });
  assert.deepEqual(await si.cleanupOldBitwarden(), [oldA, oldB]);
  assert.deepEqual(docker.state.tools.map((t) => `${t.mode} ${t.ids.join(",")}`), [`cleanup ${oldA},${oldB}`]);
  assert.equal(docker.state.idsFile, "", "forgotten once cleared");
  assert.deepEqual(await si.cleanupOldBitwarden(), []);
});

test("DevTools filter: extension targets are hidden everywhere, the run cannot open extension pages, and clicks on extension frames are checked", () => {
  const filter = createTargetFilter();
  const attached = (info, sessionId) => ({ method: "Target.attachedToTarget", ...(sessionId ? { sessionId } : {}), params: { sessionId: `S-${info.targetId}`, targetInfo: info, waitingForDebugger: false } });
  const delivered = (verdict) => verdict.deliver.length > 0;
  const ext = `chrome-extension://${BITWARDEN.id}`;
  assert.equal(isExtensionUrl(`${ext}/popup/index.html`), true);
  assert.equal(isExtensionUrl(" CHROME-EXTENSION://x/"), true);
  assert.equal(isExtensionUrl("https://example.com/chrome-extension://"), false);
  // Background service worker, popup, offscreen document: hidden like every target the run did not create.
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "BW-SW", type: "service_worker", url: `${ext}/background.js` }))), false);
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "BW-POPUP", type: "page", url: `${ext}/popup/index.html` }))), false);
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "BW-OFF", type: "other", url: `${ext}/offscreen-document/index.html` }))), false);
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) assert.ok(filter.fromClient({ id: 1, method, params: { targetId: "BW-SW" } }).reply, method);
  // The run's page.
  filter.fromClient({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser(attached({ targetId: "AGENT", type: "page", url: "about:blank" }));
  filter.fromBrowser({ id: 2, result: { targetId: "AGENT" } });
  assert.equal(filter.isVisible("AGENT"), true);
  // A popup of the run's page that is an extension page (window.open, or the extension opening a window): hidden.
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "BW-WIN", type: "page", openerId: "AGENT", url: `${ext}/popup/index.html#/fido2` }))), false);
  // The inline menu: an extension frame inside the run's page (a dynamic id). Hidden, and remembered.
  const frame = filter.fromBrowser(attached({ targetId: "BW-MENU", type: "iframe", url: "chrome-extension://9f0e1d2c-dynamic/overlay/menu-list.html" }, "S-AGENT"));
  assert.equal(delivered(frame), false);
  assert.deepEqual(frame.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  assert.deepEqual([...filter.extensionFrames()], ["BW-MENU"]);
  assert.equal(delivered(filter.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "BW-MENU", type: "iframe", url: `${ext}/x` } } })), false);
  // Navigation to extension pages.
  for (const url of [`${ext}/popup/index.html`, "chrome-extension://abc/x.html", " chrome-extension://abc/"]) {
    assert.match(filter.fromClient({ id: 3, sessionId: "S-AGENT", method: "Page.navigate", params: { url } }).reply.error.message, /password manager/);
    assert.ok(filter.fromClient({ id: 4, method: "Target.createTarget", params: { url } }).reply);
  }
  assert.ok(filter.fromClient({ id: 5, sessionId: "S-AGENT", method: "Page.navigate", params: { url: "https://example.com" } }).forward);
  // Pointer input on a page that holds an extension frame: checked against what is at that point.
  const press = { id: 6, sessionId: "S-AGENT", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 } };
  const verdict = filter.fromClient(press);
  assert.ok(verdict.hitTest);
  assert.deepEqual(verdict.hitTest.points, [{ x: 10, y: 20 }]);
  assert.equal(filter.hitAllowed(verdict.hitTest.frames, [{ nodeName: "IFRAME", frameId: "BW-MENU" }]), false, "the inline menu's frame");
  assert.equal(filter.hitAllowed(verdict.hitTest.frames, [null]), false, "unknown: refused");
  assert.equal(filter.hitAllowed(verdict.hitTest.frames, [{ nodeName: "BUTTON" }]), true);
  assert.match(JSON.stringify(filter.refusal(press)), /password manager/);
  assert.ok(filter.fromClient({ ...press, params: { ...press.params, type: "mouseMoved" } }).forward, "moving the mouse is not checked");
  assert.ok(filter.fromClient({ id: 7, sessionId: "S-AGENT", method: "Input.dispatchTouchEvent", params: { type: "touchStart", touchPoints: [{ x: 1, y: 2 }] } }).hitTest);
  assert.ok(filter.fromClient({ id: 8, sessionId: "S-AGENT", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: "a", y: 1 } }).reply, "no point: refused");
  // A cross-origin frame of the page that holds the extension frame: a click on it is checked too.
  filter.fromBrowser(attached({ targetId: "XO", type: "iframe", url: "https://login.example" }, "S-AGENT"));
  filter.fromBrowser(attached({ targetId: "BW-MENU2", type: "iframe", url: "chrome-extension://dyn2/overlay/menu.html" }, "S-XO"));
  const nested = filter.fromClient(press).hitTest;
  assert.equal(filter.hitAllowed(nested.frames, [{ nodeName: "IFRAME", frameId: "XO" }]), false);
  // The extension frame goes away: clicks are free again.
  filter.fromBrowser({ method: "Target.targetDestroyed", params: { targetId: "BW-MENU" } });
  filter.fromBrowser({ method: "Target.targetDestroyed", params: { targetId: "BW-MENU2" } });
  assert.ok(filter.fromClient(press).forward);
  // The run's own page turns into an extension page: it is taken away from the run.
  const revoked = filter.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "AGENT", type: "page", url: `${ext}/popup/index.html` } } });
  assert.deepEqual(revoked.deliver.map((m) => m.method), ["Target.detachedFromTarget", "Target.targetDestroyed"]);
  assert.deepEqual(revoked.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  assert.equal(filter.isVisible("AGENT"), false);
  assert.ok(filter.fromClient({ id: 9, sessionId: "S-AGENT", method: "Runtime.evaluate", params: {} }).reply);
});

test("MCP filter: no tool call may open an extension page (also percent-encoded), in every Server browser run", () => {
  for (const signedIn of [true, false]) {
    for (const [name, args] of [
      ["browser_navigate", { url: `chrome-extension://${BITWARDEN.id}/popup/index.html` }],
      ["browser_navigate", { url: "chrome-%65xtension://abc/" }],
      ["browser_tabs", { action: "new", url: "Chrome-Extension://abc/" }],
    ]) {
      const verdict = filterClientLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }), { signedIn });
      assert.ok(verdict.reply, `${name} ${args.url}`);
      assert.equal(JSON.parse(verdict.reply).result.content[0].text, EXTENSION_URL_TEXT);
    }
    assert.ok(filterClientLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://example.com" } } }), { signedIn }).forward);
  }
  assert.equal(namesExtensionPage({ text: "x" }), false);
});

test("Bitwarden prompt, card and settings: the agent never uses the password manager; the download needs two presses; lock state, Lock now and the recommended settings are shown", () => {
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /Password manager: this browser may hold the owner's password manager \(Bitwarden\)\. It is the owner's alone: never open, click, read or use it/);
  assert.match(SIGNED_IN_SAFETY_PREAMBLE, /never ask the owner for anything stored in it/);
  const settings = readFileSync(new URL("../client/signed-in-settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /if \(armed !== "bitwarden"\) return setArmed\("bitwarden"\);/);
  assert.equal(settings.match(/bitwarden\(\{ action: "download" \}\)/g)?.length, 1, "one download call, after the confirmation");
  assert.ok(settings.indexOf('setArmed("bitwarden")') < settings.indexOf('bitwarden({ action: "download" })'));
  assert.ok(settings.indexOf("bitwarden: true }, config.revision") < settings.indexOf('bitwarden({ action: "download" })'), "the consent is saved before the download is asked for");
  assert.match(settings, /never “Never” \(that stores the key on the server's disk/);
  assert.match(settings, /turn off card and identity suggestions in the inline menu/);
  assert.match(settings, /Autofill on page load off/);
  assert.match(settings, /A plugin update that pins a newer Bitwarden builds a new extension/);
  assert.match(settings, /bitwarden\(\{ action: "lock" \}\)/);
  assert.match(settings, /bitwarden\(\{ action: "restart-browser" \}\)/);
  assert.match(settings, /Update pending: the browser switches when the run ends/);
  assert.match(settings, /a run waits until Bitwarden is locked/);
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /Bitwarden is locked again before the run goes on/);
  assert.match(card, /lockVault\("lock"\)/);
  assert.match(card, /lockVault\("restart-browser"\)/);
  assert.match(card, /waitingSignedIn && vaultLock\?\.pending/);
  assert.doesNotMatch(card, /action: "download"/, "the card never downloads");
});

test("DevTools filter: while the owner holds control nothing acts or reads; Extensions.* is refused; extension URLs are normalized; keys are checked where an extension frame is focused", () => {
  let held = false;
  const filter = createTargetFilter({ held: () => held });
  filter.fromClient({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser({ method: "Target.attachedToTarget", params: { sessionId: "S-P", targetInfo: { targetId: "P", type: "page", url: "about:blank" }, waitingForDebugger: false } });
  filter.fromBrowser({ id: 1, result: { targetId: "P" } });
  // G: the Extensions domain (load, uninstall, storage of extensions) is never the run's.
  for (const method of ["Extensions.loadUnpacked", "Extensions.uninstall", "Extensions.getStorageItems", "Extensions.setStorageItems"]) assert.ok(filter.fromClient({ id: 2, method, params: {} }).reply, method);
  // D: held.
  held = true;
  for (const method of ["Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchMouseEvent", "Page.navigate", "Page.reload", "Runtime.evaluate", "Runtime.callFunctionOn", "Page.captureScreenshot", "DOM.setFileInputFiles", "Storage.getCookies", "Network.getCookies"]) {
    const verdict = filter.fromClient({ id: 3, sessionId: "S-P", method, params: {} });
    assert.ok(verdict.reply, `${method} while held`);
  }
  assert.ok(filter.fromClient({ id: 4, method: "Target.createTarget", params: { url: "about:blank" } }).reply, "no new tab while held");
  for (const method of ["Runtime.runIfWaitingForDebugger", "Page.enable", "Runtime.enable", "Target.setAutoAttach", "DOM.enable", "Page.addScriptToEvaluateOnNewDocument"]) {
    assert.ok(filter.fromClient({ id: 5, sessionId: "S-P", method, params: {} }).forward, `${method} (session setup) passes while held`);
  }
  assert.ok(HELD_REFUSED.test("Input.dispatchTouchEvent"));
  held = false;
  assert.ok(filter.fromClient({ id: 6, sessionId: "S-P", method: "Runtime.evaluate", params: {} }).forward, "released: as before");
  // F: normalized like the MCP filter.
  for (const url of ["%63hrome-extension://x/", "chrome-\nextension://x/", " \tCHROME-EXTENSION://x", "chrome-%2565xtension://x"]) {
    assert.equal(isExtensionUrl(url), true, JSON.stringify(url));
    assert.ok(filter.fromClient({ id: 7, sessionId: "S-P", method: "Page.navigate", params: { url } }).reply, `navigate ${JSON.stringify(url)}`);
  }
  assert.equal(isExtensionUrl("https://example.com/?u=chrome-extension://x"), false);
  // B: keys on a page without an extension frame pass unchecked; with one, the focus is checked.
  assert.ok(filter.fromClient({ id: 8, sessionId: "S-P", method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowDown" } }).forward);
  filter.fromBrowser({ method: "Target.attachedToTarget", sessionId: "S-P", params: { sessionId: "S-F", targetInfo: { targetId: "F", type: "iframe", url: "chrome-extension://dyn/overlay/menu-list.html" }, waitingForDebugger: false } });
  for (const method of ["Input.dispatchKeyEvent", "Input.insertText", "Input.imeSetComposition"]) {
    const verdict = filter.fromClient({ id: 9, sessionId: "S-P", method, params: { type: "keyDown", key: "Enter", text: "x" } });
    assert.ok(verdict.focusTest, method);
    assert.equal(verdict.focusTest.frameId, "P");
  }
  const frames = filter.fromClient({ id: 10, sessionId: "S-P", method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Tab" } }).focusTest.frames;
  assert.equal(filter.focusAllowed(frames, { nodeName: "IFRAME", frameId: "F" }), false, "the inline menu itself");
  assert.equal(filter.focusAllowed(frames, { nodeName: "BIT-INLINE-MENU", shadowRoots: [{ nodeName: "#document-fragment", children: [{ nodeName: "IFRAME", frameId: "F" }] }] }), false, "a host whose (closed) shadow root holds it");
  assert.equal(filter.focusAllowed(frames, null), false, "unknown: refused");
  assert.equal(filter.focusAllowed(frames, { nodeName: "INPUT" }), true, "a field of the page");
  assert.equal(filter.focusAllowed(frames, { nodeName: "BODY", children: [{ nodeName: "IFRAME", frameId: "F" }] }), true, "no focus (the body): the frame is not focused");
  assert.equal(FOCUS_WORLD, "bp-focus-guard");
  assert.equal(filter.fromBrowser({ sessionId: "S-P", method: "Runtime.executionContextCreated", params: { context: { id: 3, name: FOCUS_WORLD, origin: "https://example.com", auxData: { isDefault: false } } } }).deliver.length, 0, "the filter's own world is not the run's");
});

test("while only the vault is being locked, the run is told to wait, not to ask the owner", () => {
  const guard = createControlGuard();
  guard.result(guard.next(), { ownerControl: true, known: true, lockPending: true, securing: true });
  assert.equal(guard.held(), true);
  assert.equal(guard.securing(), true);
  const call = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
  assert.equal(JSON.parse(filterClientLine(call, { ownerControl: guard.held(), securing: guard.securing(), signedIn: true }).reply).result.content[0].text, SECURING_TEXT);
  guard.result(guard.next(), { ownerControl: true, known: true, lockPending: true, securing: false });
  assert.equal(guard.securing(), false, "the owner holds control");
  assert.equal(JSON.parse(filterClientLine(call, { ownerControl: guard.held(), securing: guard.securing(), signedIn: true }).reply).result.content[0].text, OWNER_CONTROL_TEXT);
  assert.match(SECURING_TEXT, /Do not ask the owner/);
});

test("Bitwarden fail closed: the run's guard never opens on failed polls, and the entry point takes only that flag", () => {
  const guard = createControlGuard({ now: () => 1_000_000, failuresToOpen: Number.POSITIVE_INFINITY });
  guard.failure(guard.next());
  assert.equal(guard.held(), true, "the relay could not be asked: paused");
  for (let i = 0; i < 50; i++) guard.failure(guard.next());
  assert.equal(guard.held(), true);
  guard.result(guard.next(), { ownerControl: false });
  assert.equal(guard.held(), false, "the relay answers: it decides");
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entry, /const guard = createControlGuard\(failClosed \? \{ failuresToOpen: Number\.POSITIVE_INFINITY \} : \{\}\);/);
  assert.match(entry, /BP_CONTROL_FAIL_CLOSED may only be 1 or empty/);
  const plain = signedInPlan("/usr/bin/docker", { stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE, agentId: "a1", nonce: "n1", blockedIps: [] });
  assert.ok(!value(plain.agent.run, "--env").includes("BP_CONTROL_FAIL_CLOSED=1"));
  const closed = signedInPlan("/usr/bin/docker", { stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE, agentId: "a1", nonce: "n1", blockedIps: [], failClosed: true });
  assert.ok(value(closed.agent.run, "--env").includes("BP_CONTROL_FAIL_CLOSED=1"));
  assert.doesNotThrow(() => checkPlan(closed));
});

test("DevTools filter: a frame that attaches before its URL is known and then commits to an extension page is taken away before the run sees its content, and its clicks are checked", () => {
  const filter = createTargetFilter();
  filter.fromClient({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser({ method: "Target.attachedToTarget", params: { sessionId: "S-P", targetInfo: { targetId: "P", type: "page", url: "about:blank" }, waitingForDebugger: false } });
  filter.fromBrowser({ id: 1, result: { targetId: "P" } });
  // Bitwarden's inline menu: the OOPIF attaches with an empty URL (the run's Playwright gets it).
  const attach = filter.fromBrowser({ method: "Target.attachedToTarget", sessionId: "S-P", params: { sessionId: "S-F", targetInfo: { targetId: "F", type: "iframe", url: "" }, waitingForDebugger: true } });
  assert.equal(attach.deliver.length, 1);
  // Its own session then shows the extension page: never delivered, the frame is revoked first.
  for (const message of [
    { sessionId: "S-F", method: "Page.frameNavigated", params: { frame: { id: "F", parentId: "X", url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html" } } },
  ]) {
    const verdict = filter.fromBrowser(message);
    assert.deepEqual(verdict.deliver.map((m) => m.method), ["Target.detachedFromTarget", "Target.targetDestroyed"]);
    assert.deepEqual(verdict.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  }
  assert.equal(filter.fromBrowser({ sessionId: "S-F", method: "Runtime.executionContextCreated", params: { context: { origin: "chrome-extension://x" } } }).deliver.length, 0);
  assert.ok(filter.fromClient({ id: 2, sessionId: "S-F", method: "Runtime.evaluate", params: {} }).reply, "the run's session on it is gone");
  assert.deepEqual([...filter.extensionFrames()], ["F"], "remembered for the click check");
  const verdict = filter.fromClient({ id: 3, sessionId: "S-P", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 5, y: 5 } });
  assert.equal(filter.hitAllowed(verdict.hitTest.frames, [{ nodeName: "IFRAME", frameId: "F" }]), false);
  // The same through an execution context (origin) on a fresh frame.
  filter.fromBrowser({ method: "Target.attachedToTarget", sessionId: "S-P", params: { sessionId: "S-G", targetInfo: { targetId: "G", type: "iframe", url: "" }, waitingForDebugger: false } });
  const ctx = filter.fromBrowser({ sessionId: "S-G", method: "Runtime.executionContextCreated", params: { context: { origin: "chrome-extension://9f0e-dyn", auxData: { frameId: "G", isDefault: true } } } });
  assert.deepEqual(ctx.deliver.map((m) => m.method), ["Target.detachedFromTarget", "Target.targetDestroyed"]);
  // Bitwarden's content-script world in the run's page: not delivered, and the page stays the run's.
  const world = filter.fromBrowser({ sessionId: "S-P", method: "Runtime.executionContextCreated", params: { context: { id: 9, origin: "chrome-extension://nngceckbapebfimnlniiiahkandclblb", name: "Bitwarden Password Manager", auxData: { frameId: "P", isDefault: false, type: "isolated" } } } });
  assert.equal(world.deliver.length, 0);
  assert.equal(filter.isVisible("P"), true);
  // A normal page's own events pass.
  assert.equal(filter.fromBrowser({ sessionId: "S-P", method: "Page.frameNavigated", params: { frame: { id: "P", url: "https://example.com/" } } }).deliver.length, 1);
});
