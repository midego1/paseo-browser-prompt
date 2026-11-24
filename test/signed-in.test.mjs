// Run: npm test. The signed-in Server browser: the relay (ticket, session cookie, route allowlist,
// Host and Origin checks, WebSocket, status, rate limit) end to end against a fake neko on
// 127.0.0.1, the stack's docker arguments and their checks, the signed-in launcher plan, the run
// gate, the idle rule, the daemon side (status, explicit build, start, busy, viewer link, stop,
// log out, key rotation) against a fake docker, the neko image overrides, the prompt variant, the
// settings, and the card and settings surfaces.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  isLegacyBitwardenImageTag,
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
import { createSignedIn, loadKeys, relaySecret, signedInConfigFrom, signViewerTicket } from "../server/signed-in.ts";
import { SIGNED_IN_FILES } from "../server/server-browser-files.ts";
import { checkPlan, launch } from "../server-browser/launch.mjs";
import {
  CONTROL_MAX_AGE_MS,
  CONTROL_POLL,
  createControlGuard,
  createControlPoller,
  createRunFilter,
  EXTENSION_URL_TEXT,
  lineSplitter,
  MAX_CLIENT_LINE,
  MAX_SERVER_LINE,
  RELAY_CONTROL_POLL_MS,
  idOfDroppedLine,
  TOO_LONG_REQUEST_TEXT,
  TOO_LONG_RESULT_TEXT,
  UNAVAILABLE_TEXT,
  UNCONFIRMED_TEXT,
  filterClientLine,
  namesExtensionPage,
  filterServerLine,
  OWNER_CONTROL_TEXT,
  SIGNED_IN_ALLOWED_TOOLS,
  SIGNED_IN_REMOVED_TOOLS as FILTER_REMOVED,
  toolAllowed,
} from "../server-browser/mcp-filter.mjs";
import { createTargetFilter, HELD_REFUSED, isExtensionUrl, REFUSED_METHODS } from "../server-browser/cdp-filter.mjs";
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
  NEKO_CONTROL_TIMEOUT_MS,
  startRelay,
  TICKET_MAX_TTL_S,
  verifyTicket,
} from "../server-browser/relay.mjs";

const SECRET = "s".repeat(43);
const STATUS = "t".repeat(43);
const INSTANCE = "paseo-box-11111111-2222-3333-4444-555555555555";

/**
 * The relay's GET /control body without its per-read fields (checked here): the age of neko's last
 * read (a number, or null before any), the relay start and the control epoch.
 */
