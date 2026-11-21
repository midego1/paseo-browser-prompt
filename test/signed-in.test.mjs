// Run: npm test. The signed-in Server browser: the relay (ticket, session cookie, route allowlist,
// Host and Origin checks, WebSocket, status, rate limit) end to end against a fake neko on
// 127.0.0.1, the stack's docker arguments and their checks, the signed-in launcher plan, the run
// gate, the idle rule, the daemon side (status, explicit build, start, busy, viewer link, stop,
// log out, key rotation) against a fake docker, the neko image overrides, the prompt variant, the
// settings, and the card and settings surfaces.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
import { SIGNED_IN_FILES } from "../server/server-browser-files.ts";
import { checkPlan, launch } from "../server-browser/launch.mjs";
import {
  createCallTracker,
  createControlGuard,
  filterClientLine,
  filterServerLine,
  OWNER_CONTROL_TEXT,
  SIGNED_IN_ALLOWED_TOOLS,
  SIGNED_IN_REMOVED_TOOLS as FILTER_REMOVED,
  toolAllowed,
} from "../server-browser/mcp-filter.mjs";
import { createTargetFilter, REFUSED_METHODS } from "../server-browser/cdp-filter.mjs";
import {
  classifyRequest,
  hostsOf,
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
        const { password } = JSON.parse(body);
        if (state.failLogin) return res.writeHead(503).end("{}");
        if (password !== "admin-pw") return res.writeHead(401).end("{}");
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "NEKO_SESSION=leak" }).end(JSON.stringify({ id: "s1", token: "neko-token" }));
      });
      return;
    }
    if (req.url === "/health") return res.writeHead(200).end("true");
    if (req.headers.authorization !== "Bearer neko-token") return res.writeHead(401).end("{}");
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
  server.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    setTimeout(() => socket.end(), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, state, close: () => new Promise((resolve) => server.close(resolve)) };
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
    assert.equal(forwarded.headers.authorization, "Bearer neko-token");
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

    // WebSocket: only under the prefix, own Origin and session; upstream carries neko's token, no query.
    assert.match(await upgrade(relay.port, { ...HOST, Cookie: cookie, Origin: "http://evil.example" }, `${P}/api/ws`), / 403 /);
    assert.match(await upgrade(relay.port, { ...HOST, Cookie: cookie }, `${P}/api/ws`), / 403 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS }, `${P}/api/ws`), / 401 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS, Cookie: cookie }, "/api/ws"), / 403 /, "outside the prefix");
    assert.match(await upgrade(relay.port, { Host: "evil.example", Cookie: cookie, Origin: "http://127.0.0.1:5301" }, `${P}/api/ws`), / 421 /);
    assert.match(await upgrade(relay.port, { ...ORIGIN_HEADERS, Cookie: cookie }, `${P}/api/ws?token=evil`), / 101 /);
    const ws = neko.seen.findLast((r) => r.method === "UPGRADE");
    assert.equal(ws.url, "/api/ws");
    assert.equal(ws.headers.authorization, "Bearer neko-token");
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
    assert.ok(logs.every((line) => !line.includes(SECRET) && !line.includes("neko-token") && !line.includes(ticket)), "logs hold no secrets or tickets");
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

