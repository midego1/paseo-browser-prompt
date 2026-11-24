// DevTools-protocol filter between a signed-in run's Playwright MCP and the owner's Chromium (neko).
// It runs inside the run's MCP container (in neko's network namespace) and is the only DevTools
// endpoint Playwright MCP gets. It is an allowlist: the run sees only the pages it created itself
// (Target.createTarget through this filter), popups of those opened while the owner does not hold
// control, and the frames and workers attached under them. Everything else (the owner's tabs, tabs
// restored after a restart, tabs the owner opens, service workers, tab targets) is hidden:
// Playwright never attaches to it, and commands that target it are refused, as are closing the
// browser and reading or clearing every cookie. No extension can be installed in this browser (its
// policy blocks them all); as defense in depth, extension targets are hidden too, and the run can
// neither open chrome-extension:// pages nor call Extensions.*. Node's standard library plus the
// `ws` WebSocket implementation Playwright bundles.
import { createServer, get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Commands refused whatever their target: they end the owner's browser or touch every site's cookies. */
export const REFUSED_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Network.getAllCookies",
  "Network.clearBrowserCookies",
]);
/** Commands refused when their `targetId` is not one of the run's pages. */
export const TARGET_METHODS = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.getTargetInfo",
  "Target.exposeDevToolsProtocol",
  "Target.sendMessageToTarget",
  "Target.autoAttachRelated",
  "Target.detachFromTarget",
  "Browser.getWindowForTarget",
]);
const TARGET_EVENTS = new Set(["Target.targetCreated", "Target.targetInfoChanged", "Target.targetDestroyed", "Target.targetCrashed"]);
/**
 * Pages of an extension: never the run's. Whitespace and control characters are ignored and
 * percent-encoding is undone (three rounds), as in the MCP filter.
 */
export function isExtensionUrl(url) {
  if (typeof url !== "string") return false;
  let text = url;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) {
    try {
      text = decodeURIComponent(text);
    } catch {
      break;
    }
  }
  return /^chrome-extension:/i.test(text.replace(/[\s\u0000-\u001f\u007f]+/g, ""));
}
/**
 * Commands refused while the owner holds control (or that cannot be confirmed): anything that
 * acts on or reads a page, so a call that was on its way when the takeover began cannot act during
 * it. Session setup (enable, auto-attach, init scripts, resuming new frames) still passes.
 */
export const HELD_REFUSED =
  /^(Input\.|DOM\.(?!enable$|disable$)|DOMSnapshot\.|DOMStorage\.|IndexedDB\.|CacheStorage\.|Storage\.|Accessibility\.|Fetch\.|Page\.(navigate|reload|navigateToHistoryEntry|captureScreenshot|captureSnapshot|printToPDF|setDocumentContent|close|bringToFront|handleJavaScriptDialog|startScreencast|getResourceContent|searchInResource)$|Target\.(createTarget|closeTarget|activateTarget)$|Runtime\.(evaluate|callFunctionOn|compileScript|runScript|queryObjects|globalLexicalScopeNames|getProperties)$|Network\.(getCookies|getAllCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies|getResponseBody|getRequestPostData|replayXHR|loadNetworkResource)$|Emulation\.setTouchEmulationEnabled$)/;
export const HELD_TEXT = "The owner holds control of the signed-in browser (or its takeover state cannot be confirmed right now): not allowed now.";
export const EXTENSION_TEXT = "Not allowed in the signed-in browser: that is a browser extension's page.";
const INTERNAL_ID_BASE = 2_000_000_000;
const MAX_QUEUE = 200;

/**
 * The filter's rules, without I/O. `held()` says whether the owner holds control right now (a popup
 * opened then is the owner's). `fromClient(message)` returns `{ forward }` or `{ reply }`;
 * `fromBrowser(message)` returns `{ deliver: [...], toBrowser: [...] }`: the messages for Playwright
 * (often none or one; held-back events come out together with the answer they waited for) and the
 * messages for Chromium (resume and detach a hidden page Chromium auto-attached).
 */
