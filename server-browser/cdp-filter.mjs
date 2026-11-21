// DevTools-protocol filter between a signed-in run's Playwright MCP and the owner's Chromium (neko).
// It runs inside the run's MCP container (in neko's network namespace) and is the only DevTools
// endpoint Playwright MCP gets. It hides the owner's tabs from the run: every page that exists when
// the run attaches, every page the owner opens while holding control in the viewer, and every
// popup of a hidden page. Playwright never attaches to them, so the agent cannot list, select,
// close, read or act on them. Commands that target a hidden tab, and closing the browser, are
// refused. Node's standard library plus the `ws` WebSocket implementation Playwright bundles.
import { createServer, get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Commands refused whatever their target: they would end the owner's browser. */
export const REFUSED_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);
/** Commands refused when their `targetId` is a hidden (owner's) page. */
export const TARGET_METHODS = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo", "Target.exposeDevToolsProtocol"]);
const TARGET_EVENTS = new Set(["Target.targetCreated", "Target.targetInfoChanged", "Target.targetDestroyed", "Target.targetCrashed"]);
const INTERNAL_ID_BASE = 2_000_000_000;

/**
 * The filter's rules, without I/O. `held()` says whether the owner holds control right now (a page
 * created then with no opener is the owner's). `fromClient(message)` returns `{ forward }` or
 * `{ reply }`; `fromBrowser(message)` returns `{ deliver, toBrowser }` (deliver null to drop it; the
 * messages in `toBrowser` go to Chromium: resume and detach a hidden page Chromium auto-attached).
 */
export function createTargetFilter({ held = () => false } = {}) {
  const hiddenTargets = new Set();
  const visibleTargets = new Set();
  const hiddenSessions = new Set();
  let internal = INTERNAL_ID_BASE;

  /** Hidden or not, decided once per target when it is first seen. */
  function hidden(info) {
    const id = info?.targetId;
    if (typeof id !== "string") return false;
    if (hiddenTargets.has(id)) return true;
    if (visibleTargets.has(id)) return false;
    const opener = typeof info.openerId === "string" ? info.openerId : "";
    const hide = info.type === "page" && (opener ? hiddenTargets.has(opener) : held());
    (hide ? hiddenTargets : visibleTargets).add(id);
    return hide;
  }

  const error = (id, message, sessionId) => ({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } });

  return {
    /** The pages open when the run attaches: the owner's. */
    hideExisting(targetIds) {
      for (const id of targetIds) if (typeof id === "string" && !visibleTargets.has(id)) hiddenTargets.add(id);
    },
    isHidden: (targetId) => hiddenTargets.has(targetId),
    fromClient(message) {
      if (!message || typeof message !== "object" || typeof message.method !== "string") return { reply: error(message?.id ?? 0, "Malformed message.") };
      if (REFUSED_METHODS.has(message.method)) return { reply: error(message.id, "Not allowed in the signed-in browser.", message.sessionId) };
      if (message.sessionId && hiddenSessions.has(message.sessionId)) return { reply: error(message.id, "No such target.", message.sessionId) };
      const targetId = message.params?.targetId;
      if (TARGET_METHODS.has(message.method) && typeof targetId === "string" && hiddenTargets.has(targetId)) {
        return { reply: error(message.id, "No such target.", message.sessionId) };
      }
      return { forward: message };
    },
    fromBrowser(message) {
      if (!message || typeof message !== "object") return { deliver: null, toBrowser: [] };
      if (typeof message.id === "number" && message.id >= INTERNAL_ID_BASE) return { deliver: null, toBrowser: [] };
      if (message.sessionId && hiddenSessions.has(message.sessionId)) return { deliver: null, toBrowser: [] };
      if (TARGET_EVENTS.has(message.method)) {
        const info = message.params?.targetInfo ?? { targetId: message.params?.targetId };
        if (message.method === "Target.targetDestroyed" || message.method === "Target.targetCrashed") {
          return { deliver: hiddenTargets.has(message.params?.targetId) ? null : message, toBrowser: [] };
        }
        return { deliver: hidden(info) ? null : message, toBrowser: [] };
      }
      if (message.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo, waitingForDebugger } = message.params ?? {};
        if (!hidden(targetInfo)) return { deliver: message, toBrowser: [] };
        hiddenSessions.add(sessionId);
        const toBrowser = [];
        if (waitingForDebugger) toBrowser.push({ id: internal++, sessionId, method: "Runtime.runIfWaitingForDebugger" });
        toBrowser.push({ id: internal++, ...(message.sessionId ? { sessionId: message.sessionId } : {}), method: "Target.detachFromTarget", params: { sessionId } });
        return { deliver: null, toBrowser };
      }
      if (message.method === "Target.detachedFromTarget" && hiddenSessions.has(message.params?.sessionId)) {
        hiddenSessions.delete(message.params.sessionId);
        return { deliver: null, toBrowser: [] };
      }
      const infos = message.result?.targetInfos;
      if (Array.isArray(infos)) {
        return { deliver: { ...message, result: { ...message.result, targetInfos: infos.filter((info) => !hidden(info)) } }, toBrowser: [] };
      }
      return { deliver: message, toBrowser: [] };
    },
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function bundledWs() {
  const require = createRequire(import.meta.url);
  return require(join(dirname(require.resolve("playwright-core/package.json")), "lib", "utilsBundle.js"));
}