async function readControl(port) {
  const body = JSON.parse((await http(port, "GET", "/control")).body);
  const { sampledAgoMs, bootId, epoch, ...rest } = body;
  assert.ok(sampledAgoMs === null || (Number.isInteger(sampledAgoMs) && sampledAgoMs >= 0), `sampledAgoMs ${sampledAgoMs}`);
  assert.match(bootId, /^[0-9a-f]{16}$/);
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0, `epoch ${epoch}`);
  assert.equal(typeof rest.ownerControl, "boolean", "always an explicit boolean");
  return rest;
}
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
      if (state.controlHangs) return;
      if (state.controlFails) return res.writeHead(500).end("{}");
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ has_host: state.hasHost }));
    }
    if (req.url === "/api/room/control/take" && state.takeDelayMs) {
      setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"), state.takeDelayMs);
      return;
    }
    if (req.url === "/api/room/control/reset") {
      if (state.failReset) return res.writeHead(500).end("{}");
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
    assert.equal((await http(relay.port, "POST", `${P}/api/room/control/take`, { ...ORIGIN_HEADERS, Cookie: cookie })).status, 409, "control is never taken without this session's viewer WebSocket");
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

test("relay: takeover state follows neko's control (its host counts with or without a viewer), unsure while a viewer is connected counts as held (known: false), and the last viewer leaving resets control", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  const read = async () => (await readControl(port));
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
  assert.match(entry, /const verdict = filter\.client\(line\);/);
  assert.match(entry, /const kept = filter\.server\(line\);/);
  assert.match(entry, /const poll = createControlPoller\(\{ guard, url: controlUrl, timeoutMs: CONTROL_POLL\.timeoutMs, log, onPoll: \(\) => filter\.sync\(\) \}\);\n  await poll\(\);/, "the first poll ends before Playwright MCP starts");
  assert.match(entry, /setInterval\(\(\) => void poll\(\), CONTROL_POLL\.intervalMs\)/);
  assert.match(entry, /setInterval\(\(\) => filter\.sync\(\), 250\)/);
  assert.ok(entry.indexOf("await poll();") < entry.indexOf("const child = spawn("), "no agent message is read before the first poll");
  assert.ok(entry.indexOf("await poll();") < entry.indexOf('process.stdin.on("data"'));
  assert.match(entry, /if \(signedIn && !controlUrl\) \{\n  log\("BP_CONTROL_URL is missing/, "signed-in without the relay's state: no start");
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
  // legacyTags: Bitwarden variant images of plugin versions before 0.25.0; rmiFails: tags `docker rmi` refuses.
  const state = { images: new Set([...(serverImage ? ["server"] : []), ...(nekoImage ? ["neko"] : [])]), containers: new Map(), networks: new Set(), volumes: new Set(), agents: [], legacyTags: new Set(), rmiFails: new Set() };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (_command, args) => {
    calls.push(args);
    const [sub, second] = args;
    if (sub === "info") return ok('["name=rootless"]');
    if (sub === "image" && second === "inspect") {
      const tag = args.at(-1);
      if (state.legacyTags.has(tag)) return ok("sha256:bw");
      const kind = tag.startsWith("browser-prompt-signed-in:") ? "neko" : "server";
      return state.images.has(kind) ? ok("sha256:x") : { code: 1, stdout: "", stderr: "No such image" };
    }
    if (sub === "image" && second === "ls") {
      if (state.imageLsFails) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      return ok([...(state.images.has("neko") ? ["browser-prompt-signed-in:neko3.2.0-0123456789ab"] : []), ...state.legacyTags].join("\n"));
    }
    if (sub === "rmi") {
      const tag = args[1];
      if (state.rmiFails.has(tag)) return { code: 1, stdout: "", stderr: "image is being used by running container" };
      state.legacyTags.delete(tag);
      state.removed = [...(state.removed ?? []), tag];
      return ok();
    }
    if (sub === "exec") {
      state.execs = [...(state.execs ?? []), args];
      return ok();
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
      if (/-neko$/.test(value(args, "--name")[0])) state.nekoImage = args.at(-1);
      const tag = value(args, "--label").find((label) => label.startsWith("browser-prompt.signed-in-config="));
      if (tag) state.relayTag = tag.split("=")[1];
      return ok("cid");
    }
    if (sub === "inspect" && args[2] === "{{.Config.Image}}" && state.inspectFails) return { code: 1, stdout: "", stderr: "Error response from daemon: timeout" };
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
    serverBrowser: extra.wrapServerBrowser ? extra.wrapServerBrowser(sb) : sb,
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

test("daemon: a signed-in run stopped before its MCP container came up frees the browser for Run again", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  const first = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(first.ok, true);
  assert.equal(si.consumeTicket(first.ticket, { sourceId: "s", cardId: "c" }), true);
  assert.ok("server" in (await si.mcpServer("run-a")));
  assert.deepEqual(await si.prepare({ sourceId: "s", cardId: "c" }), { ok: false, state: "busy", detail: "" }, "admitted, not up yet: busy");
  si.release("run-a");
  assert.equal((await si.prepare({ sourceId: "s", cardId: "c" })).ok, true, "stopped within the window: Run again is not refused");
});

test("daemon: a stale close of an older signed-in session leaves the new session's admission", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  const first = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(si.consumeTicket(first.ticket, { sourceId: "s", cardId: "c" }), true);
  const mcp = await si.mcpServer("run-a");
  assert.ok("server" in mcp);
  const admitted = si.admission("run-a");
  assert.equal(admitted.session, mcp.session, "the admission names its session");
  // A close seen before this admission is about an older session: the browser stays held.
  si.release("run-a", admitted.seq - 1);
  assert.deepEqual(await si.prepare({ sourceId: "s", cardId: "c" }), { ok: false, state: "busy", detail: "" }, "still held");
  // One seen at or after it releases, and so does a call without a time.
  si.release("run-a", admitted.seq);
  const again = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(again.ok, true);
  assert.equal(si.consumeTicket(again.ticket, { sourceId: "s", cardId: "c" }), true);
  assert.ok("server" in (await si.mcpServer("run-a")));
  si.release("run-a");
  assert.equal((await si.prepare({ sourceId: "s", cardId: "c" })).ok, true);
});

test("daemon: an admission whose setup throws gives back the admission it replaced, and a failed second call does not touch the first's session", async () => {
  const docker = fakeStackDocker();
  let failSetup = false;
  let n = 0;
  const random = () => {
    if (failSetup) throw new Error("setup failed");
    return (++n).toString(16).padStart(32, "0");
  };
  const { si } = makeSignedIn(docker, { random });
  const first = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(si.consumeTicket(first.ticket, { sourceId: "s", cardId: "c" }), true);
  const ok = await si.mcpServer("run-a");
  assert.ok("server" in ok);
  const before = si.admission("run-a");
  assert.equal(before.session, ok.session);
  failSetup = true;
  await assert.rejects(si.mcpServer("run-a"), /setup failed/);
  assert.equal(si.admission("run-a"), before, "the failed call's admission goes; the one it replaced comes back, unchanged");
  assert.equal(si.admission("run-a").session, ok.session);
  assert.deepEqual(await si.mcpServer("run-b"), { refused: "busy" }, "the first session's starting window is kept");
});

test("daemon: two concurrent setups that both fail give back the last admission that did not fail, never a failed one (m3)", async () => {
  const docker = fakeStackDocker();
  let failSetup = false;
  let n = 0;
  const random = () => {
    if (failSetup) throw new Error("setup failed");
    return (++n).toString(16).padStart(32, "0");
  };
  // Both setups wait until both have claimed: the second claim replaces the first while it runs.
  let waiting = 0;
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const wrapServerBrowser = (sb) => ({
    ...sb,
    runtime: async () => {
      if (failSetup && ++waiting === 2) open();
      if (failSetup) await gate;
      return sb.runtime();
    },
  });
  const { si } = makeSignedIn(docker, { random, wrapServerBrowser });
  await si.viewerLink({ purpose: "login", portrait: false });
  const ok = await si.mcpServer("run-a");
  const before = si.admission("run-a");
  assert.equal(before.session, ok.session);
  failSetup = true;
  const results = await Promise.allSettled([si.mcpServer("run-a"), si.mcpServer("run-a")]);
  assert.equal(waiting, 2, "both setups overlapped");
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(si.admission("run-a"), before, "the first, good admission comes back");
  assert.equal(si.admission("run-a").failed, undefined);
  assert.deepEqual(await si.mcpServer("run-b"), { refused: "busy" }, "with its starting window");
});

test("daemon: a release during a failed setup is not undone (m4)", async () => {
  const docker = fakeStackDocker();
  let failSetup = false;
  let n = 0;
  const holder = {};
  const random = () => {
    if (failSetup) {
      holder.si.release("run-a"); // the run was stopped while its setup ran
      throw new Error("setup failed");
    }
    return (++n).toString(16).padStart(32, "0");
  };
  const { si } = makeSignedIn(docker, { random });
  holder.si = si;
  await si.viewerLink({ purpose: "login", portrait: false });
  assert.ok("server" in (await si.mcpServer("run-a")));
  failSetup = true;
  await assert.rejects(si.mcpServer("run-a"), /setup failed/);
  failSetup = false;
  assert.ok("server" in (await si.mcpServer("run-b")), "released: the earlier starting window is not put back");
});

test("daemon: a first admission whose setup throws leaves no admission and no starting entry (the browser is not reported busy)", async () => {
  const docker = fakeStackDocker();
  let failSetup = false;
  let n = 0;
  const random = () => {
    if (failSetup) throw new Error("setup failed");
    return (++n).toString(16).padStart(32, "0");
  };
  const { si } = makeSignedIn(docker, { random });
  await si.viewerLink({ purpose: "login", portrait: false });
  failSetup = true;
  await assert.rejects(si.mcpServer("run-a"), /setup failed/);
  assert.equal(si.admission("run-a"), undefined);
  assert.equal((await si.status()).busy, false, "no starting entry left behind");
  failSetup = false;
  assert.ok("server" in (await si.mcpServer("run-b")), "another run is admitted right away, not after the 2 min window");
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
  // No extension at all (since 0.25.0, with Bitwarden gone): nothing forced, everything blocked, no way to add one.
  assert.deepEqual(policies.ExtensionInstallForcelist, []);
  assert.deepEqual(policies.ExtensionInstallBlocklist, ["*"]);
  assert.equal(policies.ExtensionInstallAllowlist, undefined);
  assert.equal(policies.ExtensionSettings, undefined);
  assert.deepEqual(policies.ExtensionInstallSources, []);
  assert.deepEqual(policies.ExtensionAllowedTypes, ["extension"]);
  assert.equal(policies.BlockExternalExtensions, true);
  assert.equal(policies.ExtensionDeveloperModeSettings, 1, "developer mode off");
  for (const store of ["chromewebstore.google.com", "chrome.google.com/webstore"]) assert.ok(policies.URLBlocklist.includes(store), store);
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
  // Watch on a signed-in run opens the same viewer (Take over) while the run is going or waits.
  assert.match(card, /const watchesViewer = runBrowser === "signed-in";/);
  assert.match(card, /onPress=\{\(\) => \(watchesViewer \? void takeOver\(\) : openAgent\(\)\)\}/);
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

/** A valid release from the relay (its read of neko `ago` ms old, relay start `boot`, control `epoch`). */
const release = (ago = 0, epoch = 0, boot = "abc123") => ({ ownerControl: false, known: true, sampledAgoMs: ago, bootId: boot, epoch });
const toolCall = (id, name = "browser_snapshot") => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
const toolResult = (id, text = "page content") => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const textOf = (line) => JSON.parse(line).result.content[0].text;

test("control guard (fail closed): starts held, and only a valid ownerControl: false releases", () => {
  let t = 1000;
  const guard = createControlGuard({ now: () => t });
  assert.equal(guard.held(), true, "held before any status");
  assert.equal(guard.reason(), "unavailable");
  assert.equal(guard.confirmation(), null);
  const invalid = [
    undefined, null, "false", 0, [], ["ownerControl", false], {}, { known: true }, { ownerControl: null }, { ownerControl: "false" }, { ownerControl: 0 }, { ownerControl: undefined },
    { ownerControl: false }, { ...release(), sampledAgoMs: undefined }, { ...release(), sampledAgoMs: -1 }, { ...release(), sampledAgoMs: "0" }, { ...release(), sampledAgoMs: null },
    { ...release(), bootId: undefined }, { ...release(), bootId: "" }, { ...release(), bootId: "ZZ" }, { ...release(), epoch: -1 }, { ...release(), epoch: 1.5 }, { ...release(), epoch: "0" },
  ];
  for (const body of invalid) {
    guard.result(guard.next(), body);
    assert.equal(guard.held(), true, `not a valid release: ${JSON.stringify(body)}`);
    assert.equal(guard.unavailable(), true, JSON.stringify(body));
  }
  guard.result(guard.next(), release(0, 7));
  assert.equal(guard.held(), false, "a valid release opens");
  assert.equal(guard.reason(), "released");
  assert.deepEqual(guard.confirmation(), { bootId: "abc123", epoch: 7 });
  guard.result(guard.next(), { ...release(), known: false });
  assert.equal(guard.held(), false, "the relay's boolean decides; `known` is informational");
  guard.result(guard.next(), { ownerControl: true, known: true });
  assert.equal(guard.held(), true);
  assert.equal(guard.reason(), "owner", "held by the owner, not unavailable");
  assert.equal(guard.confirmation(), null);
  // A relay from before 0.25.0 (Bitwarden) may still send securing / lockFailed: held by the owner, as any hold.
  guard.result(guard.next(), { ownerControl: true, securing: true });
  assert.equal(guard.held(), true);
  assert.equal(guard.reason(), "owner");
  guard.result(guard.next(), { ownerControl: true, securing: true, lockFailed: true });
  assert.equal(guard.reason(), "owner");
  guard.result(guard.next(), release());
  guard.result(guard.next(), { known: true });
  assert.equal(guard.held(), true, "ownerControl missing again after a release: held");
  guard.result(guard.next(), { ...release(), securing: true, lockFailed: true });
  assert.equal(guard.held(), false, "extra fields of an old relay do not change a valid release");
});

test("control guard (fail closed): any failure after a release holds again, and no number of failures opens it", () => {
  let t = 1000;
  const guard = createControlGuard({ now: () => t });
  guard.result(guard.next(), release());
  assert.equal(guard.held(), false);
  guard.failure(guard.next());
  assert.equal(guard.held(), true, "one failed poll after a release: paused");
  assert.equal(guard.unavailable(), true);
  for (let i = 0; i < 100; i++) {
    t += 500;
    guard.failure(guard.next());
    assert.equal(guard.held(), true, `failure ${i + 2}: still paused`);
  }
  guard.result(guard.next(), release());
  assert.equal(guard.held(), false, "the relay answers again with a release: open");
  const never = createControlGuard({ now: () => t });
  for (let i = 0; i < 10; i++) never.failure(never.next());
  assert.equal(never.held(), true, "never confirmed: stays held through failures");
  guard.result(guard.next(), { ownerControl: true, securing: true });
  guard.failure(guard.next());
  assert.equal(guard.reason(), "unavailable", "a failed poll is unavailable, also after an old relay's hold");
  assert.equal(guard.unavailable(), true);
});

test("control guard (fail closed): a release is good for maxAgeMs from the relay's own read of neko, on a monotonic clock; a clock that goes backwards holds", () => {
  assert.equal(CONTROL_MAX_AGE_MS, CONTROL_POLL.timeoutMs + 2 * CONTROL_POLL.intervalMs + RELAY_CONTROL_POLL_MS, "derived from the poll settings in one place");
  assert.equal(CONTROL_MAX_AGE_MS, 3000);
  let t = 10_000;
  const guard = createControlGuard({ now: () => t, maxAgeMs: 3000 });
  const seq = guard.next();
  t += 200; // the poll took 200 ms; the relay's read was 400 ms old when it answered
  guard.result(seq, release(400));
  // Counted from the poll's start minus the read's age: 10 000 - 400 = 9 600.
  t = 9600 + 3000;
  assert.equal(guard.held(), false, "3 s after the relay's read: still good");
  t += 1;
  assert.equal(guard.held(), true, "older than 3 s without a newer release: held");
  assert.equal(guard.unavailable(), true);
  guard.result(guard.next(), release(0));
  assert.equal(guard.held(), false, "a fresh release opens again");
  t -= 1;
  assert.equal(guard.held(), true, "the clock went backwards (negative age): stale, held");
  t += 1;
  assert.equal(guard.held(), false);
  guard.result(guard.next(), release(3001));
  assert.equal(guard.held(), true, "the relay's own read is already too old: held");
  assert.equal(createControlGuard().held(), true, "default options (performance.now): held at the start");
  const real = createControlGuard();
  real.result(real.next(), release(0));
  assert.equal(real.held(), false, "default clock: a fresh release opens");
});

test("control guard (fail closed): older results and failures are ignored (sequence order)", () => {
  const guard = createControlGuard({ now: () => 1000 });
  const late = guard.next();
  guard.result(guard.next(), { ownerControl: true });
  guard.result(late, release());
  assert.equal(guard.held(), true, "an older release does not overwrite a newer hold");
  const slowFailure = guard.next();
  guard.result(guard.next(), release());
  guard.failure(slowFailure);
  assert.equal(guard.held(), false, "an older failure does not overwrite a newer release");
  const old = guard.next();
  guard.failure(guard.next());
  guard.result(old, release());
  assert.equal(guard.held(), true, "an older release does not overwrite a newer failure");
  guard.result(0, release());
  guard.result(Number.NaN, release());
  guard.result("99", release());
  guard.result(999, release());
  assert.equal(guard.held(), true, "a sequence number next() did not hand out: ignored");
});

/** A signed-in run filter on a fake clock, with the guard fed directly. */
function runRig() {
  const clock = { t: 1000 };
  const now = () => clock.t;
  const guard = createControlGuard({ now });
  const emitted = [];
  const filter = createRunFilter({ signedIn: true, guard, now, emit: (line) => emitted.push(line) });
  const status = (body) => {
    guard.result(guard.next(), body);
    filter.sync();
  };
  const fail = () => {
    guard.failure(guard.next());
    filter.sync();
  };
  return { clock, guard, filter, emitted, status, fail };
}

test("run filter (signed-in): a tool call before the first status is refused (wait), initialize and tools/list pass, the normal flow opens after a valid release", () => {
  const { filter, status } = runRig();
  const early = filter.client(toolCall(1));
  assert.ok("reply" in early, "nothing reaches Playwright MCP before a valid release");
  assert.equal(textOf(early.reply), UNAVAILABLE_TEXT);
  assert.match(UNAVAILABLE_TEXT, /Wait about 5 seconds and try the same call again/);
  assert.equal(filter.calls.size(), 0);
  const init = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  assert.deepEqual(filter.client(init), { forward: init });
  assert.equal(filter.server(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { capabilities: {} } })), JSON.stringify({ jsonrpc: "2.0", id: 0, result: { capabilities: {} } }), "a tracked answer passes");
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(filter.client(list), { forward: list }, "listing tools does not touch the browser");
  status({ ownerControl: true, known: true });
  assert.equal(textOf(filter.client(toolCall(4)).reply), OWNER_CONTROL_TEXT, "the owner holds control");
  status(release());
  assert.deepEqual(filter.client(toolCall(5)), { forward: toolCall(5) }, "released: the call goes to Playwright MCP");
  assert.equal(filter.server(toolResult(5)), toolResult(5), "and its result comes back");
  assert.equal(filter.calls.size(), 1, "tools/list is still in flight");
});

test("run filter (signed-in): JSON-RPC ids are strings or numbers, one request per id in flight, and untracked answers are dropped (F1)", () => {
  const { filter, status, clock } = runRig();
  status(release());
  for (const id of [null, { a: 1 }, [1], true, Number.NaN]) {
    const verdict = filter.client(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }));
    assert.ok("reply" in verdict, `id ${JSON.stringify(id)} refused, not forwarded`);
    assert.equal(JSON.parse(verdict.reply).error.code, -32600);
  }
  assert.deepEqual(filter.client(toolCall(1)), { forward: toolCall(1) });
  // The owner takes control while call 1 runs: it is marked held.
  status({ ownerControl: true });
  status(release(0, 1));
  // A second call with the same id after the release is refused: it cannot clear the mark.
  const again = filter.client(toolCall(1));
  assert.ok("reply" in again, "a duplicate in-flight id is never forwarded");
  assert.equal(JSON.parse(again.reply).error.code, -32600);
  assert.equal(textOf(filter.server(toolResult(1, "what the owner typed"))), OWNER_CONTROL_TEXT, "the mark is sticky: its result is withheld");
  // Two answers with one id, and answers to ids never asked for: dropped, also while held.
  assert.deepEqual(filter.client(toolCall("x")), { forward: toolCall("x") });
  assert.equal(filter.server(toolResult("x")), toolResult("x"));
  assert.equal(filter.server(toolResult("x", "second answer")), null, "a second answer to the same id is dropped");
  status({ ownerControl: true });
  assert.equal(filter.server(toolResult(42, "secret")), null, "an untracked answer while held is dropped");
  status(release(0, 2));
  assert.equal(filter.server(toolResult(43)), null, "an untracked answer is dropped while released too");
  assert.equal(filter.server(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })), null, "an answer without an id is dropped");
  const serverRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "roots/list" });
  assert.equal(filter.server(serverRequest), serverRequest, "Playwright MCP's own requests pass");
  // A string id "1" and a number id 1 are different ids.
  assert.deepEqual(filter.client(toolCall(7)), { forward: toolCall(7) });
  assert.deepEqual(filter.client(toolCall("7")), { forward: toolCall("7") });
  // Other methods are not available; a cancelled id is not reused and its late answer is dropped.
  assert.equal(JSON.parse(filter.client(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "resources/read", params: { uri: "x" } })).reply).error.code, -32601);
  filter.client(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }));
  assert.ok("reply" in filter.client(toolCall(7)), "a cancelled id is not reused while Playwright MCP may still answer it");
  assert.equal(filter.server(toolResult(7)), null, "the late answer to a cancelled call is dropped");
  clock.t += 1;
});