test("relay: takeover state on the control listener follows neko's control, unsure counts as held while a viewer is connected, and the last viewer leaving resets control", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  const read = async () => JSON.parse((await http(port, "GET", "/control")).body);
  try {
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: false, known: true });
    neko.state.hasHost = true;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: true, known: true });
    assert.equal((await http(port, "GET", "/other")).status, 404);
    assert.equal((await http(port, "POST", "/control")).status, 404);
    neko.state.hasHost = false;
    await relay.pollControl();
    assert.equal((await read()).ownerControl, false);
    // neko cannot be asked: without viewers nobody can hold control; with one, unsure counts as held.
    neko.state.controlFails = true;
    await relay.pollControl();
    assert.deepEqual(await read(), { ownerControl: false, known: false });
    const created = await postTicket(relay, ticketAt(Date.now(), "ctrl-ctrl-ctrl-001"));
    const cookie = String(created.headers["set-cookie"]).split(";")[0];
    const socket = connect(relay.port, "127.0.0.1");
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(
      [`GET ${relay.prefix}/api/ws HTTP/1.1`, "Host: 127.0.0.1:5301", "Origin: http://127.0.0.1:5301", `Cookie: ${cookie}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    await new Promise((resolve) => socket.once("data", resolve));
    assert.equal(relay.state().viewers, 1);
    assert.deepEqual(await read(), { ownerControl: true, known: false }, "unsure while a viewer is connected: held");
    // The fake neko ends the WebSocket after 50 ms: the last viewer is gone, control is reset.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(relay.state().viewers, 0);
    assert.equal(neko.state.resets, 1, "control reset when the last viewer left");
    socket.destroy();
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("relay: an https origin gets Secure cookies, and the relay refuses to start without its secrets", async () => {
  const neko = await fakeNeko();
  const base = { nekoHost: "127.0.0.1", nekoPort: neko.port, listenHost: "127.0.0.1", listenPort: 0, secret: SECRET, statusToken: STATUS, adminPassword: "admin-pw" };
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
  assert.match(entry, /const verdict = filterClientLine\(line, \{ ownerControl: guard\.held\(\), signedIn \}\);/);
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
      const kind = tag.startsWith("browser-prompt-signed-in:") ? "neko" : "server";
      return state.images.has(kind) ? ok("sha256:x") : { code: 1, stdout: "", stderr: "No such image" };
    }
    if (sub === "build") {
      state.images.add(args.includes("browser-prompt.signed-in=image") ? "neko" : "server");
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
    if (sub === "run") {
      state.containers.set(value(args, "--name")[0], "running");
      const tag = value(args, "--label").find((label) => label.startsWith("browser-prompt.signed-in-config="));
      if (tag) state.relayTag = tag.split("=")[1];
      return ok("cid");
    }
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
  assert.match(start, /rm -f \/home\/neko\/\.config\/chromium\/SingletonLock/);
  const policies = JSON.parse(SIGNED_IN_FILES["policies.json"]);
  assert.equal(policies.DefaultCookiesSetting, 1);
  assert.equal(policies.DeveloperToolsAvailability, 1);
  assert.equal(policies.PasswordManagerEnabled, false);
  assert.equal(policies.DownloadRestrictions, 3);
  assert.equal(policies.ExtensionInstallForcelist, undefined);
  for (const blocked of ["file://*", "chrome://*", "chrome-untrusted://*", "chrome-search://*", "chrome-extension://*", "devtools://*", "view-source:*", "about:*"]) {
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
  for (const name of Object.keys(SIGNED_IN_FILES)) assert.equal(SIGNED_IN_FILES[name], readFileSync(new URL(`../signed-in/${name}`, import.meta.url), "utf8"), name);
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
  assert.match(settings, /useEffect\(\(\) => setArmed\(null\), \[info\?\.state\]\);/);
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

test("control guard: unsure counts as held, a held state lasts through failures for 10 s, opens only after sustained failure, ignores old results", () => {
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
  assert.equal(guard.held(), true, "unsure counts as held");
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

test("DevTools filter: the owner's tabs are hidden from the run; commands on them and closing the browser are refused", () => {
  let held = false;
  const filter = createTargetFilter({ held: () => held });
  filter.hideExisting(["OWNER1", "OWNER2"]);
  const attached = (targetId, extra = {}) => ({ method: "Target.attachedToTarget", params: { sessionId: `S-${targetId}`, targetInfo: { targetId, type: "page", ...extra }, waitingForDebugger: false } });
  // Existing owner pages: never reach Playwright, and are detached.
  let verdict = filter.fromBrowser(attached("OWNER1"));
  assert.equal(verdict.deliver, null);
  assert.deepEqual(verdict.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  assert.equal(filter.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "OWNER2", type: "page", url: "https://mail.example/" } } }).deliver, null);
  assert.equal(filter.fromBrowser({ sessionId: "S-OWNER1", method: "Page.frameNavigated", params: {} }).deliver, null, "nothing from a hidden session");
  // The run's own page: visible.
  verdict = filter.fromBrowser(attached("AGENT1"));
  assert.ok(verdict.deliver);
  // A page the owner opens while holding control: hidden, resumed and detached.
  held = true;
  verdict = filter.fromBrowser({ method: "Target.attachedToTarget", params: { sessionId: "S-NEW", targetInfo: { targetId: "OWNERNEW", type: "page" }, waitingForDebugger: true } });
  assert.equal(verdict.deliver, null);
  assert.deepEqual(verdict.toBrowser.map((m) => m.method), ["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]);
  // A popup of the run's page stays visible even while held; a popup of an owner page is hidden.
  assert.ok(filter.fromBrowser(attached("POPUP1", { openerId: "AGENT1" })).deliver);
  held = false;
  assert.equal(filter.fromBrowser(attached("POPUP2", { openerId: "OWNER2" })).deliver, null);
  // Commands.
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) {
    assert.ok(filter.fromClient({ id: 5, method, params: { targetId: "OWNER1" } }).reply, method);
    assert.ok(filter.fromClient({ id: 6, method, params: { targetId: "AGENT1" } }).forward, method);
  }
  for (const method of REFUSED_METHODS) assert.ok(filter.fromClient({ id: 7, method }).reply, method);
  assert.ok(filter.fromClient({ id: 8, sessionId: "S-NEW", method: "Runtime.evaluate" }).reply, "a hidden session cannot be used");
  // Target lists leave out hidden pages; the filter's own messages' answers are dropped.
  const listed = filter.fromBrowser({ id: 9, result: { targetInfos: [{ targetId: "OWNER1", type: "page" }, { targetId: "AGENT1", type: "page" }] } });
  assert.deepEqual(listed.deliver.result.targetInfos.map((t) => t.targetId), ["AGENT1"]);
  assert.equal(filter.fromBrowser({ id: verdict.toBrowser?.[0]?.id ?? 2_000_000_000, result: {} }).deliver, null);
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
