// Smoke test of the signed-in Server browser on this host, with the plugin's own code. Developer
// tool, not part of the plugin: it builds missing images WITHOUT the settings' two-press consent
// (that bypass exists only here), binds only 127.0.0.1 (never the Tailscale address), uses its own
// state directory and plugin instance, and removes everything it started except the images.
//
//   SMOKE_PLAYWRIGHT_CORE=/path/to/dir-with/node_modules/playwright-core \
//   SMOKE_CHROMIUM=/path/to/chrome \
//   node --experimental-strip-types --no-warnings scripts/smoke-signed-in.mjs
//
// The Safari checks run WebKit in the Playwright image (SMOKE_WEBKIT_IMAGE, default
// mcr.microsoft.com/playwright:v1.65.1-noble; playwright-core in SMOKE_PLAYWRIGHT_CORE must be the
// same version) with a remote Playwright server published on 127.0.0.1:SMOKE_WEBKIT_PORT. Skip them
// with SMOKE_WEBKIT=0.
//
// Page contents are read and prepared by a separate DevTools helper container (the harness), never
// through the agent's MCP. Checks: images (build when missing), the stack starts; the agent's
// Playwright MCP lists only the signed-in tools (no evaluate, console or network) and never sees
// the owner's tabs; it opens https://example.com; blocked hosts and Chromium's internal pages
// (chrome://, view-source:, about:) are refused from inside; a headless phone-emulated viewer logs
// in through the key flow (cookie with a random name, scoped to a random path), takes control (the
// agent's tool calls are paused meanwhile), taps and types into the agent's page, and releases it;
// the same with WebKit as an iPad, an iPhone and desktop Safari, pressing every neko control their
// layout shows, without one refused request or "Blocked" toast;
// one run at a time; a cookie survives a neko restart; the relay refuses /metrics, admin APIs,
// foreign Host and foreign-Origin WebSockets; no STUN servers; the hardening as Docker reports it;
// and the cleanup.
//
// Bitwarden (on unless SMOKE_BITWARDEN=0; every check above then runs with it installed): the pinned
// release is downloaded (the consent bypass, again only here) and built into the image; the pin,
// read-only files, policies (only extension, store blocked, Chromium's password manager off) and the
// command line; it loads and its content script is on https pages and intercepts
// navigator.credentials (webauthn.io); the agent never sees, attaches to or opens any extension
// target or chrome-extension:// page (through its MCP and through the same DevTools filter used
// directly); a real Bitwarden frame inside the agent's tab stays unreadable and unclickable for it;
// the lock shortcut reaches Chromium as a command (the page never sees it); the relay keeps the run
// paused until the vault is locked, also after a takeover from WebKit (Safari's engine, in a
// container on the stack's outward network).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.SMOKE_PORT ?? "15301");
const state = mkdtempSync(join(tmpdir(), "bp-smoke-signed-in-"));
process.env.XDG_STATE_HOME = state;
const { createServerBrowser } = await import("../server/server-browser.ts");
const { createSignedIn } = await import("../server/signed-in.ts");
const instanceId = `smoke-${Math.random().toString(16).slice(2, 10)}`;
const sb = createServerBrowser({ instanceId, runtimeRoot: join(state, "rt"), buildRoot: join(state, "build") });
const BITWARDEN_ON = process.env.SMOKE_BITWARDEN !== "0";
const { BITWARDEN, bitwardenLockArgs } = await import("../shared/signed-in.ts");
let locks = 0;
const si = createSignedIn({
  serverBrowser: sb,
  bindHost: async () => "127.0.0.1",
  config: async () => ({ port: PORT, httpsBaseUrl: "", bitwarden: BITWARDEN_ON }),
  keysFile: join(state, "keys.json"),
  buildRoot: join(state, "build"),
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail ?? "") });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? ` (${detail})` : ""}`);
};
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal MCP client over the plugin's launcher (the MCP server config the agent would get). */
async function mcpClient(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...(server.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  child.stderr.resume();
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bp-smoke", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return {
    rpc,
    async call(name, args) {
      const message = await rpc("tools/call", { name, arguments: args });
      const text = (message.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { error: !!message.error || !!message.result?.isError, text: message.error ? JSON.stringify(message.error) : text };
    },
    close: () => {
      child.stdin.end();
      return Promise.race([exited, sleep(15_000).then(() => child.kill("SIGTERM"))]);
    },
  };
}

function http(method, path, headers = {}, body) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", (error) => resolve({ status: 0, body: error.message }));
    if (body) req.write(body);
    req.end();
  });
}
function upgrade(headers, path) {
  return new Promise((resolve) => {
    const socket = connect(PORT, "127.0.0.1", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
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
    socket.on("error", (error) => resolve(error.message));
    setTimeout(() => resolve(data.split("\r\n")[0] || "timeout"), 8000).unref();
  });
}

const ORIGIN = `http://127.0.0.1:${PORT}`;
let browser = null;
// The daemon's lock check (startIdleChecks runs it in the plugin): presses Bitwarden's Lock when the relay asks.
const lockTimer = setInterval(() => void si.lockCheck().then((done) => done && locks++), 1000);
let webkitBrowser = null;
let webkitContainer = null;
const WEBKIT_PORT = Number(process.env.SMOKE_WEBKIT_PORT ?? String(PORT + 90));
const WEBKIT_IMAGE = process.env.SMOKE_WEBKIT_IMAGE ?? "mcr.microsoft.com/playwright:v1.65.1-noble";
try {
  // 1. Images (the consent bypass: only in this script).
  let status = await si.status({ build: true });
  while (status.state === "building") {
    await sleep(5000);
    status = await si.status();
  }
  check("images ready", status.state === "ready" || status.state === "running", `${status.serverImage}, ${status.image}`);
  if (BITWARDEN_ON) {
    // The consent bypass for Bitwarden's download: only in this script.
    const started = Date.now();
    const answer = await si.bitwarden("download");
    status = await si.status();
    while (status.bitwarden.state === "building") {
      await sleep(3000);
      status = await si.status();
    }
    check("Bitwarden: pinned release downloaded, verified and built into the image", answer.ok && status.bitwarden.state === "ready", `${si.bitwardenImage}, ${Date.now() - started} ms${status.bitwarden.detail ? `, ${status.bitwarden.detail}` : ""}`);
  }

  // 2. Start.
  const started = Date.now();
  const link = await si.viewerLink({ purpose: "takeover", portrait: true });
  check("stack started through a viewer link", link.ok, `${Date.now() - started} ms`);
  check("the link carries the ticket only in its fragment", link.ok && new URL(link.url).search === "" && /#t=v1\./.test(link.url), link.ok ? link.url.replace(/#t=.*/, "#t=…") : "");
  const neko = docker("ps", "--filter", `label=browser-prompt.instance=${await sb.instance()}`, "--filter", "label=browser-prompt.signed-in=neko", "--format", "{{.Names}}");
  const relayName = neko.replace(/-neko$/, "-relay");
  const proxyName = neko.replace(/-neko$/, "-proxy");

  // 3. Hardening as Docker reports it.
  const inspect = (name, format) => docker("inspect", "--format", format, name);
  check("neko: read-only root", inspect(neko, "{{.HostConfig.ReadonlyRootfs}}") === "true");
  check("neko: capabilities", inspect(neko, "{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}}") === "[ALL] [CAP_CHOWN CAP_SETGID CAP_SETUID CAP_SYS_CHROOT]", inspect(neko, "{{.HostConfig.CapAdd}}"));
  check("neko: no-new-privileges and a seccomp profile", /no-new-privileges/.test(inspect(neko, "{{.HostConfig.SecurityOpt}}")) && /seccomp=/.test(inspect(neko, "{{.HostConfig.SecurityOpt}}")));
  check("neko: only the profile volume", inspect(neko, "{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}").trim() === "volume:/home/neko/.config/chromium");
  check("neko: internal network only, no ports", inspect(neko, "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}{{.HostConfig.PortBindings}}").endsWith("-net map[]"));
  const ports = docker("port", relayName);
  check("relay: published only on 127.0.0.1", ports.split("\n").every((line) => / -> 127\.0\.0\.1:\d+$/.test(line)), ports.replace(/\n/g, "; "));
  const chromeArgs = docker("exec", neko, "sh", "-c", 'tr "\\0" "\\n" < /proc/$(pgrep -o -f "^/usr/lib/chromium/chromium --show")/cmdline');
  check("Chromium: proxy for everything, DevTools on loopback, sandbox on", /--proxy-bypass-list=<-loopback>/.test(chromeArgs) && /--remote-debugging-address=127\.0\.0\.1/.test(chromeArgs) && !/--no-sandbox/.test(chromeArgs));
  check("neko: no direct route out", docker("exec", neko, "sh", "-c", "curl -s -m4 -o /dev/null -w '%{http_code}' https://example.com || true") === "000");
  const nekoEnv = inspect(neko, "{{range .Config.Env}}{{println .}}{{end}}");
  check("neko: no STUN/TURN servers", /^NEKO_WEBRTC_ICESERVERS_FRONTEND=\[\]$/m.test(nekoEnv) && /^NEKO_WEBRTC_ICESERVERS_BACKEND=\[\]$/m.test(nekoEnv));
  const relayEnv = inspect(relayName, "{{range .Config.Env}}{{println .}}{{end}}");
  check("relay and proxy: maximum lifetime set", /^BP_MAX_LIFETIME_S=604800$/m.test(relayEnv) && /^BP_MAX_LIFETIME_S=604800$/m.test(inspect(proxyName, "{{range .Config.Env}}{{println .}}{{end}}")));
  check("neko: metrics off", docker("exec", neko, "sh", "-c", "curl -s -m4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/metrics || true") === "404");
  const proxyIp = inspect(proxyName, `{{(index .NetworkSettings.Networks "${neko.replace(/-neko$/, "-net")}").IPAddress}}`);
  for (const target of ["http://100.96.145.38:5299/", "http://paseo-box.tail60821.ts.net/", "http://192.168.1.1/", "http://10.0.0.1/", "http://172.17.0.1/", "http://169.254.169.254/", "http://127.0.0.1:8080/", "http://[fd7a:115c:a1e0::1]/"]) {
    const code = docker("exec", neko, "sh", "-c", `curl -s -m8 -o /dev/null -w '%{http_code}' --proxy http://${proxyIp}:3128 '${target}' || true`);
    check(`proxy refuses ${target}`, code === "403", code);
  }

  // A helper with its own DevTools connection, in neko's network namespace: the test harness reads
  // and prepares pages with it (never through the agent's MCP, which has no evaluate tool here).
  const helper = (code) => {
    const script = `import { chromium } from "/opt/browser-prompt/node_modules/playwright-core/index.mjs";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const out = await (async () => { ${code} })();
process.stdout.write(JSON.stringify(out ?? null));
process.exit(0);`;
    const out = execFileSync(
      "docker",
      ["run", "--rm", "-i", "--init", "--network", `container:${neko}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp", "--user", "pwuser", "--entrypoint", "node", status.serverImage, "--input-type=module", "-"],
      { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 150_000 },
    );
    return JSON.parse(out || "null");
  };
  const pageByMarker = (marker) => `const page = context.pages().find((p) => p.url().includes(${JSON.stringify(marker)}));`;

  // The owner's tab, open before the run attaches.
  const ownerUrl = helper(`const p = await context.newPage(); await p.goto("https://example.org/?bp-owner=1"); return p.url();`);
  check("owner's tab open before the run", /example\.org\/\?bp-owner=1/.test(ownerUrl ?? ""), ownerUrl);

  // 4. The agent's MCP over CDP.
  const mcp = await si.mcpServer("smoke-agent-1");
  check("MCP server for a run", mcp && "server" in mcp, mcp && "session" in mcp ? mcp.session : JSON.stringify(mcp));
  const agent = await mcpClient(mcp.server);
  // The MCP connects to Chromium only on its first browser tool call: a tab the owner opens now
  // appears while no client is connected.
  helper(`const p = await context.newPage(); await p.goto("https://example.org/?bp-owner=2"); return 1;`);
  const tools = (await agent.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check(
    "MCP lists only the signed-in tools (no evaluate, console or network tools)",
    tools.includes("browser_navigate") && !["browser_evaluate", "browser_console_messages", "browser_network_requests", "browser_run_code_unsafe", "browser_file_upload"].some((t) => tools.includes(t)),
    `${tools.length} tools`,
  );
  for (const tool of ["browser_evaluate", "browser_console_messages", "browser_network_requests", "browser_run_code_unsafe"]) {
    check(`signed-in run refused ${tool}`, /turned off/.test((await agent.call(tool, { function: "() => document.cookie", code: "1" })).text));
  }
  let r = await agent.call("browser_tabs", { action: "list" });
  check("the owner's tabs are hidden from the run (one open before it attached, one opened while no client was connected)", !/example\.org|bp-owner/.test(r.text), r.text.split("\n").filter((l) => /^- \d+:/.test(l)).join(" ").slice(0, 120) || "no tabs");
  r = await agent.call("browser_tabs", { action: "select", index: 0 });
  r = await agent.call("browser_snapshot", {});
  check("the run cannot reach the owner's tab by index", !/example\.org|bp-owner/.test(r.text));
  r = await agent.call("browser_tabs", { action: "new", url: "https://example.com" });
  check("agent opens https://example.com over CDP", !r.error && /Example Domain/.test(r.text));
  for (const target of ["http://100.96.145.38:5299/", "http://paseo-box.tail60821.ts.net/", "http://192.168.1.1/", "http://127.0.0.1:9222/json/version", "http://127.0.0.1:8080/api/whoami"]) {
    await agent.call("browser_tabs", { action: "new" });
    const nav = await agent.call("browser_navigate", { url: target });
    const snap = (await agent.call("browser_snapshot", {})).text;
    const leaked = /webSocketDebuggerUrl|"Browser"|is_admin|neko/i.test(snap);
    check(`agent blocked from ${target}`, (nav.error || /Blocked by the browser-prompt|403/.test(nav.text + snap)) && !leaked, nav.error ? nav.text.split("\n").find((l) => /Error|ERR_/.test(l))?.slice(0, 90) : "403 page");
    await agent.call("browser_tabs", { action: "close" });
  }
  for (const target of [
    "chrome://history",
    "chrome://settings",
    "chrome://settings/content/all",
    "chrome://version",
    "view-source:https://example.com",
    "about:version",
    "chrome-untrusted://print/",
    "devtools://devtools/bundled/inspector.html",
    "data:text/html,<h1>Version</h1><p>data page shown</p>",
    "javascript:document.title='js-ran'",
  ]) {
    await agent.call("browser_tabs", { action: "new" });
    const nav = await agent.call("browser_navigate", { url: target });
    const snap = (await agent.call("browser_snapshot", {})).text;
    const blocked = /ERR_BLOCKED_BY_ADMINISTRATOR/.test(nav.text) || /chrome-error:\/\//.test(snap);
    const shown = /Example Domain|History|Settings|Version|Chromium|data page shown|js-ran|- (heading|paragraph|link|row|cell) /.test(snap.split("### Snapshot")[1] ?? "") || /js-ran/.test(snap);
    check(`agent refused ${target}`, blocked || !shown, blocked ? "ERR_BLOCKED_BY_ADMINISTRATOR" : "empty page, nothing shown");
    await agent.call("browser_tabs", { action: "close" });
  }
  r = await agent.call("browser_navigate", { url: "https://example.com" });
  check("normal https still works after the internal-page checks", !r.error && /Example Domain/.test(r.text));
  if (BITWARDEN_ON) {
    await bitwardenChecks({ agent, neko, helper, pageByMarker }).catch((error) =>
      check("Bitwarden checks", false, error instanceof Error ? `${error.message.split("\n")[0]} ${String(error.stderr ?? "").slice(-300)}` : String(error)),
    );
  }
  r = await agent.call("browser_tabs", { action: "new", url: "https://example.com/?bp-smoke=takeover" });
  helper(`${pageByMarker("bp-smoke=takeover")} await page.bringToFront(); await page.evaluate(() => { document.body.innerHTML = '<input id=user autocomplete=off style="position:fixed;left:0;top:0;width:100vw;height:45vh;font-size:40px"><button id=btn style="position:fixed;left:0;top:55vh;width:100vw;height:45vh;font-size:40px" onclick="window.clicks=(window.clicks||0)+1">tap</button>'; }); return 1;`);
  const busy = await si.prepare({ sourceId: "smoke", cardId: "card" });
  check("one run at a time: a second run is busy", !busy.ok && busy.state === "busy", JSON.stringify(busy));

  // 5. The phone viewer: key flow, control (the run pauses), tap and type, then close the viewer
  // without releasing: the relay resets control and the run goes on.
  const require = createRequire(join(process.env.SMOKE_PLAYWRIGHT_CORE ?? "", "/"));
  const { chromium } = require("playwright-core");
  browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await phone.newPage();
  const refused = [];
  page.on("response", (res) => res.status() >= 400 && refused.push(`${res.status()} ${new URL(res.url()).pathname}`));
  await page.goto(link.url);
  await page.waitForURL(/\/s-[0-9a-f]{32}\/$/, { timeout: 20_000 });
  const prefix = new URL(page.url()).pathname.replace(/\/$/, "");
  const viewerCookie = (await phone.cookies()).find((c) => /^bp_viewer_[0-9a-f]{16}$/.test(c.name));
  check(
    "viewer: ticket traded for a session cookie with a random name, scoped to a random path, HttpOnly, Strict, 2 h",
    viewerCookie && viewerCookie.httpOnly && viewerCookie.sameSite === "Strict" && viewerCookie.path === `${prefix}/` && viewerCookie.expires - Date.now() / 1000 <= 7200,
    viewerCookie ? `${viewerCookie.name.slice(0, 10)}…, path /s-…/` : "none",
  );
  const cookie = `${viewerCookie.name}=${viewerCookie.value}`;
  check("viewer: the fragment is gone from the address", !page.url().includes("#"));
  await page.waitForSelector("video", { timeout: 20_000 });
  await page.waitForTimeout(4000);
  const video = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { w: v.videoWidth, h: v.videoHeight, playing: !v.paused };
  });
  check("viewer: live portrait stream on a phone", video.playing && video.w === 720 && video.h === 1280, `${video.w}x${video.h}`);
  await page.locator('button[aria-label="Request Controls"], button[aria-label="controls.request"]').first().click({ force: true });
  await page.waitForTimeout(2500);
  r = await agent.call("browser_snapshot", {});
  check("takeover: the agent's tool calls pause while the owner holds control", r.error && /owner has taken over/.test(r.text), r.text.slice(0, 70));
  const box = await page.locator("video").first().boundingBox();
  const s = Math.min(box.width / video.w, box.height / video.h);
  const at = (fx, fy) => ({ x: box.x + (box.width - video.w * s) / 2 + video.w * s * fx, y: box.y + (box.height - video.h * s) / 2 + video.h * s * fy });
  for (const [fx, fy] of [
    [0.5, 0.85],
    [0.5, 0.85],
    [0.5, 0.3],
  ]) {
    const p = at(fx, fy);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(600);
  }
  const keyboard = page.locator("[data-testid=keyboard-toggle]");
  check("viewer: keyboard toggle shown on a phone", (await keyboard.count()) > 0);
  if (await keyboard.count()) await keyboard.first().tap().catch(() => {});
  await page.keyboard.type("alice", { delay: 60 });
  await page.waitForTimeout(1000);
  const seen = helper(`${pageByMarker("bp-smoke=takeover")} return page.evaluate(() => ({ user: document.getElementById("user").value, clicks: window.clicks || 0 }));`);
  check("takeover: the phone's taps and typing reach the agent's page", seen?.user === "alice" && seen?.clicks === 2, JSON.stringify(seen));
  check("viewer: no refused requests from the neko client", refused.length === 0, refused.join(", "));
  await page.close();
  // The relay resets control (and with Bitwarden, the daemon locks the vault first): give it a few seconds.
  await sleep(BITWARDEN_ON ? 6000 : 3500);
  r = await agent.call("browser_snapshot", {});
  check("closing the viewer without releasing control resets it: the run goes on", !r.error, r.error ? r.text.slice(0, 80) : "");

  // 5b. Safari: the same key flow with WebKit (iPad as iPadOS Safari reports itself, iPhone, desktop
  // Safari). WebKit runs in the Playwright image on the stack's outward network with a forward of
  // 127.0.0.1:PORT and :PORT+1 to the relay, so it sees the same origin and ICE-TCP address as a
  // real client. Every neko button a tablet or desktop layout shows (room locks, the settings tab)
  // is pressed: none may end in a refused request or the relay's "Blocked" toast.
  if (process.env.SMOKE_WEBKIT !== "0") {
    const relayAddr = relayName;
    const forward = `const net=require("net");for(const [lp,rp] of [[${PORT},8080],[${PORT + 1},${PORT + 1}]])net.createServer(c=>{const u=net.connect(rp,${JSON.stringify(relayAddr)});c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());}).listen(lp,"127.0.0.1");`;
    webkitContainer = `bp-smoke-webkit-${Math.random().toString(16).slice(2, 10)}`;
    docker(
      "run", "-d", "--rm", "--init", "--name", webkitContainer, "--network", neko.replace(/-neko$/, "-pub"),
      "--publish", `127.0.0.1:${WEBKIT_PORT}:3000`, "--mount", `type=bind,source=${join(process.env.SMOKE_PLAYWRIGHT_CORE ?? "", "node_modules", "playwright-core")},target=/pw/playwright-core,readonly`,
      "--user", "pwuser", "--security-opt", "no-new-privileges", "--env", `BP_FORWARD=${forward}`, "--entrypoint", "sh", WEBKIT_IMAGE,
      "-c", 'node -e "$BP_FORWARD" & exec node /pw/playwright-core/cli.js run-server --port 3000 --host 0.0.0.0',
    );
    const { webkit, devices } = require("playwright-core");
    for (let i = 0; i < 60 && !webkitBrowser; i++) webkitBrowser = await webkit.connect(`ws://127.0.0.1:${WEBKIT_PORT}/`).catch(() => sleep(500).then(() => null));
    check("WebKit: browser up in the Playwright image", !!webkitBrowser, WEBKIT_IMAGE);
    const ipadSafariUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    for (const [name, descriptor, phoneLink] of [
      ["iPad (iPadOS Safari, desktop UA)", { ...devices["iPad Pro 11"], userAgent: ipadSafariUa }, false],
      ["iPhone 15", devices["iPhone 15"], true],
      ["desktop Safari", devices["Desktop Safari"], false],
    ]) {
      if (!webkitBrowser) break;
      helper(`${pageByMarker("bp-smoke=takeover")} await page.bringToFront(); await page.evaluate(() => { window.clicks = 0; document.getElementById("user").value = ""; }); return 1;`);
      const wlink = await si.viewerLink({ purpose: "takeover", portrait: phoneLink });
      const ctx = await webkitBrowser.newContext({ ...descriptor });
      const wpage = await ctx.newPage();
      const wrefused = [];
      wpage.on("response", (res) => res.status() >= 400 && wrefused.push(`${res.request().method()} ${res.status()} ${new URL(res.url()).pathname.replace(/^\/s-[0-9a-f]{32}/, "")}`));
      const blockedToasts = () => wpage.evaluate((text) => [...document.querySelectorAll("[data-sonner-toast]")].filter((t) => t.textContent.includes(text)).length, "Blocked by the browser-prompt relay.");
      try {
        await wpage.goto(wlink.url);
        await wpage.waitForURL(/\/s-[0-9a-f]{32}\/$/, { timeout: 20_000 });
        await wpage.waitForSelector("video", { timeout: 20_000 });
        await wpage.waitForFunction(() => { const v = document.querySelector("video"); return v && v.videoWidth > 0 && !v.paused; }, null, { timeout: 20_000 }).catch(() => {});
        const wvideo = await wpage.evaluate(() => { const v = document.querySelector("video"); return { w: v.videoWidth, h: v.videoHeight, playing: !v.paused }; });
        check(`WebKit ${name}: live stream`, wvideo.playing && wvideo.w > 0 && (!phoneLink || (wvideo.w === 720 && wvideo.h === 1280)), `${wvideo.w}x${wvideo.h}${phoneLink ? ", portrait" : ""}`);
        // Every admin-looking control neko shows in this layout.
        for (const selector of ["[data-testid=lock-control]", "[data-testid=lock-login]", "[data-testid=side-toggle]", "[role=tab]:nth-of-type(2)"]) {
          const control = wpage.locator(selector).first();
          if (await control.count()) await control.click({ force: true, timeout: 3000 }).catch(() => {});
          await wpage.waitForTimeout(800);
        }
        for (const box of await wpage.locator("[role=tabpanel] input[type=checkbox]").all()) await box.click({ force: true, timeout: 2000 }).catch(() => {});
        await wpage.waitForTimeout(800);
        const sideToggle = wpage.locator("[data-testid=side-toggle]").first();
        if (await sideToggle.count()) await sideToggle.click({ force: true }).catch(() => {});
        // Take control with the button this layout shows.
        const request = wpage.locator('[data-testid=control-request]:visible, button[aria-label="Request Controls"]:visible').first();
        await request.click({ force: true, timeout: 5000 });
        await wpage.waitForTimeout(2500);
        r = await agent.call("browser_snapshot", {});
        check(`WebKit ${name}: Request controls takes control (the run pauses)`, r.error && /owner has taken over/.test(r.text), r.text.slice(0, 70));
        const vbox = await wpage.locator("video").first().boundingBox();
        const sc = Math.min(vbox.width / wvideo.w, vbox.height / wvideo.h);
        const wat = (fx, fy) => ({ x: vbox.x + (vbox.width - wvideo.w * sc) / 2 + wvideo.w * sc * fx, y: vbox.y + (vbox.height - wvideo.h * sc) / 2 + wvideo.h * sc * fy });
        const touch = !!descriptor.hasTouch;
        for (const [fx, fy] of [[0.5, 0.85], [0.5, 0.85], [0.5, 0.3]]) {
          const p = wat(fx, fy);
          if (touch) await wpage.touchscreen.tap(p.x, p.y);
          else await wpage.mouse.click(p.x, p.y);
          await wpage.waitForTimeout(600);
        }
        if (touch) {
          const wkeyboard = wpage.locator("[data-testid=keyboard-toggle]");
          check(`WebKit ${name}: keyboard toggle shown while in control`, (await wkeyboard.count()) > 0);
          if (await wkeyboard.count()) await wkeyboard.first().tap().catch(() => {});
          await wpage.waitForTimeout(300);
        }
        await wpage.keyboard.type("safari", { delay: 60 });
        await wpage.waitForTimeout(1000);
        const wseen = helper(`${pageByMarker("bp-smoke=takeover")} return page.evaluate(() => ({ user: document.getElementById("user").value, clicks: window.clicks || 0 }));`);
        check(`WebKit ${name}: taps and typing reach the agent's page`, wseen?.user === "safari" && wseen?.clicks === 2, JSON.stringify(wseen));
        check(`WebKit ${name}: no refused requests and no "Blocked" toast`, wrefused.length === 0 && (await blockedToasts()) === 0, wrefused.join(", "));
        if (BITWARDEN_ON) {
          // Release control with the viewer's own button: the vault is locked before the run goes on.
          const before = locks;
          const release = wpage.locator('[data-testid=control-release]:visible, button[aria-label="Release Controls"]:visible, [data-testid=control-request]:visible, button[aria-label="Request Controls"]:visible').first();
          const pressed = await release.click({ force: true, timeout: 5000 }).then(() => true, (e) => e.message.split("\n")[0]);
          let resumed = null;
          for (let i = 0; i < 12 && !resumed; i++) {
            await sleep(1000);
            const snap = await agent.call("browser_snapshot", {});
            if (!snap.error) resumed = { at: i + 1, locked: locks > before };
          }
          check(`WebKit ${name}: releasing control locks Bitwarden, then the run goes on`, pressed === true && resumed?.locked === true, JSON.stringify({ pressed, resumed, locks: locks - before }));
        }
      } catch (error) {
        check(`WebKit ${name}: viewer`, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
      } finally {
        await ctx.close().catch(() => {});
      }
      const locksBeforeClose = locks;
      await sleep(BITWARDEN_ON ? 6000 : 3500);
      r = await agent.call("browser_snapshot", {});
      check(`WebKit ${name}: closing the viewer resets control`, !r.error, r.error ? r.text.slice(0, 80) : "");
      if (BITWARDEN_ON) check(`WebKit ${name}: closing the viewer locks Bitwarden too`, locks > locksBeforeClose, `${locks - locksBeforeClose} lock(s)`);
    }
    // Off the stack's network before the stack stops (a stop removes it).
    await webkitBrowser?.close().catch(() => {});
    webkitBrowser = null;
    docker("rm", "-f", webkitContainer);
    webkitContainer = null;
  }

  // 6. Relay refusals with a valid session (a new viewer session, the old page is closed).
  const link2 = await si.viewerLink({ purpose: "login", portrait: false });
  const ticket2 = decodeURIComponent(new URL(link2.url).hash.slice(3).split("&")[0]);
  const session2 = await http("POST", "/bp/session", { Origin: ORIGIN, "Content-Type": "application/json" }, JSON.stringify({ ticket: ticket2 }));
  const cookie2 = String(session2.headers["set-cookie"]).split(";")[0];
  check("relay: the session cookie does nothing outside its path", (await http("GET", "/api/whoami", { Cookie: cookie2 })).status === 401);
  for (const [method, path] of [
    ["GET", "/metrics"],
    ["GET", "/health"],
    ["GET", "/api/members"],
    ["GET", "/api/sessions"],
    ["POST", "/api/login"],
    ["POST", "/api/room/broadcast/start"],
    ["POST", "/api/room/settings"],
    ["GET", "/api/filetransfer"],
  ]) {
    const res = await http(method, `${prefix}${path}`, { Cookie: cookie2, Origin: ORIGIN });
    check(`relay refuses ${method} ${path}`, res.status === 403 || res.status === 401, res.status);
  }
  const prefix2 = JSON.parse(session2.body).path.replace(/\/$/, "");
  check("relay: foreign Host refused", (await http("GET", `${prefix2}/`, { Host: "evil.example", Cookie: cookie2 })).status === 421);
  check("relay: WebSocket with a foreign Origin refused", / 403 /.test(await upgrade({ Cookie: cookie2, Origin: "http://evil.example" }, `${prefix2}/api/ws`)));
  check("relay: WebSocket without a session refused", / 401 /.test(await upgrade({ Origin: ORIGIN }, `${prefix2}/api/ws`)));
  check("relay: WebSocket outside the prefix refused", / 403 /.test(await upgrade({ Cookie: cookie2, Origin: ORIGIN }, "/api/ws")));
  check("relay: WebSocket with own Origin and session accepted", / 101 /.test(await upgrade({ Cookie: cookie2, Origin: ORIGIN }, `${prefix2}/api/ws`)));
  check("relay: a used ticket is refused", (await http("POST", "/bp/session", { Origin: ORIGIN, "Content-Type": "application/json" }, JSON.stringify({ ticket: ticket2 }))).status === 401);
  const badStarted = Date.now();
  let bad = 0;
  for (let i = 0; i < 25; i++) bad += (await http("POST", "/bp/session", { Origin: ORIGIN, "Content-Type": "application/json" }, JSON.stringify({ ticket: `v1.${Math.floor(Date.now() / 1000) + 60}.aaaaaaaaaaaaaaaa.login.${"A".repeat(43)}` }))).status === 401 ? 1 : 0;
  check("relay: bad tickets are slowed down (500 ms each), never a lockout", bad === 25 && Date.now() - badStarted >= 25 * 450, `${Date.now() - badStarted} ms`);
  const link3 = await si.viewerLink({ purpose: "login", portrait: false });
  const fresh = await http("POST", "/bp/session", { Origin: ORIGIN, "Content-Type": "application/json" }, JSON.stringify({ ticket: decodeURIComponent(new URL(link3.url).hash.slice(3).split("&")[0]) }));
  check("relay: a good link still works after many bad ones", fresh.status === 200, fresh.status);
  const control = helper(`return (await fetch("http://${relayName}:8081/control")).json();`);
  check("relay: takeover state reachable from the run's network namespace", control && typeof control.ownerControl === "boolean", JSON.stringify(control));
  const relayPublicIp = inspect(relayName, `{{(index .NetworkSettings.Networks "${neko.replace(/-neko$/, "-pub")}").IPAddress}}`);
  const fromPublic = docker("exec", proxyName, "node", "-e", `fetch("http://${relayPublicIp}:8081/control",{signal:AbortSignal.timeout(3000)}).then(()=>console.log("open"),()=>console.log("refused"))`);
  check("relay: the takeover port is not on the outward network", fromPublic === "refused", fromPublic);

  // 7. browser_close leaves the owner's tabs alone (and disconnects the run's client); a tab opened
  // while it is disconnected stays hidden after it reconnects; a cookie survives a neko restart.
  r = await agent.call("browser_close", {});
  const after = helper(`return context.pages().map((p) => p.url());`);
  check("browser_close leaves the owner's browser and tabs", Array.isArray(after) && after.some((u) => u.includes("bp-owner=1")) && after.some((u) => u.includes("bp-owner=2")), (after ?? []).length + " pages");
  helper(`const p = await context.newPage(); await p.goto("https://example.org/?bp-owner=3"); return 1;`);
  r = await agent.call("browser_tabs", { action: "list" });
  check("a tab opened while the run's client was disconnected stays hidden after it reconnects", !r.error && !/example\.org|bp-owner/.test(r.text), r.error ? r.text.slice(0, 80) : "");
  const value = Math.random().toString(36).slice(2, 10);
  const set = helper(`const p = await context.newPage(); await p.goto("https://example.com/?bp-smoke=cookie"); await p.evaluate((v) => { document.cookie = "bp_smoke=" + v + "; max-age=86400; path=/; secure"; }, ${JSON.stringify(value)}); return (await context.cookies("https://example.com")).map((c) => c.name);`);
  check("cookie set on https://example.com", Array.isArray(set) && set.includes("bp_smoke"));
  await agent.close();
  console.log("waiting 50 s for Chromium to write its cookies…");
  await sleep(50_000);
  await si.stop();
  check("stopped (profile kept)", (await si.status()).state === "ready" && docker("volume", "ls", "--format", "{{.Name}}").split("\n").includes(neko.replace(/-neko$/, "-profile")));
  await si.viewerLink({ purpose: "login", portrait: false });
  const cookies = helper(`return (await context.cookies("https://example.com")).filter((c) => c.name === "bp_smoke").map((c) => c.value);`);
  check("a cookie survives a neko restart", Array.isArray(cookies) && cookies.includes(value), JSON.stringify(cookies));
  const restored = helper(`return context.pages().map((p) => p.url()).filter((u) => u.includes("bp-owner"));`);
  const again = await mcpClient((await si.mcpServer("smoke-agent-2")).server);
  r = await again.call("browser_tabs", { action: "list" });
  check("after a restart the restored tabs stay hidden from a new run", !/example\.org|bp-owner/.test(r.text), `${(restored ?? []).length} restored owner tab(s)`);
  await again.close();

  // 8. A missing relay and proxy are started alone; neko keeps running.
  const nekoStarted = inspect(neko, "{{.State.StartedAt}}");
  docker("rm", "-f", relayName, proxyName);
  await si.viewerLink({ purpose: "login", portrait: false });
  check(
    "a missing relay and proxy are restarted alone (neko untouched)",
    inspect(neko, "{{.State.StartedAt}}") === nekoStarted && inspect(relayName, "{{.State.Running}}") === "true" && inspect(proxyName, "{{.State.Running}}") === "true",
  );
  const viaNewProxy = helper(`const p = await context.newPage(); const res = await p.goto("https://example.com/?bp-smoke=after-repair"); const ok = res?.ok(); await p.close(); return ok;`);
  check("the browser reaches the web through the new proxy (by name)", viaNewProxy === true);
} catch (error) {
  check("smoke run", false, error instanceof Error ? error.stack : String(error));
} finally {
  clearInterval(lockTimer);
  if (browser) await browser.close().catch(() => {});
  if (webkitBrowser) await webkitBrowser.close().catch(() => {});
  if (webkitContainer) {
    try {
      docker("rm", "-f", webkitContainer);
    } catch {
      // already gone
    }
  }
  // 8. Cleanup: everything but the images.
  await si.logout().catch((error) => console.log(`logout failed: ${error.message}`));
  const instance = await sb.instance();
  const left = [
    docker("ps", "-a", "--filter", `label=browser-prompt.instance=${instance}`, "--format", "{{.Names}}"),
    docker("network", "ls", "--filter", `label=browser-prompt.instance=${instance}`, "--format", "{{.Name}}"),
    docker("volume", "ls", "--filter", `label=browser-prompt.instance=${instance}`, "--format", "{{.Name}}"),
  ]
    .join("\n")
    .trim();
  check("cleanup: no containers, networks or volumes left (images kept)", left === "", left.replace(/\n/g, ", "));
  rmSync(state, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

/**
 * Bitwarden checks (step 4b): the pinned install, the policies, what the agent can and cannot reach
 * (through its MCP, and through the same DevTools filter used directly next to a privileged
 * connection that plays the extension), a real Bitwarden frame inside the agent's tab, passkey
 * interception on webauthn.io, and the lock shortcut.
 */
async function bitwardenChecks({ agent, neko, helper, pageByMarker }) {
  const exec = (...args) => docker("exec", neko, ...args);
  const ext = `chrome-extension://${BITWARDEN.id}`;

  // The pinned files and the policy, as the browser has them.
  const pin = JSON.parse(exec("cat", "/opt/bitwarden/browser-prompt-pin.json"));
  const manifest = JSON.parse(exec("cat", "/opt/bitwarden/manifest.json"));
  check(
    "Bitwarden: the browser loads the pinned version (SHA-256 checked), no update URL, lock shortcut set",
    pin.version === BITWARDEN.version && pin.sha256 === BITWARDEN.sha256 && manifest.version === BITWARDEN.version && !("update_url" in manifest) && manifest.commands?.lock_vault?.suggested_key?.default === BITWARDEN.lockShortcut,
    `${pin.version}, ${pin.sha256.slice(0, 16)}…`,
  );
  const writable = docker("exec", "--user", "neko", neko, "sh", "-c", 'for f in /opt/bitwarden /opt/bitwarden/manifest.json /opt/bitwarden/background.js /etc/chromium/policies/managed/policies.json; do test -w "$f" && echo "$f"; done; true');
  check("Bitwarden: its files and the policy are read-only for the browser user", writable === "", writable);
  const policy = JSON.parse(exec("cat", "/etc/chromium/policies/managed/policies.json"));
  check("policy: Chromium's own password manager and autofill are off", policy.PasswordManagerEnabled === false && policy.AutofillAddressEnabled === false && policy.AutofillCreditCardEnabled === false);
  check(
    "policy: Bitwarden is the only extension (types, install sources, external extensions, store blocked)",
    JSON.stringify(policy.ExtensionAllowedTypes) === '["extension"]' && Array.isArray(policy.ExtensionInstallSources) && policy.ExtensionInstallSources.length === 0 && policy.BlockExternalExtensions === true && policy.URLBlocklist.includes("chromewebstore.google.com"),
  );
  check(
    "policy: extension pages are not blocked by URL (Bitwarden's dynamic frame ids), every other internal page still is",
    !policy.URLBlocklist.includes("chrome-extension://*") && ["chrome://*", "devtools://*", "view-source:*", "file://*", "data:*"].every((u) => policy.URLBlocklist.includes(u)),
  );
  const args = exec("sh", "-c", 'tr "\\0" "\\n" < /proc/$(pgrep -o -f "^/usr/lib/chromium/chromium --show")/cmdline');
  check("Chromium: loads only /opt/bitwarden and disables every other extension", /^--load-extension=\/opt\/bitwarden$/m.test(args) && /^--disable-extensions-except=\/opt\/bitwarden$/m.test(args));

  // Privileged view (the harness, not the agent): Bitwarden runs.
  const loaded = helper(`const cdp = await browser.newBrowserCDPSession(); const { targetInfos } = await cdp.send("Target.getTargets"); return targetInfos.filter((t) => /^chrome-extension:/.test(t.url)).map((t) => t.type + " " + t.url);`);
  check("Bitwarden loads with the store id (its service worker runs)", (loaded ?? []).some((line) => line.startsWith(`service_worker ${ext}/`)), (loaded ?? []).join(", "));
  // Chromium's own component extensions (PDF viewer) have no background target; any other extension would.
  const backgrounds = (loaded ?? []).filter((line) => /^(service_worker|background_page|other) /.test(line));
  check("Chromium: no other extension runs", backgrounds.every((line) => line.includes(`chrome-extension://${BITWARDEN.id}/`)), backgrounds.join(", "));

  // The agent through its MCP: no extension target, no extension page, no store.
  let r = await agent.call("browser_tabs", { action: "list" });
  check("agent: no extension page among its tabs", !/chrome-extension:/i.test(r.text));
  for (const url of [`${ext}/popup/index.html`, `${ext}/popup/index.html#/vault`, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html", "chrome-%65xtension://x/"]) {
    r = await agent.call("browser_navigate", { url });
    check(`agent refused ${url.slice(0, 60)}`, r.error && /extension pages \(chrome-extension:\/\/\) are not available/i.test(r.text), r.text.split("\n")[0].slice(0, 80));
  }
  r = await agent.call("browser_tabs", { action: "new", url: `${ext}/popup/index.html` });
  check("agent cannot open a tab with an extension page", r.error && /not available/.test(r.text));
  await agent.call("browser_tabs", { action: "new" });
  r = await agent.call("browser_navigate", { url: "https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb" });
  check("agent: the Chrome Web Store is blocked (no other extension can be installed)", /ERR_BLOCKED_BY_ADMINISTRATOR/.test(r.text) || /chrome-error:/.test((await agent.call("browser_snapshot", {})).text), r.text.split("\n").find((l) => /ERR_/.test(l))?.slice(0, 80));
  await agent.call("browser_tabs", { action: "close" });

  // The same DevTools filter the agent's Playwright uses, driven directly, next to a privileged
  // connection that puts a real Bitwarden frame (its own overlay page, with a marker) into the page.
  const filtered = helper(`
const { startCdpFilter } = await import("/opt/browser-prompt/cdp-filter.mjs");
const out = {};
// A step that hangs ends the harness with what it has (and the step's name), never the smoke run.
setTimeout(() => {
  process.stdout.write(JSON.stringify({ ...out, stuck: out.step }));
  process.exit(0);
}, 110000).unref();
out.step = "filter";
const cdpFilter = await startCdpFilter({ upstream: "http://127.0.0.1:9222" });
const pcdp = await browser.newBrowserCDPSession();
const sw = (await pcdp.send("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(${JSON.stringify(ext)}));
out.step = "raw";
// Raw DevTools messages through the filter first (as a client of the agent's kind), then Playwright.
{
  const version = await (await fetch(cdpFilter.endpoint + "/json/version")).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
  let n = 0;
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => resolve({ timeout: true }), 10000); });
  out.targets = ((await send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.url.startsWith("chrome-extension:")).map((t) => t.url);
  out.attach = JSON.stringify((await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).error ?? "attached");
  out.info = JSON.stringify((await send("Target.getTargetInfo", { targetId: sw.targetId })).error ?? "info");
  out.createExt = JSON.stringify((await send("Target.createTarget", { url: ${JSON.stringify(`${ext}/popup/index.html`)} })).error ?? "created");
  ws.close();
  await new Promise((r) => setTimeout(r, 500));
}
out.step = "connect";
const agentBrowser = await chromium.connectOverCDP(cdpFilter.endpoint, { timeout: 20000 });
const actx = agentBrowser.contexts()[0];
out.serviceWorkers = actx.serviceWorkers().map((w) => w.url()).filter((u) => u.startsWith("chrome-extension:"));
out.step = "newPage";
const apage = await actx.newPage();
out.step = "open extension page";
out.open = await apage.goto(${JSON.stringify(`${ext}/popup/index.html`)}, { timeout: 10000 }).then(() => "opened " + apage.url(), (e) => e.message.split("\\n")[0].slice(0, 120));
out.step = "goto";
const marker = "bw-frame-" + Date.now();
await apage.goto("https://example.com/?bp-smoke=" + marker, { timeout: 20000 });
out.step = "inject";
const ppage = context.pages().find((p) => p.url().includes("bp-smoke=" + marker));
const session = await context.newCDPSession(ppage);
const worlds = [];
session.on("Runtime.executionContextCreated", (e) => worlds.push(e.context));
await session.send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1000));
out.worlds = worlds.filter((c) => c.auxData?.type === "isolated").map((c) => c.name);
const world = worlds.find((c) => c.auxData?.type === "isolated" && /bitwarden/i.test(c.name));
const made = world
  ? await Promise.race([
      session.send("Runtime.evaluate", { contextId: world.id, returnByValue: true, expression: '(() => { const f = document.createElement("iframe"); f.id = "bp-bw-frame"; f.src = chrome.runtime.getURL("overlay/menu.html"); f.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;z-index:2147483647;border:0"; document.documentElement.appendChild(f); return f.src; })()' }),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 15000)),
    ])
  : null;
out.frameSrc = made?.result?.value ?? JSON.stringify(made);
await new Promise((r) => setTimeout(r, 3000));
const pframe = ppage.frames().find((f) => f.url().startsWith("chrome-extension:"));
out.frameLoaded = pframe ? pframe.url() : "no extension frame: " + ppage.frames().map((f) => f.url()).join(" ");
if (pframe) {
  out.step = "mark";
  await Promise.race([new Promise((r) => setTimeout(r, 10000)), pframe.evaluate(() => {
    document.body.innerHTML = "";
    const b = document.createElement("button");
    b.textContent = "BW-SECRET-MARKER";
    b.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
    b.addEventListener("click", () => (window.bpClicks = (window.bpClicks || 0) + 1));
    document.body.append(b);
  }).catch((e) => (out.markErr = e.message.slice(0, 120)))]);
}
out.step = "read";
out.agentFrames = apage.frames().map((f) => f.url());
out.aria = await apage.locator("body").ariaSnapshot({ timeout: 15000 }).then((t) => t, (e) => "ERR " + e.message.split("\\n")[0]);
out.html = (await apage.content()).includes("BW-SECRET-MARKER");
out.step = "click";
out.clickFrame = await apage.mouse.click(100, 100).then(() => "clicked", (e) => e.message.split("\\n")[0].slice(0, 140));
out.tapFrame = await apage.mouse.click(390, 290).then(() => "clicked", (e) => e.message.split("\\n")[0].slice(0, 140));
out.clickPage = await apage.mouse.click(700, 600).then(() => "clicked", (e) => e.message.split("\\n")[0].slice(0, 140));
out.step = "count";
out.frameClicks = pframe ? await Promise.race([pframe.evaluate(() => window.bpClicks || 0).catch(() => -1), new Promise((r) => setTimeout(() => r(-2), 10000))]) : -1;
out.step = "done";
await apage.close().catch(() => {});
await cdpFilter.close();
return out;`);
  check("filter: no Bitwarden service worker for the agent's Playwright", filtered && filtered.serviceWorkers.length === 0, JSON.stringify(filtered?.serviceWorkers));
  check("filter: no extension target in the agent's target list", filtered && filtered.targets.length === 0, JSON.stringify(filtered?.targets));
  check("filter: attaching to Bitwarden's service worker, or asking about it, is refused", filtered && /No such target/.test(filtered.attach) && /No such target/.test(filtered.info), `${filtered?.attach} ${filtered?.info}`);
  check("filter: creating a tab with an extension page is refused", filtered && /password manager/.test(filtered.createExt), filtered?.createExt);
  check("filter: the agent cannot open Bitwarden's popup page", filtered && !/^opened/.test(filtered.open), filtered?.open);
  check("Bitwarden's content script is in https pages (its isolated world)", filtered && filtered.worlds.some((n) => /bitwarden/i.test(n)), JSON.stringify(filtered?.worlds));
  check(
    "Bitwarden's own overlay frame loads inside a page under the policy (dynamic extension URL)",
    filtered && /^chrome-extension:\/\/[^/]+\/overlay\/menu\.html/.test(filtered.frameLoaded),
    `${filtered?.frameSrc} -> ${filtered?.frameLoaded}${filtered?.markErr ? `, ${filtered.markErr}` : ""}`,
  );
  check("filter: the agent's page does not show the frame's contents (aria snapshot, HTML)", filtered && !/BW-SECRET-MARKER/.test(filtered.aria) && !filtered.html && !/^ERR/.test(filtered.aria), (filtered?.aria ?? "").slice(0, 120));
  check(
    "filter: the agent's clicks on the Bitwarden frame are refused; elsewhere they work",
    filtered && /password manager/.test(filtered.clickFrame) && /password manager/.test(filtered.tapFrame) && filtered.clickPage === "clicked" && filtered.frameClicks === 0,
    JSON.stringify({ frame: filtered?.clickFrame?.slice(0, 60), page: filtered?.clickPage, clicksInFrame: filtered?.frameClicks }),
  );

  // The real agent with a real Bitwarden frame in its own tab: its snapshot stays clean and fast, a click on the frame is refused.
  r = await agent.call("browser_tabs", { action: "new", url: "https://example.com/?bp-smoke=bw-agent" });
  const injected = helper(`${pageByMarker("bp-smoke=bw-agent")}
const session = await context.newCDPSession(page);
const worlds = [];
session.on("Runtime.executionContextCreated", (e) => worlds.push(e.context));
await session.send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1000));
const world = worlds.find((c) => c.auxData?.type === "isolated" && /bitwarden/i.test(c.name));
if (!world) return "no Bitwarden world";
await session.send("Runtime.evaluate", { contextId: world.id, expression: '(() => { const f = document.createElement("iframe"); f.title = "bp-bw-frame"; f.src = chrome.runtime.getURL("overlay/menu.html"); f.style.cssText = "position:fixed;left:0;top:0;width:500px;height:400px;z-index:2147483647;border:0"; document.body.appendChild(f); })()' });
await new Promise((r) => setTimeout(r, 3000));
const frame = page.frames().find((f) => f.url().startsWith("chrome-extension:"));
if (!frame) return "no frame";
await frame.evaluate(() => { document.body.innerHTML = '<h1>BW-SECRET-MARKER</h1><input value="bw-secret-value">'; });
return frame.url();`);
  const started = Date.now();
  r = await agent.call("browser_snapshot", {});
  const took = Date.now() - started;
  check("agent: its snapshot with a Bitwarden frame in the page does not contain the frame's contents and does not hang", !r.error && /Example Domain/.test(r.text) && !/BW-SECRET-MARKER|bw-secret-value/.test(r.text) && took < 30_000, `${injected}; ${took} ms`);
  const frameRef = /iframe[^\n]*\[ref=([a-z0-9]+)\]/i.exec(r.text)?.[1];
  if (frameRef) {
    const click = await agent.call("browser_click", { element: "frame", target: frameRef });
    const reason = click.text.replace(/^### Error\s*/m, "").split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ").slice(0, 240);
    check("agent: clicking the Bitwarden frame is refused", click.error && /password manager|Not allowed/i.test(click.text), reason);
  } else check("agent: the Bitwarden frame has no ref in its snapshot (nothing to click)", true, "no iframe ref");

  // The lock shortcut reaches Chromium as Bitwarden's command: the page never sees it (a control key does reach the page).
  const stackId = neko.replace(/^bp-si-([0-9a-f]{8})-neko$/, "$1");
  helper(`${pageByMarker("bp-smoke=bw-agent")} await page.bringToFront(); await page.evaluate(() => { window.bpKeys = []; window.addEventListener("keydown", (e) => window.bpKeys.push(e.code + (e.ctrlKey ? "+ctrl" : "") + (e.shiftKey ? "+shift" : "")), true); document.activeElement?.blur?.(); }); return 1;`);
  docker("exec", "--user", "neko", "--env", "DISPLAY=:99.0", neko, "xdotool", "key", "--clearmodifiers", "ctrl+shift+8");
  await sleep(500);
  docker(...bitwardenLockArgs(stackId));
  await sleep(800);
  const keys = helper(`${pageByMarker("bp-smoke=bw-agent")} return page.evaluate(() => window.bpKeys);`);
  check("lock: the daemon's shortcut is Bitwarden's command (the page sees a control key, never the lock key)", Array.isArray(keys) && keys.includes("Digit8+ctrl+shift") && !keys.some((k) => k.startsWith("Digit7")), JSON.stringify(keys));
  await agent.call("browser_tabs", { action: "close" });

  // Passkeys on a public demo: Bitwarden intercepts navigator.credentials there; the agent cannot see what it opens.
  r = await agent.call("browser_tabs", { action: "new", url: "https://webauthn.io/" });
  const reachable = !r.error && /webauthn/i.test(r.text);
  const fido = reachable
    ? helper(`${pageByMarker("webauthn.io")}
const session = await context.newCDPSession(page);
const worlds = [];
session.on("Runtime.executionContextCreated", (e) => worlds.push(e.context));
await session.send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));
const native = await page.evaluate(() => [String(navigator.credentials.get).includes("[native code]"), String(navigator.credentials.create).includes("[native code]")]);
return { worlds: worlds.filter((c) => c.auxData?.type === "isolated").map((c) => c.name), native };`)
    : null;
  // Bitwarden replaces navigator.credentials in pages only with an account logged in (its passkey
  // scripts are registered then); this smoke test has none, so that part is reported, not required.
  check(
    "passkeys: on webauthn.io Bitwarden's content script runs (it takes over navigator.credentials once you are logged in)",
    !reachable || (fido && fido.worlds.some((n) => /bitwarden/i.test(n))),
    reachable ? `navigator.credentials.get/create native while logged out: ${JSON.stringify(fido?.native)}` : "webauthn.io not reachable from here: skipped",
  );
  if (reachable) {
    const snap = (await agent.call("browser_snapshot", {})).text;
    const box = /textbox[^\n]*\[ref=([a-z0-9]+)\]/i.exec(snap)?.[1];
    const button = /button "Register"[^\n]*\[ref=([a-z0-9]+)\]/i.exec(snap)?.[1];
    const before = helper(`const cdp = await browser.newBrowserCDPSession(); return (await cdp.send("Target.getTargets")).targetInfos.map((t) => t.targetId);`);
    if (box && button) {
      await agent.call("browser_type", { element: "username", target: box, text: `bp-smoke-${Date.now()}` });
      await agent.call("browser_click", { element: "Register", target: button });
      await sleep(4000);
    }
    const opened = helper(`const cdp = await browser.newBrowserCDPSession(); const before = new Set(${JSON.stringify(before ?? [])}); return (await cdp.send("Target.getTargets")).targetInfos.filter((t) => !before.has(t.targetId)).map((t) => t.type + " " + t.url.slice(0, 80));`);
    const tabs = (await agent.call("browser_tabs", { action: "list" })).text;
    check(
      "passkeys: what a site's passkey request opens is not visible to the agent",
      !/chrome-extension:/i.test(tabs) && (tabs.match(/^- \d+:/gm) ?? []).length <= 3,
      `${box && button ? "registered from the agent's tab" : "no form found"}; opened (privileged view): ${JSON.stringify(opened)}`,
    );
    // Close whatever the request opened (privileged), so the next checks start clean.
    helper(`const cdp = await browser.newBrowserCDPSession(); const before = new Set(${JSON.stringify(before ?? [])}); for (const t of (await cdp.send("Target.getTargets")).targetInfos) if (!before.has(t.targetId) && t.type === "page" && t.url.startsWith("chrome-extension:")) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {}); return 1;`);
  }
  await agent.call("browser_tabs", { action: "close" });

  // The relay asked for a lock when it started; the daemon pressed it and the run went on.
  const keysFile = JSON.parse(readFileSync(join(state, "keys.json"), "utf8"));
  const relayStatus = JSON.parse((await http("GET", "/bp/status", { Authorization: `Bearer ${keysFile.statusToken}` })).body);
  check("lock: the daemon locked Bitwarden when the relay asked, and nothing is pending", locks > 0 && relayStatus.lockPending === false, `${locks} lock(s), generation ${relayStatus.lockGeneration}`);
}