test("run filter (signed-in): a call in flight while the status was not confirmed is always withheld, never released later (N1)", () => {
  const { filter, status, fail, emitted, clock } = runRig();
  status(release(0, 3));
  // A failure while it runs, the result during the outage: withheld at once (nothing buffered).
  assert.deepEqual(filter.client(toolCall(1)), { forward: toolCall(1) });
  fail();
  assert.equal(textOf(filter.server(toolResult(1))), UNCONFIRMED_TEXT);
  assert.match(UNCONFIRMED_TEXT, /may have been carried out: take a snapshot before you repeat it/);
  // A 4 s outage with the epoch unchanged afterwards: still withheld (the epoch proves nothing then).
  status(release(0, 3));
  assert.deepEqual(filter.client(toolCall(2)), { forward: toolCall(2) });
  fail();
  clock.t += 4000;
  status(release(0, 3));
  assert.equal(textOf(filter.server(toolResult(2))), UNCONFIRMED_TEXT, "not the owner text, and not released");
  assert.deepEqual(emitted, [], "nothing is sent later");
  // A stale release while it runs (no poll for > 3 s): withheld.
  assert.deepEqual(filter.client(toolCall(3)), { forward: toolCall(3) });
  clock.t += 3001;
  filter.sync();
  status(release(0, 3));
  assert.equal(textOf(filter.server(toolResult(3))), UNCONFIRMED_TEXT);
  // Stale exactly when the result arrives: withheld too.
  assert.deepEqual(filter.client(toolCall(4)), { forward: toolCall(4) });
  clock.t += 3001;
  assert.equal(textOf(filter.server(toolResult(4))), UNCONFIRMED_TEXT);
  assert.equal(textOf(filter.client(toolCall(5)).reply), UNAVAILABLE_TEXT);
  // The relay started again while it ran: withheld.
  status(release(0, 3));
  assert.deepEqual(filter.client(toolCall(6)), { forward: toolCall(6) });
  status(release(0, 0, "def456"));
  assert.equal(textOf(filter.server(toolResult(6))), UNCONFIRMED_TEXT);
  // The epoch moved between two good polls (a viewer, a control request, a takeover): owner text.
  assert.deepEqual(filter.client(toolCall(7)), { forward: toolCall(7) });
  status(release(0, 1, "def456"));
  assert.equal(textOf(filter.server(toolResult(7))), OWNER_CONTROL_TEXT);
  // A real ownerControl: true while it runs: owner text, also after a failure and a release.
  assert.deepEqual(filter.client(toolCall(8)), { forward: toolCall(8) });
  fail();
  status({ ownerControl: true });
  status(release(0, 2, "def456"));
  assert.equal(textOf(filter.server(toolResult(8))), OWNER_CONTROL_TEXT, "the worst mark wins");
  // An old relay's (before 0.25.0) lockFailed hold while it ran: withheld like any hold.
  assert.deepEqual(filter.client(toolCall(9)), { forward: toolCall(9) });
  status({ ownerControl: true, lockFailed: true });
  assert.equal(textOf(filter.server(toolResult(9))), OWNER_CONTROL_TEXT);
  // Nothing happened while it ran: passed.
  status(release(0, 2, "def456"));
  assert.deepEqual(filter.client(toolCall(10)), { forward: toolCall(10) });
  status(release(0, 2, "def456"));
  assert.equal(filter.server(toolResult(10)), toolResult(10));
  assert.equal(filter.calls.size(), 0);
});

test("run filter (signed-in): notifications and methods (N4): a tools/call without an id is dropped, only some notifications pass, logging/setLevel is answered here", () => {
  const { filter, status } = runRig();
  status(release());
  const noId = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
  assert.deepEqual(filter.client(noId), { drop: true }, "a tools/call in notification form never reaches the browser, also while released");
  for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]) {
    const line = JSON.stringify({ jsonrpc: "2.0", method, params: {} });
    assert.deepEqual(filter.client(line), { forward: line }, method);
  }
  assert.deepEqual(filter.client(JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever" })), { drop: true });
  assert.deepEqual(filter.client(JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 })), { drop: true });
  const level = filter.client(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "logging/setLevel", params: { level: "info" } }));
  assert.deepEqual(JSON.parse(level.reply), { jsonrpc: "2.0", id: 3, result: {} }, "answered here, never forwarded");
  const response = JSON.stringify({ jsonrpc: "2.0", id: "s1", result: { roots: [] } });
  assert.deepEqual(filter.client(response), { forward: response }, "the agent's answer to Playwright MCP's own request");
  for (const method of ["notifications/progress", "notifications/message", "notifications/resources/updated"]) {
    assert.equal(filter.server(JSON.stringify({ jsonrpc: "2.0", method, params: { data: "page text" } })), null, `${method} from Playwright MCP is dropped`);
  }
  for (const method of ["notifications/tools/list_changed", "notifications/cancelled"]) {
    const line = JSON.stringify({ jsonrpc: "2.0", method, params: {} });
    assert.equal(filter.server(line), line, method);
  }
  const roots = JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "roots/list" });
  assert.equal(filter.server(roots), roots);
  assert.equal(filter.server(JSON.stringify({ jsonrpc: "2.0", id: "s2", method: "sampling/createMessage", params: { messages: [] } })), null, "other requests from Playwright MCP are dropped");
});

test("run filter (signed-in): retired ids age out only by time and block new requests when too many (N3); unanswered requests get an error after the maximum call time (N5)", () => {
  const { filter, status, emitted, clock } = runRig();
  status(release());
  const cancel = (id) => filter.client(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }));
  // N5: no answer within 10 minutes.
  assert.deepEqual(filter.client(toolCall(1)), { forward: toolCall(1) });
  clock.t += 10 * 60_000;
  status(release());
  assert.deepEqual(emitted, [], "10 minutes exactly: still waiting");
  clock.t += 1;
  status(release());
  assert.equal(emitted.length, 1);
  assert.deepEqual(JSON.parse(emitted[0]).id, 1);
  assert.match(JSON.parse(emitted[0]).error.message, /No answer from the browser within 10 minutes/);
  assert.equal(filter.calls.size(), 0);
  assert.ok("reply" in filter.client(toolCall(1)), "its id stays retired");
  assert.equal(filter.server(toolResult(1)), null, "a late answer is dropped");
  // N3: a cancelled id is not reused until it ages out (10 minutes), however many others are cancelled.
  assert.deepEqual(filter.client(toolCall(2)), { forward: toolCall(2) });
  cancel(2);
  for (let i = 100; i < 600; i++) {
    filter.client(toolCall(i));
    cancel(i);
  }
  assert.ok("reply" in filter.client(toolCall(2)), "still retired after 500 more cancellations");
  for (let i = 600; i < 1200; i++) {
    filter.client(toolCall(i));
    cancel(i);
  }
  const full = filter.client(toolCall(5000));
  assert.match(JSON.parse(full.reply).error.message, /Too many requests/, "the retired cap refuses new requests instead of forgetting old ids");
  assert.ok("reply" in filter.client(toolCall(2)), "the first cancelled id was never evicted");
  clock.t += 10 * 60_000 + 1;
  status(release());
  assert.deepEqual(filter.client(toolCall(2)), { forward: toolCall(2) }, "a cancelled id ages out: it may be used again");
  assert.equal(filter.server(toolResult(2)), toolResult(2));
  // L2: the id of a call given up on (no answer) never ages out while that call may still run.
  assert.equal(filter.calls.retiredCount(), 0);
  assert.deepEqual(filter.client(toolCall(77)), { forward: toolCall(77) });
  clock.t += 10 * 60_000 + 1;
  status(release());
  assert.equal(JSON.parse(emitted.at(-1)).id, 77, "given up on");
  clock.t += 60 * 60_000;
  status(release());
  assert.equal(filter.calls.retiredCount(), 1);
  assert.ok("reply" in filter.client(toolCall(77)), "an hour later: still retired");
  assert.equal(filter.server(toolResult(77, "late")), null, "its late answer is dropped");
  assert.equal(filter.calls.retiredCount(), 0, "answered: the id is free");
  assert.deepEqual(filter.client(toolCall(77)), { forward: toolCall(77) });
});