/**
 * Starts the filter on 127.0.0.1 (a random port) in front of `upstream` (Chromium's DevTools HTTP
 * endpoint). Hides the pages open now. Returns `{ endpoint, close() }`: the endpoint to give
 * Playwright MCP. One client at a time.
 */
export async function startCdpFilter({ upstream, held = () => false, log = () => {}, ws = bundledWs() }) {
  const filter = createTargetFilter({ held });
  const pages = await getJson(`${upstream}/json/list`);
  filter.hideExisting((Array.isArray(pages) ? pages : []).filter((page) => page?.type === "page").map((page) => page.id));
  log(`hiding ${filter && Array.isArray(pages) ? pages.filter((page) => page?.type === "page").length : 0} tab(s) the owner had open`);
  const { WebSocket, WebSocketServer } = ws.ws ? { WebSocket: ws.ws, WebSocketServer: ws.wsServer } : ws;
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let port = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/json/version" || req.url === "/json/version/")) {
      try {
        const version = await getJson(`${upstream}/json/version`);
        const path = new URL(version.webSocketDebuggerUrl).pathname;
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...version, webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}` }));
      } catch {
        res.writeHead(502).end();
      }
      return;
    }
    res.writeHead(404).end();
  });
  let busy = false;
  server.on("upgrade", (req, socket, head) => {
    if (busy || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(req.url ?? "")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    busy = true;
    sockets.handleUpgrade(req, socket, head, (client) => {
      const browser = new WebSocket(`${upstream.replace(/^http/, "ws")}${req.url}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const queue = [];
      const toBrowser = (message) => {
        const text = JSON.stringify(message);
        if (browser.readyState === 1) browser.send(text);
        else queue.push(text);
      };
      browser.on("open", () => {
        for (const text of queue.splice(0)) browser.send(text);
      });
      client.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        const verdict = filter.fromClient(message);
        if (verdict.reply) client.send(JSON.stringify(verdict.reply));
        else toBrowser(verdict.forward);
      });
      browser.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        const verdict = filter.fromBrowser(message);
        for (const extra of verdict.toBrowser) toBrowser(extra);
        if (verdict.deliver && client.readyState === 1) client.send(JSON.stringify(verdict.deliver));
      });
      const end = () => {
        busy = false;
        client.close();
        browser.close();
      };
      client.on("close", end);
      browser.on("close", end);
      client.on("error", end);
      browser.on("error", end);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = server.address().port;
  return { endpoint: `http://127.0.0.1:${port}`, filter, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