export function createTargetFilter({ held = () => false } = {}) {
  /** Pages and other targets the run may see. */
  const visible = new Set();
  const hidden = new Set();
  const visibleSessions = new Set();
  const hiddenSessions = new Set();
  /** Windows of visible pages (Browser.getWindowForTarget answers), the only ones whose bounds may change. */
  const windows = new Set();
  /** Client ids of Target.createTarget / Browser.getWindowForTarget calls on their way. */
  const creating = new Set();
  const windowCalls = new Set();
  /** Events about unknown top-level targets held back while a create is on its way. */
  let queue = [];
  let internal = INTERNAL_ID_BASE;

  /**
   * Visible or not, decided once per target. `parentSession`: the session the target was attached
   * on (a frame or worker of a page). Unknown top-level targets are hidden, except popups of a
   * visible page opened while the owner does not hold control.
   */
  function isVisible(info, parentSession) {
    const id = info?.targetId;
    if (typeof id !== "string") return false;
    if (visible.has(id)) return true;
    if (hidden.has(id)) return false;
    if (isExtensionUrl(info.url)) {
      // Never the run's, also inside its own pages.
      hidden.add(id);
      return false;
    }
    let show = false;
    if (parentSession) show = visibleSessions.has(parentSession);
    else if (info.type === "page" && typeof info.openerId === "string") show = visible.has(info.openerId) && !held();
    (show ? visible : hidden).add(id);
    return show;
  }

  /** Whether a browser-level event is about a target we cannot classify yet (a create is on its way). */
  function undecided(message) {
    if (creating.size === 0 || message.sessionId) return false;
    const info = message.method === "Target.attachedToTarget" ? message.params?.targetInfo : TARGET_EVENTS.has(message.method) ? message.params?.targetInfo : null;
    const id = info?.targetId;
    return typeof id === "string" && !visible.has(id) && !hidden.has(id) && info.type === "page" && typeof info.openerId !== "string";
  }

  function decide(message) {
    const out = { deliver: [], toBrowser: [] };
    if (message.sessionId && hiddenSessions.has(message.sessionId)) return out;
    if (TARGET_EVENTS.has(message.method)) {
      const id = message.params?.targetInfo?.targetId ?? message.params?.targetId;
      if (message.method === "Target.targetDestroyed" || message.method === "Target.targetCrashed") {
        if (visible.has(id)) out.deliver.push(message);
        return out;
      }
      if (isVisible(message.params?.targetInfo, message.sessionId)) out.deliver.push(message);
      return out;
    }
    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = message.params ?? {};
      if (isVisible(targetInfo, message.sessionId)) {
        visibleSessions.add(sessionId);
        out.deliver.push(message);
        return out;
      }
      hiddenSessions.add(sessionId);
      if (waitingForDebugger) out.toBrowser.push({ id: internal++, sessionId, method: "Runtime.runIfWaitingForDebugger" });
      out.toBrowser.push({ id: internal++, ...(message.sessionId ? { sessionId: message.sessionId } : {}), method: "Target.detachFromTarget", params: { sessionId } });
      return out;
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = message.params?.sessionId;
      if (hiddenSessions.has(sessionId)) {
        hiddenSessions.delete(sessionId);
        return out;
      }
      visibleSessions.delete(sessionId);
      out.deliver.push(message);
      return out;
    }
    const infos = message.result?.targetInfos;
    if (Array.isArray(infos)) {
      out.deliver.push({ ...message, result: { ...message.result, targetInfos: infos.filter((info) => visible.has(info?.targetId)) } });
      return out;
    }
    out.deliver.push(message);
    return out;
  }

  const error = (id, message, sessionId) => ({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } });

  return {
    isVisible: (targetId) => visible.has(targetId),
    fromClient(message) {
      if (!message || typeof message !== "object" || typeof message.method !== "string") return { reply: error(message?.id ?? 0, "Malformed message.") };
      if (REFUSED_METHODS.has(message.method) || message.method.startsWith("Extensions.")) return { reply: error(message.id, "Not allowed in the signed-in browser.", message.sessionId) };
      // While the owner holds control (or that cannot be confirmed), nothing acts or reads.
      if (held() && HELD_REFUSED.test(message.method)) return { reply: error(message.id, HELD_TEXT, message.sessionId) };
      if (message.sessionId && !visibleSessions.has(message.sessionId)) return { reply: error(message.id, "No such session.", message.sessionId) };
      const params = message.params ?? {};
      if (TARGET_METHODS.has(message.method) && typeof params.targetId === "string" && !visible.has(params.targetId)) {
        return { reply: error(message.id, "No such target.", message.sessionId) };
      }
      if (message.method === "Target.sendMessageToTarget" || message.method === "Target.detachFromTarget") {
        if (typeof params.sessionId === "string" && !visibleSessions.has(params.sessionId)) return { reply: error(message.id, "No such session.", message.sessionId) };
      }
      if (message.method === "Browser.setWindowBounds" || message.method === "Browser.getWindowBounds") {
        if (!windows.has(params.windowId)) return { reply: error(message.id, "No such window.", message.sessionId) };
      }
      if ((message.method === "Page.navigate" || message.method === "Target.createTarget") && isExtensionUrl(params.url)) {
        return { reply: error(message.id, EXTENSION_TEXT, message.sessionId) };
      }
      if (message.method === "Target.createTarget") creating.add(message.id);
      if (message.method === "Browser.getWindowForTarget") windowCalls.add(message.id);
      return { forward: message };
    },
    fromBrowser(message) {
      if (!message || typeof message !== "object") return { deliver: [], toBrowser: [] };
      if (typeof message.id === "number" && message.id >= INTERNAL_ID_BASE) return { deliver: [], toBrowser: [] };
      if (message.id !== undefined && !message.method && !message.sessionId && creating.has(message.id)) {
        // The run's own new page: visible. Then the events held back for it come out, before the answer.
        creating.delete(message.id);
        const id = message.result?.targetId;
        if (typeof id === "string" && !hidden.has(id)) visible.add(id);
        const waitingEvents = queue;
        queue = [];
        const out = { deliver: [], toBrowser: [] };
        for (const waiting of waitingEvents) {
          if (undecided(waiting)) {
            queue.push(waiting);
            continue;
          }
          const decided = decide(waiting);
          out.deliver.push(...decided.deliver);
          out.toBrowser.push(...decided.toBrowser);
        }
        out.deliver.push(message);
        return out;
      }
      if (message.id !== undefined && windowCalls.has(message.id)) {
        windowCalls.delete(message.id);
        if (typeof message.result?.windowId === "number") windows.add(message.result.windowId);
      }
      if (undecided(message)) {
        if (queue.length >= MAX_QUEUE) return decide(message);
        queue.push(message);
        return { deliver: [], toBrowser: [] };
      }
      return decide(message);
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
 * endpoint). Returns `{ endpoint, close() }`: the endpoint to give Playwright MCP. One client at a
 * time; what it may see stays the same across its reconnects (one filter per run session).
 */
export async function startCdpFilter({ upstream, held = () => false, log = () => {}, ws = bundledWs() }) {
  const filter = createTargetFilter({ held });
  // Nothing open now is the run's: every page has to be created through this filter to be seen.
  const pages = await getJson(`${upstream}/json/list`).catch(() => []);
  log(`hiding the ${(Array.isArray(pages) ? pages : []).filter((page) => page?.type === "page").length} tab(s) open in the signed-in browser`);
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
        if (client.readyState === 1) for (const out of verdict.deliver) client.send(JSON.stringify(out));
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
