// Smoke test of the signed-in Server browser on this host, with the plugin's own code. Developer
// tool, not part of the plugin: it builds missing images WITHOUT the settings' two-press consent
// (that bypass exists only here), binds only 127.0.0.1 (never the Tailscale address), uses its own
// state directory and plugin instance, and removes everything it started except the images.
//
//   SMOKE_PLAYWRIGHT_CORE=/path/to/dir-with/node_modules/playwright-core \
//   SMOKE_CHROMIUM=/path/to/chrome \
//   node --experimental-strip-types --no-warnings scripts/smoke-signed-in.mjs
//
// Checks: images (build when missing), the stack starts; the agent's Playwright MCP over CDP lists
// only the allowed tools and opens https://example.com; blocked hosts and Chromium's internal pages
// (chrome://, view-source:, about:) are refused from inside; a headless phone-emulated viewer logs
// in through the key flow (cookie with a random name, scoped to a random path), takes control (the
// agent's tool calls are paused meanwhile), taps and types into the agent's page, and releases it;
// one run at a time; a cookie survives a neko restart; the relay refuses /metrics, admin APIs,
// foreign Host and foreign-Origin WebSockets; no STUN servers; the hardening as Docker reports it;
// and the cleanup.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const si = createSignedIn({
  serverBrowser: sb,
  bindHost: async () => "127.0.0.1",
  config: async () => ({ port: PORT, httpsBaseUrl: "" }),
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
try {
  // 1. Images (the consent bypass: only in this script).
  let status = await si.status({ build: true });
  while (status.state === "building") {
    await sleep(5000);
    status = await si.status();
  }
  check("images ready", status.state === "ready" || status.state === "running", `${status.serverImage}, ${status.image}`);

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

  // 4. The agent's MCP over CDP.
  const mcp = await si.mcpServer("smoke-agent-1");
  check("MCP server for a run", mcp && "server" in mcp, mcp && "session" in mcp ? mcp.session : JSON.stringify(mcp));
  const agent = await mcpClient(mcp.server);
  const tools = (await agent.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check("MCP lists only allowed tools", tools.includes("browser_navigate") && !tools.includes("browser_run_code_unsafe") && !tools.includes("browser_file_upload"), `${tools.length} tools`);
  check("denied tool refused", /turned off/.test((await agent.call("browser_run_code_unsafe", { code: "1" })).text));
  let r = await agent.call("browser_tabs", { action: "new", url: "https://example.com" });
  check("agent opens https://example.com over CDP", !r.error && /Example Domain/.test(r.text));
  for (const target of ["http://100.96.145.38:5299/", "http://paseo-box.tail60821.ts.net/", "http://192.168.1.1/", "http://127.0.0.1:9222/json/version", "http://127.0.0.1:8080/api/whoami"]) {
    await agent.call("browser_tabs", { action: "new" });
    const nav = await agent.call("browser_navigate", { url: target });
    const body = (await agent.call("browser_evaluate", { function: "() => document.body ? document.body.innerText.slice(0, 200) : ''" })).text;
    const leaked = /webSocketDebuggerUrl|"Browser"|"is_admin"|neko/i.test(body);
    check(`agent blocked from ${target}`, (nav.error || /Blocked by the browser-prompt|403/.test(nav.text + body)) && !leaked, nav.error ? nav.text.split("\n").find((l) => /Error|ERR_/.test(l))?.slice(0, 90) : "403 page");
    await agent.call("browser_tabs", { action: "close" });
  }
  for (const target of ["chrome://history", "chrome://settings", "chrome://settings/content/all", "chrome://version", "view-source:https://example.com", "about:version", "chrome-untrusted://print/", "devtools://devtools/bundled/inspector.html"]) {
    await agent.call("browser_tabs", { action: "new" });
    const nav = await agent.call("browser_navigate", { url: target });
    const page = (await agent.call("browser_evaluate", { function: "() => JSON.stringify({ url: location.href, text: document.body ? document.body.innerText.slice(0, 300) : '' })" })).text;
    const seen = JSON.parse(JSON.parse(page.match(/"\{.*\}"/)?.[0] ?? '"{}"'));
    // Refused: Chromium's policy block (ERR_BLOCKED_BY_ADMINISTRATOR, an error page), or an empty page (about:version).
    const blocked = /ERR_BLOCKED_BY_ADMINISTRATOR/.test(nav.text) || String(seen.url ?? "").startsWith("chrome-error://");
    const empty = !String(seen.text ?? "").trim();
    check(`agent refused ${target}`, blocked || empty, blocked ? "ERR_BLOCKED_BY_ADMINISTRATOR" : "empty page, nothing shown");
    await agent.call("browser_tabs", { action: "close" });
  }
  r = await agent.call("browser_navigate", { url: "https://example.com" });
  check("normal https still works after the internal-page checks", !r.error && /Example Domain/.test(r.text));
  await agent.call("browser_tabs", { action: "close" });
  r = await agent.call("browser_tabs", { action: "list" });
  const tabIndex = [...r.text.matchAll(/- (\d+):.*\(https:\/\/example\.com\/?\)/g)].map((m) => Number(m[1])).at(-1);
  await agent.call("browser_tabs", { action: "select", index: tabIndex });
  await agent.call("browser_evaluate", {
    function:
      "() => { document.body.innerHTML = '<input id=user autocomplete=off style=\"position:fixed;left:0;top:0;width:100vw;height:45vh;font-size:40px\"><button id=btn style=\"position:fixed;left:0;top:55vh;width:100vw;height:45vh;font-size:40px\" onclick=\"window.clicks=(window.clicks||0)+1\">tap</button>'; return 1; }",
  });
  const busy = await si.prepare({ sourceId: "smoke", cardId: "card" });
  check("one run at a time: a second run is busy", !busy.ok && busy.state === "busy", JSON.stringify(busy));

  // 5. The phone viewer: key flow, control, tap and type.
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
  const release = page.locator('button[aria-label="Release Controls"], button[aria-label="controls.release"]').first();
  const releasable = (await release.count()) > 0;
  if (releasable) await release.click({ force: true });
  else await page.close();
  await page.waitForTimeout(2500);
  // After a takeover the agent's current tab may have moved (Chromium's omnibox popups show up as
  // pages); the prompt tells the agent to list and select its own tab again, as here.
  r = await agent.call("browser_tabs", { action: "list" });
  console.log(`(tabs after the takeover: ${r.text.split("\n").filter((l) => /^- \d+:/.test(l)).join(" ").slice(0, 300)})`);
  check("no blocked chrome:// popup pages among the tabs (native address-bar popup)", !/omnibox-popup/.test(r.text));
  const ownTab = [...r.text.matchAll(/- (\d+):.*\(https:\/\/example\.com\/?\)/g)].map((m) => Number(m[1])).at(-1);
  await agent.call("browser_tabs", { action: "select", index: ownTab });
  r = await agent.call("browser_evaluate", { function: "() => JSON.stringify({ user: document.getElementById('user').value, clicks: window.clicks || 0 })" });
  check("takeover: the agent works again once the owner releases control", !r.error, releasable ? "released with the button" : "viewer closed");
  const seen = JSON.parse(JSON.parse(r.text.match(/"\{.*\}"/)?.[0] ?? '"{}"'));
  check("takeover: the phone's taps and typing reach the agent's page", seen.user === "alice" && seen.clicks === 2, JSON.stringify(seen));
  check("viewer: no refused requests from the neko client", refused.length === 0, refused.join(", "));

  // 6. Relay refusals with a valid session.
  const cookie = `${viewerCookie.name}=${viewerCookie.value}`;
  check("relay: the session cookie does nothing outside its path", (await http("GET", "/api/whoami", { Cookie: cookie })).status === 401);
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
    const res = await http(method, `${prefix}${path}`, { Cookie: cookie, Origin: ORIGIN });
    check(`relay refuses ${method} ${path}`, res.status === 403, res.status);
  }
  check("relay: foreign Host refused", (await http("GET", `${prefix}/`, { Host: "evil.example", Cookie: cookie })).status === 421);
  check("relay: WebSocket with a foreign Origin refused", / 403 /.test(await upgrade({ Cookie: cookie, Origin: "http://evil.example" }, `${prefix}/api/ws`)));
  check("relay: WebSocket without a session refused", / 401 /.test(await upgrade({ Origin: ORIGIN }, `${prefix}/api/ws`)));
  check("relay: WebSocket outside the prefix refused", / 403 /.test(await upgrade({ Cookie: cookie, Origin: ORIGIN }, "/api/ws")));
  check("relay: WebSocket with own Origin and session accepted", / 101 /.test(await upgrade({ Cookie: cookie, Origin: ORIGIN }, `${prefix}/api/ws`)));
  const keys = JSON.parse((await import("node:fs")).readFileSync(join(state, "keys.json"), "utf8"));
  const relayStatus = JSON.parse((await http("GET", "/bp/status", { Authorization: `Bearer ${keys.statusToken}` })).body);
  console.log(`(the relay sees viewers coming from ${relayStatus.lastPeer}: ${/^127\./.test(relayStatus.lastPeer) ? "the real peer" : "Docker's port forwarder, so peer binding adds nothing on this host"})`);
  const ticket = decodeURIComponent(new URL(link.url).hash.slice(3).split("&")[0]);
  check("relay: a used ticket is refused", (await http("POST", "/bp/session", { Origin: ORIGIN, "Content-Type": "application/json" }, JSON.stringify({ ticket }))).status === 401);
  await browser.close();
  browser = null;

  // 7. A cookie survives a neko restart.
  const value = Math.random().toString(36).slice(2, 10);
  await agent.call("browser_tabs", { action: "new", url: "https://example.com" });
  r = await agent.call("browser_evaluate", { function: `() => { document.cookie = "bp_smoke=${value}; max-age=86400; path=/; secure"; return location.origin + " " + document.cookie; }` });
  check("cookie set on https://example.com", !r.error && r.text.includes(`https://example.com`) && r.text.includes(`bp_smoke=${value}`), r.error ? r.text.slice(0, 120) : "");
  await agent.close();
  console.log("waiting 50 s for Chromium to write its cookies…");
  await sleep(50_000);
  await si.stop();
  check("stopped (profile kept)", (await si.status()).state === "ready" && docker("volume", "ls", "--format", "{{.Name}}").split("\n").includes(neko.replace(/-neko$/, "-profile")));
  await si.viewerLink({ purpose: "login", portrait: false });
  const again = await mcpClient((await si.mcpServer("smoke-agent-2")).server);
  await again.call("browser_tabs", { action: "new", url: "https://example.com" });
  r = await again.call("browser_evaluate", { function: "() => document.cookie" });
  check("a cookie survives a neko restart", r.text.includes(`bp_smoke=${value}`), r.text.includes(`bp_smoke=${value}`) ? "" : r.text.slice(0, 160));
  await again.close();
} catch (error) {
  check("smoke run", false, error instanceof Error ? error.stack : String(error));
} finally {
  if (browser) await browser.close().catch(() => {});
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