test("run filter (signed-in): a stale gap before a fresh release marks calls in flight unconfirmed (L1), and a duplicate id is refused before logging/setLevel is answered (L3)", async () => {
  const { guard, filter, clock } = runRig();
  const answers = [];
  const fetchImpl = async () => {
    clock.t += 10; // the relay answers 10 ms later
    const body = answers.shift();
    return { ok: true, status: 200, json: async () => body };
  };
  const poll = createControlPoller({ guard, url: "u", fetchImpl, onPoll: () => filter.sync() });
  clock.t = 0;
  answers.push(release());
  await poll();
  assert.deepEqual(filter.client(toolCall(1)), { forward: toolCall(1) }, "call at t = 0");
  clock.t = 3050; // stale (no fresh sample for > 3 s), and no 250 ms tick ran
  answers.push(release());
  await poll(); // the fresh release is applied at 3060
  assert.equal(guard.held(), false);
  assert.equal(textOf(filter.server(toolResult(1))), UNCONFIRMED_TEXT, "the stale gap was seen before the fresh release");
  assert.deepEqual(filter.client(toolCall(2)), { forward: toolCall(2) });
  const level = filter.client(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "info" } }));
  assert.equal(JSON.parse(level.reply).error.code, -32600, "an id in flight is refused, even for a request answered here");
});

test("run filter (signed-in): the poller treats errors, timeouts, non-2xx (body cancelled), garbage and invalid bodies as failures, and logs once", async () => {
  const { guard, filter } = runRig();
  const answers = [];
  let cancelled = 0;
  const fetchImpl = async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: async () => void cancelled++ },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  });
  const logs = [];
  let polls = 0;
  const poll = createControlPoller({ guard, url: "http://bp-si-0a1b2c3d-relay:8081/control", fetchImpl, log: (m) => logs.push(m), onPoll: () => polls++ });
  for (const answer of [new Error("ECONNREFUSED"), new DOMException("timeout", "TimeoutError"), respond(500, release()), respond(404, {}), respond(200, "not json"), respond(200, { known: true }), respond(200, { ownerControl: false })]) {
    answers.push(answer);
    await poll();
    assert.equal(guard.held(), true);
    assert.equal(textOf(filter.client(toolCall(3)).reply), UNAVAILABLE_TEXT);
  }
  assert.equal(cancelled, 2, "the body of a non-2xx answer is cancelled");
  assert.equal(logs.length, 1, "logged once while it keeps failing");
  assert.ok(polls >= 14, "onPoll before the result is applied and after every poll");
  answers.push(respond(200, release()));
  await poll();
  assert.equal(guard.held(), false);
  // Two polls never run at once.
  let resolveSlow;
  let fetches = 0;
  const slow = createControlPoller({ guard, url: "u", fetchImpl: () => (fetches++, new Promise((resolve) => (resolveSlow = resolve))) });
  const first = slow();
  await slow();
  assert.equal(fetches, 1);
  resolveSlow(respond(200, release()));
  await first;
  assert.equal(guard.held(), false);
  assert.throws(() => createRunFilter({ signedIn: true }), /needs the takeover guard/);
});

test("line splitter: a line over the limit is dropped whole, never forwarded in part (F5)", () => {
  const lines = [];
  let overflows = 0;
  const infos = [];
  const split = lineSplitter((line) => lines.push(line), { maxLength: 10, onOverflow: (info) => (overflows++, infos.push(info)) });
  split.push("short\n0123456789ABC");
  split.push("DEF still the long line");
  split.push(" end\nnext\n");
  split.push("x".repeat(11));
  split.push("\nlast");
  split.end();
  assert.deepEqual(lines, ["short", "next", "last"]);
  assert.equal(overflows, 2);
  assert.equal(infos[0].head, "0123456789ABC", "the start of the dropped line");
  assert.equal(infos[0].tail, "0123456789ABCDEF still the long line end", "and its end");
  assert.equal(infos[1].tail, "x".repeat(11));
  assert.equal(MAX_CLIENT_LINE, 8 * 1024 * 1024);
  assert.ok(MAX_SERVER_LINE >= MAX_CLIENT_LINE);
});

test("over-long lines are answered by their id (from the start for the agent, the end for Playwright MCP), in both kinds of Server browser", () => {
  assert.equal(idOfDroppedLine({ head: '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"x":"aaaa' }), 7);
  assert.equal(idOfDroppedLine({ head: '{"id":"a\\"b","method":"x' }), 'a"b');
  assert.equal(idOfDroppedLine({ head: '{"result":{"content":"', tail: 'aaaa"}]},"jsonrpc":"2.0","id":12}' }), 12, "the SDK writes the id last");
  assert.equal(idOfDroppedLine({ head: '{"method":"tools/call","params":{"id":5,"text":"', tail: 'aaa"}}' }), undefined, "a nested id is not the message's");
  assert.equal(idOfDroppedLine({ head: "garbage", tail: "garbage" }), undefined);
  assert.equal(idOfDroppedLine({ tail: '"id":{"a":1}}' }), undefined);
  const { filter, status, clock, emitted } = runRig();
  status(release());
  const reply = JSON.parse(filter.overflowFromClient({ head: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_type","arguments":{"text":"', tail: 'xxx"}}}' }));
  assert.equal(reply.id, 3);
  assert.equal(reply.error.message, TOO_LONG_REQUEST_TEXT);
  assert.equal(filter.overflowFromClient({ head: "{", tail: "}" }), null, "no id: nothing to answer");
  assert.deepEqual(filter.client(toolCall(4)), { forward: toolCall(4) });
  assert.equal(filter.overflowFromClient({ head: '{"id":4,"method":"tools/call"' }), null, "an id in flight is not answered for the dropped message");
  const answer = JSON.parse(filter.overflowFromServer({ head: '{"result":{"content":[{"type":"image","data":"', tail: 'AAAA"}]},"jsonrpc":"2.0","id":4}' }));
  assert.equal(answer.id, 4);
  assert.equal(answer.error.message, TOO_LONG_RESULT_TEXT);
  assert.equal(filter.calls.size(), 0, "the call is no longer in flight");
  assert.equal(filter.overflowFromServer({ tail: '"jsonrpc":"2.0","id":99}' }), null, "an untracked id is not answered");
  // An answer whose id cannot be read: the call gets the no-answer error after 10 minutes.
  assert.deepEqual(filter.client(toolCall(5)), { forward: toolCall(5) });
  assert.equal(filter.overflowFromServer({ head: "x", tail: "y" }), null);
  clock.t += 10 * 60_000 + 1;
  status(release());
  assert.equal(JSON.parse(emitted.at(-1)).id, 5);
  // The clean Server browser answers the same way (no tracking there).
  const clean = createRunFilter({ signedIn: false, guard: null });
  assert.equal(JSON.parse(clean.overflowFromClient({ head: '{"jsonrpc":"2.0","id":1,"method":"tools/call"' })).error.message, TOO_LONG_REQUEST_TEXT);
  assert.equal(JSON.parse(clean.overflowFromServer({ tail: ',"jsonrpc":"2.0","id":1}' })).error.message, TOO_LONG_RESULT_TEXT);
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entry, /const reply = filter\.overflowFromClient\(info\);\n    if \(reply\) process\.stdout\.write/);
  assert.match(entry, /const reply = filter\.overflowFromServer\(info\);\n    if \(reply\) process\.stdout\.write/);
});

test("control guard: held with known: false (the relay cannot read neko while a viewer is connected) is unavailable, not a takeover: results come back unconfirmed", () => {
  const { guard, filter, status } = runRig();
  status(release());
  assert.deepEqual(filter.client(toolCall(1)), { forward: toolCall(1) });
  status({ ownerControl: true, known: false, sampledAgoMs: 900, bootId: "abc123", epoch: 0 });
  assert.equal(guard.held(), true, "still paused");
  assert.equal(guard.reason(), "unavailable");
  assert.equal(textOf(filter.client(toolCall(2)).reply), UNAVAILABLE_TEXT);
  status(release());
  assert.equal(textOf(filter.server(toolResult(1))), UNCONFIRMED_TEXT, "not 'the owner has taken over'");
  status({ ownerControl: true, known: true });
  assert.equal(guard.reason(), "owner");
});

test("relay: a failed neko read while a viewer watches does not move the epoch, and a hanging neko read gives up after 1.5 s", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  const raw = async () => JSON.parse((await http(port, "GET", "/control")).body);
  try {
    await relay.pollControl();
    const created = await postTicket(relay, ticketAt(Date.now(), "unsu-unsu-unsu-0001"));
    const cookie = String(created.headers["set-cookie"]).split(";")[0];
    const socket = connect(relay.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(
      [`GET ${relay.prefix}/api/ws HTTP/1.1`, "Host: 127.0.0.1:5301", "Origin: http://127.0.0.1:5301", `Cookie: ${cookie}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    await new Promise((resolve) => socket.once("data", resolve));
    const before = (await raw()).epoch;
    neko.state.controlFails = true;
    await relay.pollControl();
    const unsure = await raw();
    assert.deepEqual([unsure.ownerControl, unsure.known], [true, false], "paused, as unsure");
    assert.equal(unsure.epoch, before, "an unsure read is not a takeover");
    neko.state.controlFails = false;
    neko.state.controlHangs = true;
    const started = Date.now();
    await relay.pollControl();
    const took = Date.now() - started;
    assert.ok(took >= 1400 && took < 3000, `the read gave up after about 1.5 s (${took} ms)`);
    assert.equal(NEKO_CONTROL_TIMEOUT_MS, 1500);
    assert.equal((await raw()).known, false);
    neko.state.controlHangs = false;
    await relay.pollControl();
    const back = await raw();
    assert.deepEqual([back.ownerControl, back.known, back.epoch], [false, true, before], "readable again, nobody held control: same epoch");
    socket.destroy();
  } finally {
    await relay.close();
    await neko.close();
  }
});

test("run filter (clean Server browser): no takeover guard, tool calls pass as before", () => {
  const filter = createRunFilter({ signedIn: false, guard: null });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_evaluate", arguments: {} } });
  assert.deepEqual(filter.client(call), { forward: call });
  const result = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(filter.server(result), result);
  assert.equal(filter.calls, null);
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

test("relay: neko's host counts with or without a viewer, a release carries the age of neko's read, and the epoch grows with every takeover (F3, F4)", async () => {
  const neko = await fakeNeko();
  let clockMs = 50_000;
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {}, clock: () => clockMs });
  const port = await relay.startControl("127.0.0.1", 0);
  const raw = async () => JSON.parse((await http(port, "GET", "/control")).body);
  try {
    await relay.pollControl();
    let body = await raw();
    assert.equal(body.ownerControl, false);
    assert.equal(body.sampledAgoMs, 0);
    const epoch0 = body.epoch;
    clockMs += 1200;
    assert.equal((await raw()).sampledAgoMs, 1200, "the age of neko's last read, on the relay's monotonic clock");
    // neko's control read fails with no viewer: the last value stays, its age grows; the run's guard holds once it is too old.
    neko.state.controlFails = true;
    for (let i = 0; i < 3; i++) await relay.pollControl();
    clockMs += 2000;
    body = await raw();
    assert.equal(body.ownerControl, false);
    assert.equal(body.sampledAgoMs, 3200);
    const guard = createControlGuard();
    guard.result(guard.next(), body);
    assert.equal(guard.held(), true, "a release from a read 3.2 s old: held");
    neko.state.controlFails = false;
    // A host neko reports without any viewer (taken some other way) holds the run until reset.
    neko.state.hasHost = true;
    neko.state.failReset = true;
    await relay.pollControl();
    body = await raw();
    assert.equal(body.ownerControl, true, "a host without a viewer: held (fail closed)");
    assert.ok(body.epoch > epoch0, "a held period starts a new epoch");
    neko.state.failReset = false;
    await relay.pollControl();
    body = await raw();
    assert.equal(body.ownerControl, false, "reset: released again");
    const epoch1 = body.epoch;
    // Taking control over REST needs this session's viewer WebSocket.
    const created = await postTicket(relay, ticketAt(Date.now(), "rest-rest-rest-0001"));
    const cookie = String(created.headers["set-cookie"]).split(";")[0];
    const take = () => http(relay.port, "POST", `${relay.prefix}/api/room/control/take`, { ...ORIGIN_HEADERS, Cookie: cookie });
    assert.equal((await take()).status, 409, "no viewer WebSocket: refused");
    const socket = connect(relay.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(
      [`GET ${relay.prefix}/api/ws HTTP/1.1`, "Host: 127.0.0.1:5301", "Origin: http://127.0.0.1:5301", `Cookie: ${cookie}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    await new Promise((resolve) => socket.once("data", resolve));
    const epochViewer = (await raw()).epoch;
    assert.ok(epochViewer > epoch1, "a viewer WebSocket that opens is a new epoch");
    neko.state.hasHost = false;
    // L4: while a control request is forwarded, and until a read of neko that began after it, held.
    neko.state.takeDelayMs = 300;
    const slowTake = take();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await raw()).ownerControl, true, "a take on its way: held before neko reports anything");
    assert.equal((await slowTake).status, 200);
    neko.state.takeDelayMs = 0;
    for (let i = 0; i < 100 && (await raw()).ownerControl; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await raw()).ownerControl, false, "a read after it saw no host: released");
    assert.equal((await take()).status, 200, "with its viewer: forwarded");
    const epochTake = (await raw()).epoch;
    assert.ok(epochTake >= epochViewer + 2, "a forwarded control request is a new epoch before and after it");
    // A takeover that begins and ends between two of the run's reads still moves the epoch.
    neko.state.hasHost = true;
    await relay.pollControl();
    neko.state.hasHost = false;
    await relay.pollControl();
    body = await raw();
    assert.equal(body.ownerControl, false);
    assert.ok(body.epoch > epoch1, "the run sees that a takeover happened");
    assert.match(body.bootId, /^[0-9a-f]{16}$/);
    socket.destroy();
    for (let i = 0; i < 100 && relay.state().viewers > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await raw()).epoch > body.epoch, "a viewer WebSocket that closes is a new epoch");
  } finally {
    await relay.close();
    await neko.close();
  }
  const relayFile = readFileSync(new URL("../server-browser/relay.mjs", import.meta.url), "utf8");
  assert.match(relayFile, new RegExp(`controlPollMs = ${RELAY_CONTROL_POLL_MS},`), "the relay reads neko as often as the guard's max age assumes");
});

test("the run's poller over real HTTP: held until the relay answers, open on its release, held when the relay is gone", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {} });
  const port = await relay.startControl("127.0.0.1", 0);
  const guard = createControlGuard();
  const filter = createRunFilter({ signedIn: true, guard });
  const call = toolCall(1);
  try {
    assert.equal(textOf(filter.client(call).reply), UNAVAILABLE_TEXT, "before the first status");
    const wrong = createControlPoller({ guard, url: `http://127.0.0.1:${port}/other` });
    await wrong();
    assert.equal(guard.held(), true, "a 404 is not a status");
    await relay.pollControl();
    const poll = createControlPoller({ guard, url: `http://127.0.0.1:${port}/control`, onPoll: () => filter.sync() });
    await poll();
    assert.equal(guard.held(), false, "the relay's explicit ownerControl: false with its read's age releases");
    assert.deepEqual(filter.client(call), { forward: call });
    await relay.close();
    await poll();
    assert.equal(guard.held(), true, "the relay is gone: paused again");
    assert.equal(textOf(filter.client(toolCall(2)).reply), UNAVAILABLE_TEXT);
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

test("DevTools filter: extension targets are hidden everywhere and the run cannot open extension pages (defense in depth: no extension can be installed)", () => {
  const filter = createTargetFilter();
  const attached = (info, sessionId) => ({ method: "Target.attachedToTarget", ...(sessionId ? { sessionId } : {}), params: { sessionId: `S-${info.targetId}`, targetInfo: info, waitingForDebugger: false } });
  const delivered = (verdict) => verdict.deliver.length > 0;
  const ext = `chrome-extension://${"e".repeat(32)}`;
  assert.equal(isExtensionUrl(`${ext}/popup/index.html`), true);
  assert.equal(isExtensionUrl(" CHROME-EXTENSION://x/"), true);
  assert.equal(isExtensionUrl("https://example.com/chrome-extension://"), false);
  // Service worker, page, other: hidden like every target the run did not create.
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "EXT-SW", type: "service_worker", url: `${ext}/background.js` }))), false);
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "EXT-PAGE", type: "page", url: `${ext}/popup/index.html` }))), false);
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) assert.ok(filter.fromClient({ id: 1, method, params: { targetId: "EXT-SW" } }).reply, method);
  // The run's page.
  filter.fromClient({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser(attached({ targetId: "AGENT", type: "page", url: "about:blank" }));
  filter.fromBrowser({ id: 2, result: { targetId: "AGENT" } });
  assert.equal(filter.isVisible("AGENT"), true);
  // An extension page as a popup of the run's page, or as a frame in it: hidden too.
  assert.equal(delivered(filter.fromBrowser(attached({ targetId: "EXT-WIN", type: "page", openerId: "AGENT", url: `${ext}/popup/index.html` }))), false);
  const frame = filter.fromBrowser(attached({ targetId: "EXT-FRAME", type: "iframe", url: "chrome-extension://9f0e1d2c-dynamic/overlay/menu-list.html" }, "S-AGENT"));
  assert.equal(delivered(frame), false);
  assert.deepEqual(frame.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  // Navigation to extension pages.
  for (const url of [`${ext}/popup/index.html`, "chrome-extension://abc/x.html", " chrome-extension://abc/"]) {
    assert.match(filter.fromClient({ id: 3, sessionId: "S-AGENT", method: "Page.navigate", params: { url } }).reply.error.message, /browser extension/);
    assert.ok(filter.fromClient({ id: 4, method: "Target.createTarget", params: { url } }).reply);
  }
  assert.ok(filter.fromClient({ id: 5, sessionId: "S-AGENT", method: "Page.navigate", params: { url: "https://example.com" } }).forward);
  // Input goes straight through (no extension frame check any more: there is no extension).
  const press = { id: 6, sessionId: "S-AGENT", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 } };
  assert.deepEqual(filter.fromClient(press), { forward: press });
  const key = { id: 7, sessionId: "S-AGENT", method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } };
  assert.deepEqual(filter.fromClient(key), { forward: key });
});

test("MCP filter: no tool call may open an extension page (also percent-encoded), in every Server browser run", () => {
  for (const signedIn of [true, false]) {
    for (const [name, args] of [
      ["browser_navigate", { url: `chrome-extension://${"e".repeat(32)}/popup/index.html` }],
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

test("DevTools filter: while the owner holds control nothing acts or reads; Extensions.* is refused; extension URLs are normalized", () => {
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
});

test("fail closed for every signed-in run: the plan always names the relay's takeover state, never a fail-closed flag, and the launcher requires it", () => {
  const guard = createControlGuard({ now: () => 1_000_000 });
  for (let i = 0; i < 50; i++) guard.failure(guard.next());
  assert.equal(guard.held(), true, "the relay could not be asked: paused");
  guard.result(guard.next(), release());
  assert.equal(guard.held(), false, "the relay answers: it decides");
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /BP_CONTROL_FAIL_CLOSED|failuresToOpen/, "no switch to a guard that opens on failures");
  const plan = signedInPlan("/usr/bin/docker", { stackId: "0a1b2c3d", instance: INSTANCE, serverImage: SERVER_IMAGE, agentId: "a1", nonce: "n1", blockedIps: [] });
  const env = value(plan.agent.run, "--env");
  assert.ok(env.includes("BP_CONTROL_URL=http://bp-si-0a1b2c3d-relay:8081/control"));
  assert.ok(!env.some((item) => item.startsWith("BP_CONTROL_FAIL_CLOSED")));
  assert.doesNotThrow(() => checkPlan(plan));
  const without = structuredClone(plan);
  const at = without.agent.run.findIndex((arg) => arg.startsWith("BP_CONTROL_URL="));
  without.agent.run.splice(at - 1, 2);
  assert.throws(() => checkPlan(without), /takeover state/, "no takeover state: the launcher refuses the plan");
  const twice = structuredClone(plan);
  twice.agent.run.splice(at + 1, 0, "--env", plan.agent.run[at]);
  assert.throws(() => checkPlan(twice), /takeover state/);
});

test("relay: /bp/status names its start (bootId), new on every relay start", async () => {
  const neko = await fakeNeko();
  const a = await relayFor(neko, { log: () => {} });
  const b = await relayFor(neko, { log: () => {} });
  try {
    const status = async (relay) => JSON.parse((await http(relay.port, "GET", "/bp/status", { ...HOST, Authorization: `Bearer ${STATUS}` })).body);
    const first = await status(a);
    assert.match(first.bootId, /^[0-9a-f]{16}$/);
    assert.equal((await status(a)).bootId, first.bootId);
    assert.notEqual((await status(b)).bootId, first.bootId);
    assert.equal(a.state().bootId, first.bootId);
  } finally {
    await a.close();
    await b.close();
    await neko.close();
  }
});

// ---------------------------------------------------------------- 0.25.0: Bitwarden removed (migration)

const LEGACY_BW_TAG = "browser-prompt-signed-in:neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654";

test("0.25.0 settings: a stored document with the old bitwarden keys still parses (they are dropped), and the daemon ignores them", async () => {
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  const block = settings.slice(settings.indexOf('id: "signed-in"'), settings.indexOf("export const cardSettings"));
  assert.match(block, /version: 1,/, "no version bump: nothing to migrate");
  assert.doesNotMatch(block, /bitwarden: z\.|bitwardenConsent: z\.|\.strict\(\)/, "the keys are gone and unknown keys are not refused");
  // A plain zod object (as the schema is) drops unknown keys instead of failing.
  const { z } = await import("zod");
  const shape = z.object({ port: z.number().int().default(DEFAULT_SIGNED_IN_PORT), httpsBaseUrl: z.string().default("") });
  assert.deepEqual(shape.parse({ port: 5400, httpsBaseUrl: "", bitwarden: true, bitwardenConsent: "07cf" }), { port: 5400, httpsBaseUrl: "" });
  const defaults = { port: DEFAULT_SIGNED_IN_PORT, validHttpsBase: (base) => validateHttpsBase(base) === null };
  assert.deepEqual(signedInConfigFrom({ status: "ready", values: { port: 5400, httpsBaseUrl: "", bitwarden: true, bitwardenConsent: "x" } }, defaults), { port: 5400, httpsBaseUrl: "" });
  assert.deepEqual(signedInConfigFrom({ status: "ready", values: { port: 5400, bitwarden: "yes" } }, defaults), { port: 5400, httpsBaseUrl: "" });
  for (const read of [null, { status: "invalid" }, { status: "ready" }]) assert.deepEqual(signedInConfigFrom(read, defaults), { port: DEFAULT_SIGNED_IN_PORT, httpsBaseUrl: "" });
});

test("0.25.0 migration: the signing key, its temp files, the Bitwarden build contexts and the -bw images go (best effort, retried); nothing else", async () => {
  const docker = fakeStackDocker();
  docker.state.legacyTags = new Set([LEGACY_BW_TAG, "browser-prompt-signed-in:neko3.2.0-aaaaaaaaaaaa-bw2026.10.0-bbbbbbbbbbbb"]);
  docker.state.rmiFails = new Set([LEGACY_BW_TAG]);
  const logs = [];
  const { si, dir } = makeSignedIn(docker, { log: (m) => logs.push(m) });
  writeFileSync(join(dir, "keys.json"), "{}");
  writeFileSync(join(dir, "bitwarden-key.pem"), "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n");
  writeFileSync(join(dir, "bitwarden-key.pem.0a1b2c.tmp"), "partial");
  writeFileSync(join(dir, "other.pem"), "kept");
  mkdirSync(join(dir, "build", "neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654"), { recursive: true });
  writeFileSync(join(dir, "build", "neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654", "install-bitwarden.py"), "x");
  mkdirSync(join(dir, "build", "neko3.2.0-0123456789ab"), { recursive: true });
  await si.removeLegacyBitwarden();
  assert.equal(existsSync(join(dir, "bitwarden-key.pem")), false, "the key is gone");
  assert.equal(existsSync(join(dir, "bitwarden-key.pem.0a1b2c.tmp")), false, "and a temp file of it");
  assert.equal(existsSync(join(dir, "other.pem")), true);
  assert.equal(existsSync(join(dir, "keys.json")), true, "the viewer keys stay");
  assert.equal(existsSync(join(dir, "build", "neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654")), false, "the variant's build context is gone");
  assert.equal(existsSync(join(dir, "build", "neko3.2.0-0123456789ab")), true, "the signed-in image's stays");
  const rmis = () => docker.calls.filter((args) => args[0] === "rmi");
  assert.deepEqual(rmis().map((args) => args.length), [2, 2], "docker rmi without force, one tag each");
  assert.deepEqual(docker.state.removed, ["browser-prompt-signed-in:neko3.2.0-aaaaaaaaaaaa-bw2026.10.0-bbbbbbbbbbbb"]);
  assert.ok(!rmis().some((args) => !isLegacyBitwardenImageTag(args[1])), "never the signed-in image itself");
  assert.ok(logs.some((m) => /removed the Bitwarden signing key/.test(m)));
  // An image a container still uses stays until a later check; then it goes, and the checks stop.
  docker.state.rmiFails.clear();
  await si.removeLegacyBitwarden();
  assert.deepEqual(docker.state.removed, ["browser-prompt-signed-in:neko3.2.0-aaaaaaaaaaaa-bw2026.10.0-bbbbbbbbbbbb", LEGACY_BW_TAG]);
  const before = docker.calls.length;
  await si.removeLegacyBitwarden();
  assert.equal(docker.calls.length, before, "done: no more docker calls");
  // Nothing to remove, or docker down: no error, tried again later.
  const fresh = fakeStackDocker();
  fresh.state.imageLsFails = true;
  const empty = makeSignedIn(fresh, { buildRoot: join(tmpdir(), "bp-si-no-such-dir"), legacyBitwardenKeyFile: join(tmpdir(), "bp-si-no-such-dir", "bitwarden-key.pem") });
  await assert.doesNotReject(empty.si.removeLegacyBitwarden());
  fresh.state.imageLsFails = false;
  await empty.si.removeLegacyBitwarden();
  assert.equal(fresh.calls.filter((args) => args[0] === "image" && args[1] === "ls").length, 2, "retried after the failed listing");
  assert.equal(fresh.calls.filter((args) => args[0] === "rmi").length, 0);
});

test("0.25.0 migration: a running browser with the old Bitwarden image is replaced once no run holds it (also with a viewer), and never handed to a new run or session", async () => {
  const docker = fakeStackDocker();
  const { si, setRelay } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  // The state an update leaves: neko still runs the old variant.
  docker.state.nekoImage = LEGACY_BW_TAG;
  docker.state.legacyTags.add(LEGACY_BW_TAG);
  // A run holds it: kept (that run keeps its browser), but nobody new gets it.
  docker.state.agents = [{ id: "c1c1c1c1", agent: "old-run" }];
  assert.equal((await si.idleCheck()), false);
  assert.equal(docker.state.nekoImage, LEGACY_BW_TAG, "not under a run");
  const prepared = await si.prepare({ sourceId: "s", cardId: "c" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "busy");
  assert.deepEqual(await si.mcpServer("old-run"), { refused: "unavailable" }, "a new session of that run does not get the old image");
  // That refusal also asked for the switch; with the run still holding the browser it keeps the old image.
  await si.ensureStarted();
  assert.equal(docker.state.nekoImage, LEGACY_BW_TAG);
  // The run is gone; a viewer is still connected: the old image goes anyway (logins kept, a graceful stop).
  docker.state.agents = [];
  setRelay(true, 1);
  await si.idleCheck();
  assert.equal(docker.state.nekoImage, si.image, "started again with the plain image");
  assert.ok(docker.calls.some((args) => args[0] === "stop" && args.at(-1) === "bp-si-" + createHash("sha256").update(INSTANCE).digest("hex").slice(0, 8) + "-neko"), "stopped gracefully first");
  const neko = docker.calls.filter((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0])).at(-1);
  assert.equal(neko.at(-1), si.image);
  const relay = docker.calls.filter((args) => args[0] === "run" && /-relay$/.test(value(args, "--name")[0])).at(-1);
  assert.ok(!value(relay, "--env").some((env) => env.startsWith("BP_LOCK_ON_RELEASE")), "the relay has no lock mode any more");
  // An ordinary plugin update (an older plain image) still waits for the viewer to leave.
  docker.state.nekoImage = "browser-prompt-signed-in:neko3.2.0-111111111111";
  await si.idleCheck();
  assert.equal(docker.state.nekoImage, "browser-prompt-signed-in:neko3.2.0-111111111111", "not while a viewer is connected");
});

test("0.25.0 migration: a relay from before 0.25.0 that still waits for a vault lock is started again without (no viewer); neko keeps running", async () => {
  const docker = fakeStackDocker();
  let relay = { viewers: 0, idleMs: 0, nekoUp: true, portrait: false, lockPending: true };
  const logs = [];
  const { si } = makeSignedIn(docker, { relayStatus: async () => relay, log: (m) => logs.push(m) });
  await si.viewerLink({ purpose: "login", portrait: false });
  docker.state.agents = [{ id: "c1c1c1c1", agent: "paused-run" }];
  const relayRuns = () => docker.calls.filter((args) => args[0] === "run" && /-relay$/.test(value(args, "--name")[0])).length;
  const nekoRuns = () => docker.calls.filter((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0])).length;
  const [relays, nekos] = [relayRuns(), nekoRuns()];
  // A viewer is connected: left as it is (restarting the relay would cut the owner off); the run waits for the viewer to leave.
  relay = { ...relay, viewers: 1 };
  assert.equal(await si.legacyRelayCheck(), false);
  assert.equal(relayRuns(), relays);
  relay = { ...relay, viewers: 0 };
  assert.equal(await si.legacyRelayCheck(), true);
  assert.equal(relayRuns(), relays + 1, "the relay was started again");
  assert.equal(nekoRuns(), nekos, "neko (and the paused run's browser) kept running");
  assert.ok(logs.some((m) => /waits for a Bitwarden lock/.test(m)));
  // A new relay reports no pending lock: nothing more to do.
  relay = { viewers: 0, idleMs: 0, nekoUp: true, portrait: false };
  assert.equal(await si.legacyRelayCheck(), false);
  assert.equal(relayRuns(), relays + 1);
  // The relay does not answer: nothing (the guard of the run fails closed meanwhile).
  const quiet = makeSignedIn(fakeStackDocker(), { relayStatus: async () => null });
  assert.equal(await quiet.si.legacyRelayCheck(), false);
});

test("0.25.0 relay: no lock mode, no lock endpoints, and the release after a takeover is a release (no securing round)", async () => {
  const neko = await fakeNeko();
  const relay = await relayFor(neko, { controlPollMs: 60_000, log: () => {}, lockOnRelease: true });
  const port = await relay.startControl("127.0.0.1", 0);
  try {
    await relay.pollControl();
    assert.deepEqual(await readControl(port), { ownerControl: false, known: true }, "from the start: an old lock option is ignored");
    // A host (no viewer, and its reset fails): held; then released.
    neko.state.hasHost = true;
    neko.state.failReset = true;
    await relay.pollControl();
    assert.equal((await readControl(port)).ownerControl, true);
    neko.state.hasHost = false;
    neko.state.failReset = false;
    await relay.pollControl();
    assert.deepEqual(await readControl(port), { ownerControl: false, known: true }, "released: the run goes on right away");
    const auth = { ...HOST, Authorization: `Bearer ${STATUS}`, "Content-Type": "application/json" };
    const status = JSON.parse((await http(relay.port, "GET", "/bp/status", auth)).body);
    for (const key of ["lockPending", "lockGeneration", "lockFailed"]) assert.equal(key in status, false, key);
    for (const path of ["/bp/locked", "/bp/lock-failed"]) assert.notEqual((await http(relay.port, "POST", path, auth, JSON.stringify({ generation: 1 }))).status, 200, path);
    for (const key of ["lockPending", "lockGeneration"]) assert.equal(key in relay.state(), false, key);
  } finally {
    await relay.close();
    await neko.close();
  }
  assert.doesNotMatch(readFileSync(new URL("../server-browser/relay-main.mjs", import.meta.url), "utf8"), /LOCK_ON_RELEASE|lockOnRelease/);
});

/** Runs chromium-start.sh against a profile in `dir` (Chromium replaced by echo). */
function runStartScript(dir) {
  return spawnSync("sh", ["-c", `sed -e "s|^PROFILE=.*|PROFILE=$T/profile|" -e "s|exec /usr/bin/chromium|exec echo|" "$0" | sh -s -- --flag`, new URL("../signed-in/chromium-start.sh", import.meta.url).pathname], {
    env: { PATH: "/usr/bin:/bin", BP_PROXY: "http://bp-si-0a1b2c3d-proxy:3128", T: dir },
    encoding: "utf8",
  });
}

test("0.25.0 chromium-start.sh: every recorded Bitwarden build's data and preference entries go, then the ids file; site logins, cookies and other data stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-bw-gone-"));
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const data = (id) => [
    `Default/Local Extension Settings/${id}`,
    `Default/Sync Extension Settings/${id}`,
    `Default/Managed Extension Settings/${id}`,
    `Default/IndexedDB/chrome-extension_${id}_0.indexeddb.leveldb`,
    `Default/IndexedDB/chrome-extension_${id}_0.indexeddb.blob`,
    `Default/File System/chrome-extension_${id}_0`,
    `Default/Storage/ext/${id}`,
    `Default/Extensions/${id}`,
    `Profile 1/Local Extension Settings/${id}`,
  ];
  const kept = ["Default/Local Storage/leveldb", "Default/IndexedDB/https_example.com_0.indexeddb.leveldb", "Default/Local Extension Settings/mhjfbmdgcfjbbpaeojofohoefgiehjai"];
  for (const path of [...data(a), ...data(b), ...kept, "Default/Extension State", "Default/Extension Rules", "Profile 1/Extension Scripts"]) mkdirSync(join(dir, "profile", path), { recursive: true });
  writeFileSync(join(dir, "profile", "Default", "Cookies"), "cookie-db");
  writeFileSync(join(dir, "profile", "Default", "Login Data"), "logins");
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), `${a}\n${b}\n`);
  writeFileSync(join(dir, "profile", ".bp-bitwarden-dbs-cleared"), `${a}\n`);
  writeFileSync(
    join(dir, "profile", "Default", "Preferences"),
    JSON.stringify({
      extensions: {
        settings: { [a]: { location: 7 }, [b]: { location: 7 }, other: { location: 5 } },
        pinned: [`chrome-extension://${b}/popup`, "x"],
        commands: { "linux:Ctrl+Shift+L": { command_name: "autofill_login", extension: b, global: false } },
      },
      profile: { content_settings: { exceptions: { clipboard: { [`chrome-extension://${a},*`]: { setting: 1 }, "https://example.com,*": { setting: 1 } } } } },
      keep: "https://example.com",
    }),
  );
  writeFileSync(join(dir, "profile", "Default", "Secure Preferences"), JSON.stringify({ protection: { macs: { extensions: { settings: { [a]: "m", [b]: "m", other: "m" } } } } }));
  const result = runStartScript(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--flag --proxy-server=http:\/\/bp-si-0a1b2c3d-proxy:3128 --proxy-bypass-list=<-loopback>/, "Chromium starts as always");
  for (const path of [...data(a), ...data(b)]) assert.equal(existsSync(join(dir, "profile", path)), false, `${path} removed`);
  for (const path of ["Default/Extension State", "Default/Extension Rules", "Profile 1/Extension Scripts"]) assert.equal(existsSync(join(dir, "profile", path)), false, `${path} (shared, keyed by id) removed`);
  for (const path of [...kept, "Default/Cookies", "Default/Login Data"]) assert.equal(existsSync(join(dir, "profile", path)), true, `${path} kept`);
  assert.equal(readFileSync(join(dir, "profile", "Default", "Cookies"), "utf8"), "cookie-db");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "profile", "Default", "Preferences"), "utf8")), {
    extensions: { settings: { other: { location: 5 } }, pinned: ["x"], commands: {} },
    profile: { content_settings: { exceptions: { clipboard: { "https://example.com,*": { setting: 1 } } } } },
    keep: "https://example.com",
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "profile", "Default", "Secure Preferences"), "utf8")), { protection: { macs: { extensions: { settings: { other: "m" } } } } });
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), false, "one successful pass: the ids file goes");
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-dbs-cleared")), false);
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids.bp-tmp")), false);
  // The next start finds nothing to do and touches nothing.
  mkdirSync(join(dir, "profile", "Default", "Extension State"), { recursive: true });
  assert.equal(runStartScript(dir).status, 0);
  assert.equal(existsSync(join(dir, "profile", "Default", "Extension State")), true, "no ids file: the shared databases are left alone");
});

test("0.25.0 chromium-start.sh: one successful pass ends the cleanup (also with a leftover trace); the old store id counts only until then; a forged ids file removes nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-bw-gone2-"));
  const a = "a".repeat(32);
  const legacy = "nngceckbapebfimnlniiiahkandclblb";
  mkdirSync(join(dir, "profile", "Default", "Local Extension Settings", legacy), { recursive: true });
  // A file the cleanup does not know still names `a`: it does not make the cleanup repeat.
  mkdirSync(join(dir, "profile", "Default", "Service Worker", `x-${a}`), { recursive: true });
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), `${a}\n`);
  let result = runStartScript(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, "profile", "Default", "Local Extension Settings", legacy)), false, "the old store id's data goes too");
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), false, "done after the first successful pass");
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-cleaned")), true);
  // A leftover mention of the old store id later does not start it again.
  writeFileSync(join(dir, "profile", "Default", "Preferences"), JSON.stringify({ note: legacy }));
  mkdirSync(join(dir, "profile", "Default", "Extension State"), { recursive: true });
  assert.equal(runStartScript(dir).status, 0);
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), false);
  assert.equal(existsSync(join(dir, "profile", "Default", "Extension State")), true, "nothing removed again");
  // A forged ids file cannot point the removal elsewhere.
  mkdirSync(join(dir, "profile", "Default", "Local Extension Settings", "other"), { recursive: true });
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), "../../etc\n*\n");
  assert.equal(runStartScript(dir).status, 0);
  assert.equal(existsSync(join(dir, "profile", "Default", "Local Extension Settings", "other")), true);
  assert.equal(existsSync(join(dir, "profile", "Default", "Extension State")), true, "no valid id: nothing removed");
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), false, "and the forged file is dropped");
  // A profile that never had Bitwarden: nothing recorded, nothing removed, no marker.
  const clean = mkdtempSync(join(tmpdir(), "bp-bw-gone3-"));
  mkdirSync(join(clean, "profile", "Default", "Extension State"), { recursive: true });
  assert.equal(runStartScript(clean).status, 0);
  assert.equal(existsSync(join(clean, "profile", ".bp-bitwarden-ids")), false);
  assert.equal(existsSync(join(clean, "profile", ".bp-bitwarden-cleaned")), false);
  assert.equal(existsSync(join(clean, "profile", "Default", "Extension State")), true);
});

test("0.25.0 chromium-start.sh: without a working preference cleanup (no python3) the pass is repeated, at most 3 times", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-bw-gone4-"));
  // A PATH with the script's tools but no python3.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["sed", "grep", "sort", "rm", "mv", "find", "head", "cat", "wc", "echo"]) {
    const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((path) => existsSync(path));
    symlinkSync(found, join(bin, tool));
  }
  const a = "a".repeat(32);
  const start = () =>
    spawnSync("/bin/sh", ["-c", `sed -e "s|^PROFILE=.*|PROFILE=$T/profile|" -e "s|exec /usr/bin/chromium|exec echo|" "$0" | /bin/sh`, new URL("../signed-in/chromium-start.sh", import.meta.url).pathname], {
      env: { PATH: bin, BP_PROXY: "http://bp-si-0a1b2c3d-proxy:3128", T: dir },
      encoding: "utf8",
    });
  mkdirSync(join(dir, "profile", "Default", "Local Extension Settings", a), { recursive: true });
  writeFileSync(join(dir, "profile", ".bp-bitwarden-ids"), `${a}\n`);
  for (const pass of [1, 2]) {
    const result = start();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), true, `pass ${pass}: tried again next start`);
  }
  assert.equal(existsSync(join(dir, "profile", "Default", "Local Extension Settings", a)), false, "the data directories went on the first pass");
  assert.equal(start().status, 0);
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-ids")), false, "the third pass ends it");
  assert.equal(existsSync(join(dir, "profile", ".bp-bitwarden-passes")), false);
});

test("0.25.0: Bitwarden is gone from the image, the prompt, the card, the settings, the filters and the RPCs (only the migration remembers it)", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.equal(existsSync(new URL("../signed-in-bitwarden/", import.meta.url)), false);
  assert.equal(existsSync(new URL("../server-browser/bitwarden-lock.mjs", import.meta.url)), false);
  assert.ok(!JSON.parse(read("package.json")).files.some((entry) => /bitwarden/i.test(entry)));
  for (const path of ["shared/agent-prompt.ts", "client/card.tsx", "client/signed-in-settings.tsx", "shared/signed-in-rpc.ts", "shared/settings.ts", "index.server.ts", "server-browser/mcp-filter.mjs", "server-browser/cdp-filter.mjs", "server-browser/relay.mjs", "server-browser/relay-main.mjs", "server-browser/Dockerfile", "signed-in/policies.json", "signed-in/Dockerfile", "scripts/embed-server-browser.mjs"]) {
    const text = read(path).replace(/`bitwarden` and `bitwardenConsent` \(0\.23\.0 to 0\.24\.x\)[^\n]*/, "");
    assert.doesNotMatch(text, /bitwarden|vault|lockPending|securing|LOCK_FAILED/i, path);
  }
  assert.doesNotMatch(SIGNED_IN_SAFETY_PREAMBLE, /password manager|Bitwarden/i);
  assert.ok(!Object.keys(SIGNED_IN_FILES).some((name) => /bitwarden/i.test(name)));
  assert.equal(isLegacyBitwardenImageTag(LEGACY_BW_TAG), true);
  assert.equal(isLegacyBitwardenImageTag(NEKO_IMAGE), false);
  assert.equal(isLegacyBitwardenImageTag("browser-prompt-server-browser:x-bw2026"), false);
  // The settings keep a generic Restart browser (the unavailable text points the owner there).
  assert.match(read("client/signed-in-settings.tsx"), /control\(\{ action: "restart" \}\)/);
  assert.match(UNAVAILABLE_TEXT, /Restart browser in the plugin settings/);
});

test("0.25.0 daemon: Restart browser stops the stack gracefully (logins kept) and starts it again", async () => {
  const docker = fakeStackDocker();
  const { si } = makeSignedIn(docker);
  await si.viewerLink({ purpose: "login", portrait: false });
  const nekoRuns = () => docker.calls.filter((args) => args[0] === "run" && /-neko$/.test(value(args, "--name")[0])).length;
  const before = nekoRuns();
  await si.restart();
  assert.equal(nekoRuns(), before + 1);
  assert.ok(docker.calls.some((args) => args[0] === "stop" && args[1] === "-t"), "a graceful stop (cookies are written)");
  assert.ok(!docker.calls.some((args) => args[0] === "volume" && args[1] === "rm"), "the profile stays");
});

/** A signed-in daemon whose running neko has the Bitwarden image of a version before 0.25.0, held by a run. */
async function legacyHeldRig(relay = { viewers: 0, idleMs: 0, nekoUp: true, portrait: false, lockPending: true }) {
  const docker = fakeStackDocker();
  const state = { relay };
  const logs = [];
  const rig = makeSignedIn(docker, { relayStatus: async () => state.relay, log: (m) => logs.push(m) });
  await rig.si.viewerLink({ purpose: "login", portrait: false });
  docker.state.nekoImage = LEGACY_BW_TAG;
  docker.state.legacyTags.add(LEGACY_BW_TAG);
  docker.state.agents = [{ id: "c1c1c1c1", agent: "held-run" }];
  docker.calls.length = 0;
  const runs = (role) => docker.calls.filter((args) => args[0] === "run" && new RegExp(`-${role}$`).test(value(args, "--name")[0] ?? ""));
  return { ...rig, docker, state, logs, runs };
}

test("0.25.0 review: a held run on the old Bitwarden browser whose relay waits for the lock gets a full restart on the plain image, never a relay alone; its calls never reach the old browser", async () => {
  const { si, docker, runs, logs } = await legacyHeldRig();
  assert.equal(await si.legacyRelayCheck(), true);
  const calls = docker.calls.map((args) => args.join(" "));
  const agentGone = calls.findIndex((c) => c === "rm -f c1c1c1c1");
  const nekoGone = calls.findIndex((c) => /^stop -t 45 bp-si-[0-9a-f]{8}-neko$/.test(c));
  const firstRelay = calls.findIndex((c) => c.startsWith("run ") && / --name bp-si-[0-9a-f]{8}-relay /.test(c));
  assert.ok(agentGone >= 0, "the run's MCP container is removed (the run loses the browser)");
  assert.ok(nekoGone > agentGone, "then the old neko is stopped gracefully (logins kept, in-memory keys gone)");
  assert.ok(firstRelay > nekoGone, "a new relay only after the old browser is gone");
  assert.equal(runs("neko").length, 1, "neko started again");
  assert.equal(runs("neko")[0].at(-1), si.image, "on the plain image");
  assert.equal(docker.state.nekoImage, si.image);
  assert.ok(!docker.calls.some((args) => args[0] === "volume" && args[1] === "rm"), "the profile stays");
  assert.ok(logs.some((m) => /restarting the whole signed-in browser on the plain image/.test(m)));
  // A viewer is connected: nothing yet (the run stays paused by the old relay).
  const viewing = await legacyHeldRig({ viewers: 1, idleMs: 0, nekoUp: true, portrait: false, lockPending: true });
  assert.equal(await viewing.si.legacyRelayCheck(), false);
  assert.equal(viewing.runs("relay").length + viewing.runs("neko").length, 0);
  // The image cannot be read: treated as possibly Bitwarden (full restart, never a relay alone).
  const unknown = await legacyHeldRig();
  unknown.docker.state.inspectFails = true;
  await unknown.si.legacyRelayCheck();
  unknown.docker.state.inspectFails = false;
  const order = unknown.docker.calls.map((args) => args.join(" "));
  assert.ok(order.includes("rm -f c1c1c1c1"), "the run loses the browser");
  assert.ok(!order.some((c, i) => c.startsWith("run ") && / --name bp-si-[0-9a-f]{8}-relay /.test(c) && !order.slice(0, i).some((x) => /^stop -t 45 bp-si-[0-9a-f]{8}-neko$/.test(x))), "no relay before neko was stopped");
});

test("0.25.0 review: with a run on the old Bitwarden browser, no other path starts its relay alone (changed settings, a lost relay, a new viewer key)", async () => {
  // A changed address or port (the relay's config tag differs): the old relay and neko are kept.
  const changed = await legacyHeldRig({ viewers: 0, idleMs: 0, nekoUp: true, portrait: false });
  changed.docker.state.relayTag = "something-else";
  await changed.si.ensureStarted();
  assert.equal(changed.runs("relay").length, 0, "no relay alone under a held Bitwarden browser");
  assert.equal(changed.docker.state.nekoImage, LEGACY_BW_TAG, "and the run keeps its browser");
  await changed.si.idleCheck();
  assert.equal(changed.runs("relay").length, 0);
  // The relay is gone: the whole stack starts again on the plain image (the run loses the browser).
  const lost = await legacyHeldRig();
  lost.docker.state.containers.set([...lost.docker.state.containers.keys()].find((name) => name.endsWith("-relay")), "exited");
  await lost.si.ensureStarted();
  assert.ok(lost.docker.calls.some((args) => args.join(" ") === "rm -f c1c1c1c1"));
  assert.equal(lost.runs("neko").length, 1);
  assert.equal(lost.docker.state.nekoImage, lost.si.image);
  // A new viewer key: the same (never a relay alone).
  const rotated = await legacyHeldRig();
  await rotated.si.rotateKey();
  assert.ok(rotated.docker.calls.some((args) => args.join(" ") === "rm -f c1c1c1c1"));
  assert.equal(rotated.runs("neko").length, 1);
  assert.equal(rotated.docker.state.nekoImage, rotated.si.image);
});

test("0.25.0 review: one failing cleanup step does not stop the others, and the retries stop after 5 rounds until the next daemon start", async () => {
  const docker = fakeStackDocker();
  docker.state.legacyTags = new Set([LEGACY_BW_TAG]);
  const logs = [];
  const { si, dir } = makeSignedIn(docker, { log: (m) => logs.push(m) });
  // The key path is a directory: not removable as a file.
  mkdirSync(join(dir, "bitwarden-key.pem"));
  writeFileSync(join(dir, "bitwarden-key.pem.ab12.tmp"), "partial");
  mkdirSync(join(dir, "build", "neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654"), { recursive: true });
  await si.removeLegacyBitwarden();
  assert.equal(existsSync(join(dir, "bitwarden-key.pem.ab12.tmp")), false, "the temp file still goes");
  assert.equal(existsSync(join(dir, "build", "neko3.2.0-0123456789ab-bw2026.11.0-fedcba987654")), false, "the build context still goes");
  assert.deepEqual(docker.state.removed, [LEGACY_BW_TAG], "the image is still removed");
  assert.equal(existsSync(join(dir, "bitwarden-key.pem")), true, "a directory is not ours to remove");
  for (let i = 0; i < 10; i++) await si.removeLegacyBitwarden();
  assert.equal(docker.calls.filter((args) => args[0] === "image" && args[1] === "ls").length, 5, "five rounds, then it waits for the next daemon start");
  assert.ok(logs.some((m) => /could not be removed after 5 tries/.test(m)));
});

test("0.25.0 review: DevTools filter takes away a target or frame of the run that turns into an extension page after it was attached", () => {
  const filter = createTargetFilter();
  const attached = (info, sessionId) => ({ method: "Target.attachedToTarget", ...(sessionId ? { sessionId } : {}), params: { sessionId: `S-${info.targetId}`, targetInfo: info, waitingForDebugger: false } });
  filter.fromClient({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser(attached({ targetId: "P", type: "page", url: "about:blank" }));
  filter.fromBrowser({ id: 1, result: { targetId: "P" } });
  filter.fromBrowser(attached({ targetId: "F", type: "iframe", url: "about:blank" }, "S-P"));
  // The frame target commits to an extension page on its own session: taken away, nothing about it delivered.
  const frame = filter.fromBrowser({ sessionId: "S-F", method: "Page.frameNavigated", params: { frame: { id: "F", url: "chrome-extension://dyn/overlay/menu.html" } } });
  assert.deepEqual(frame.deliver.map((m) => m.method), ["Target.detachedFromTarget", "Target.targetDestroyed"]);
  assert.deepEqual(frame.toBrowser.map((m) => m.method), ["Target.detachFromTarget"]);
  assert.ok(filter.fromClient({ id: 2, sessionId: "S-F", method: "Runtime.evaluate", params: {} }).reply, "its session is gone for the run");
  // A child frame of the page that navigates to one: not delivered, the page stays.
  assert.equal(filter.fromBrowser({ sessionId: "S-P", method: "Page.frameNavigated", params: { frame: { id: "child", parentId: "P", url: "chrome-extension://x/a.html" } } }).deliver.length, 0);
  assert.equal(filter.isVisible("P"), true);
  // The page itself becomes an extension page (target info): taken away.
  const page = filter.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "P", type: "page", url: "chrome-extension://x/popup.html" } } });
  assert.deepEqual(page.deliver.map((m) => m.method), ["Target.detachedFromTarget", "Target.targetDestroyed"]);
  assert.equal(filter.isVisible("P"), false);
  assert.ok(filter.fromClient({ id: 3, sessionId: "S-P", method: "Runtime.evaluate", params: {} }).reply);
  // An ordinary navigation is delivered as before.
  filter.fromClient({ id: 4, method: "Target.createTarget", params: { url: "about:blank" } });
  filter.fromBrowser(attached({ targetId: "Q", type: "page", url: "about:blank" }));
  filter.fromBrowser({ id: 4, result: { targetId: "Q" } });
  assert.equal(filter.fromBrowser({ sessionId: "S-Q", method: "Page.frameNavigated", params: { frame: { id: "Q", url: "https://example.com/" } } }).deliver.length, 1);
});
