// DevTools-protocol filter between a signed-in run's Playwright MCP and the owner's Chromium (neko).
// It runs inside the run's MCP container (in neko's network namespace) and is the only DevTools
// endpoint Playwright MCP gets. It is an allowlist: the run sees only the pages it created itself
// (Target.createTarget through this filter), popups of those opened while the owner does not hold
// control, and the frames and workers attached under them. Everything else (the owner's tabs, tabs
// restored after a restart, tabs the owner opens, service workers, tab targets) is hidden:
// Playwright never attaches to it, and commands that target it are refused, as are closing the
// browser and reading or clearing every cookie. Extension targets (the password manager's service
// worker, popup, offscreen document, and the frames it puts into pages, such as Bitwarden's inline
// menu) are hidden wherever they appear, the run cannot open chrome-extension:// pages, and its
// clicks and taps are refused where they would land on an extension frame. Node's standard library
// plus the `ws` WebSocket implementation Playwright bundles.
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
 * Pages of an extension (Bitwarden's popup, inline menu, background): never the run's. Whitespace
 * and control characters are ignored and percent-encoding is undone (three rounds), as in the MCP
 * filter.
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
/** Keyboard input: refused while the focus is in (or holds) an extension frame. */
const KEY_METHODS = new Set(["Input.dispatchKeyEvent", "Input.insertText", "Input.imeSetComposition"]);
/** Name of the filter's own isolated world, where it reads the focus (page scripts cannot change what it sees). */
export const FOCUS_WORLD = "bp-focus-guard";
/**
 * Commands refused while the owner holds control (or the vault waits to be locked): anything that
 * acts on or reads a page, so a call that was on its way when the takeover began cannot act during
 * it. Session setup (enable, auto-attach, init scripts, resuming new frames) still passes.
 */
export const HELD_REFUSED =
  /^(Input\.|DOM\.(?!enable$|disable$)|DOMSnapshot\.|DOMStorage\.|IndexedDB\.|CacheStorage\.|Storage\.|Accessibility\.|Fetch\.|Page\.(navigate|reload|navigateToHistoryEntry|captureScreenshot|captureSnapshot|printToPDF|setDocumentContent|close|bringToFront|handleJavaScriptDialog|startScreencast|getResourceContent|searchInResource)$|Target\.(createTarget|closeTarget|activateTarget)$|Runtime\.(evaluate|callFunctionOn|compileScript|runScript|queryObjects|globalLexicalScopeNames|getProperties)$|Network\.(getCookies|getAllCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies|getResponseBody|getRequestPostData|replayXHR|loadNetworkResource)$|Emulation\.setTouchEmulationEnabled$)/;
export const HELD_TEXT = "The owner holds control of the signed-in browser (or it is being secured after a takeover, or its takeover state cannot be confirmed right now): not allowed now.";
/** Input that clicks or taps at a point: refused where the point is an extension frame. */
const POINTER_METHODS = new Set(["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.synthesizeTapGesture", "Input.dispatchDragEvent", "Input.emulateTouchFromMouseEvent"]);
export const EXTENSION_TEXT = "Not allowed in the signed-in browser: that is the password manager's (a browser extension's) page or frame.";
const INTERNAL_ID_BASE = 2_000_000_000;
/** Ids of the filter's own hit-test commands (above the internal ones; their answers never reach the run). */
const HIT_TEST_ID_BASE = 2_100_000_000;
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
  /** Visible sessions: session -> { targetId, parent } (parent: the session it was attached on). */
  const sessionInfo = new Map();
  /** Extension frames inside visible pages: frame target id -> the visible session it was attached on. */
  const extensionFrames = new Map();
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
      // Never the run's, also inside its own pages; remember it for the click check.
      hidden.add(id);
      if (parentSession && visibleSessions.has(parentSession)) extensionFrames.set(id, parentSession);
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

  /**
   * Whether a message on one of the run's sessions shows that its own target is an extension page now
   * (a frame attaches before its URL is known: Bitwarden's inline menu commits to its extension page
   * after Playwright attached). Such a message never reaches the run; the target is revoked first.
   */
  function revealsExtension(message) {
    const p = message.params ?? {};
    switch (message.method) {
      case "Page.frameNavigated":
        return isExtensionUrl(p.frame?.url) || isExtensionUrl(p.frame?.unreachableUrl) || isExtensionUrl(p.frame?.securityOrigin);
      case "Page.navigatedWithinDocument":
      case "Page.frameRequestedNavigation":
      case "Page.frameStartedNavigating":
        return isExtensionUrl(p.url);
      case "Runtime.executionContextCreated":
        // Only a frame's main world: an extension's content-script world in a web page has the
        // extension's origin too (it is dropped below, not a reason to revoke the page).
        return p.context?.auxData?.isDefault === true && isExtensionUrl(p.context?.origin);
      default:
        return false;
    }
  }

  function decide(message) {
    const out = { deliver: [], toBrowser: [] };
    if (message.sessionId && hiddenSessions.has(message.sessionId)) return out;
    // An extension's content-script world in one of the run's pages (Bitwarden's, in every https
    // page): the run's Playwright never uses foreign worlds, so it never learns of them.
    if (message.method === "Runtime.executionContextCreated" && message.params?.context?.auxData?.isDefault !== true && isExtensionUrl(message.params?.context?.origin)) return out;
    // The filter's own focus-reading world is not the run's.
    if (message.method === "Runtime.executionContextCreated" && message.params?.context?.name === FOCUS_WORLD) return out;
    if (message.sessionId && visibleSessions.has(message.sessionId) && revealsExtension(message)) {
      // The session's own target (or its root frame, whose id is the target's) became an extension
      // page: revoke it. Anything else that names one is just not delivered.
      const own = sessionInfo.get(message.sessionId)?.targetId;
      const frameId = message.params?.frame?.id ?? message.params?.frameId ?? message.params?.context?.auxData?.frameId;
      if (own && (frameId === undefined || frameId === own)) revoke(own, out);
      return out;
    }
    if (TARGET_EVENTS.has(message.method)) {
      const id = message.params?.targetInfo?.targetId ?? message.params?.targetId;
      if (message.method === "Target.targetDestroyed" || message.method === "Target.targetCrashed") {
        extensionFrames.delete(id);
        if (visible.has(id)) out.deliver.push(message);
        return out;
      }
      if (visible.has(id) && isExtensionUrl(message.params?.targetInfo?.url)) {
        // One of the run's targets turned into an extension page: it is gone for the run.
        revoke(id, out);
        return out;
      }
      if (isVisible(message.params?.targetInfo, message.sessionId)) out.deliver.push(message);
      return out;
    }
    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = message.params ?? {};
      if (isVisible(targetInfo, message.sessionId)) {
        visibleSessions.add(sessionId);
        sessionInfo.set(sessionId, { targetId: targetInfo.targetId, parent: message.sessionId });
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
      sessionInfo.delete(sessionId);
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

  /** Hides a visible target from now on: the run sees it detached and destroyed; Chromium detaches its sessions. */
  function revoke(targetId, out) {
    visible.delete(targetId);
    hidden.add(targetId);
    for (const [sessionId, info] of [...sessionInfo]) {
      if (info.targetId !== targetId) continue;
      // A frame inside one of the run's pages: remembered for the click check.
      if (info.parent && visibleSessions.has(info.parent)) extensionFrames.set(targetId, info.parent);
      visibleSessions.delete(sessionId);
      sessionInfo.delete(sessionId);
      hiddenSessions.add(sessionId);
      out.deliver.push({ ...(info.parent ? { sessionId: info.parent } : {}), method: "Target.detachedFromTarget", params: { sessionId, targetId } });
      out.toBrowser.push({ id: internal++, ...(info.parent ? { sessionId: info.parent } : {}), method: "Target.detachFromTarget", params: { sessionId } });
    }
    out.deliver.push({ method: "Target.targetDestroyed", params: { targetId } });
  }

  /** The visible sessions from `sessionId` up to its page (frames and workers are attached on their parent's session). */
  function chain(sessionId) {
    const out = [];
    for (let at = sessionId, guard = 0; at && guard < 32; guard++) {
      out.push(at);
      at = sessionInfo.get(at)?.parent;
    }
    return out;
  }
  function rootOf(sessionId) {
    return chain(sessionId).at(-1);
  }
  /** Frame target ids (OOPIFs) under the page of `sessionId` that hold an extension frame, and the extension frames themselves. */
  function guardedFrames(sessionId) {
    const root = rootOf(sessionId);
    const out = new Set();
    for (const [frameId, parent] of extensionFrames) {
      const up = chain(parent);
      if (up.at(-1) !== root) continue;
      out.add(frameId);
      for (const session of up) {
        const info = sessionInfo.get(session);
        if (info && info.parent) out.add(info.targetId);
      }
    }
    return out;
  }

  const error = (id, message, sessionId) => ({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } });

  /** Where a pointer command presses, taps or drags (CSS pixels of the page), or [] when it only moves. */
  function pointsOf(message) {
    const p = message.params ?? {};
    switch (message.method) {
      case "Input.dispatchMouseEvent":
      case "Input.emulateTouchFromMouseEvent":
        return p.type === "mouseMoved" || p.type === "mouseWheel" ? [] : [{ x: p.x, y: p.y }];
      case "Input.dispatchTouchEvent":
        return p.type === "touchStart" || p.type === "touchMove" || p.type === "touchEnd" ? (Array.isArray(p.touchPoints) ? p.touchPoints.map((t) => ({ x: t?.x, y: t?.y })) : []) : [];
      case "Input.synthesizeTapGesture":
      case "Input.dispatchDragEvent":
        return [{ x: p.x, y: p.y }];
      default:
        return [];
    }
  }

  return {
    isVisible: (targetId) => visible.has(targetId),
    extensionFrames: () => new Set(extensionFrames.keys()),
    /**
     * After a hit test: `nodes` are DOM.describeNode results (or null when the test failed) for the
     * points of a pointer command. Refused when any point is an extension frame, or an iframe that
     * holds one, or could not be checked.
     */
    hitAllowed(frames, nodes) {
      return nodes.every((node) => node && typeof node === "object" && !(typeof node.frameId === "string" && frames.has(node.frameId)));
    },
    refusal: (message) => error(message.id, EXTENSION_TEXT, message.sessionId),
    /** Whether the owner holds control (or the vault waits to be locked) now: checked again right before a checked input goes out. */
    isHeld: () => held(),
    heldRefusal: (message) => error(message.id, HELD_TEXT, message.sessionId),
    /**
     * After a focus check: `focused` is DOM.describeNode of document.activeElement (depth -1, shadow
     * roots pierced), or null when it could not be read. Refused when the focus is an extension frame
     * or holds one (an element whose shadow tree has one), or is unknown; the document body (no
     * focus) and ordinary elements are fine.
     */
    focusAllowed(frames, focused) {
      if (!focused || typeof focused !== "object") return false;
      if (focused.nodeName === "BODY" || focused.nodeName === "HTML" || focused.nodeName === "#document") return true;
      const stack = [focused];
      for (let guard = 0; stack.length > 0 && guard < 5000; guard++) {
        const node = stack.pop();
        if (typeof node?.frameId === "string" && frames.has(node.frameId) && (node.nodeName === "IFRAME" || node.nodeName === "FRAME" || node === focused)) return false;
        for (const key of ["children", "shadowRoots"]) if (Array.isArray(node?.[key])) stack.push(...node[key]);
        if (node?.contentDocument) stack.push(node.contentDocument);
      }
      // Not walked to the end (a huge subtree): refused.
      return stack.length === 0;
    },
    fromClient(message) {
      if (!message || typeof message !== "object" || typeof message.method !== "string") return { reply: error(message?.id ?? 0, "Malformed message.") };
      if (REFUSED_METHODS.has(message.method) || message.method.startsWith("Extensions.")) return { reply: error(message.id, "Not allowed in the signed-in browser.", message.sessionId) };
      // While the owner holds control (or the vault waits to be locked), nothing acts or reads.
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
      if (POINTER_METHODS.has(message.method) && message.sessionId) {
        const points = pointsOf(message);
        const frames = guardedFrames(message.sessionId);
        // Only pages that hold an extension frame need the check (the I/O layer asks Chromium what is
        // at each point, then calls hitAllowed).
        if (points.length > 0 && frames.size > 0) {
          if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return { reply: error(message.id, EXTENSION_TEXT, message.sessionId) };
          return { hitTest: { message, points, frames } };
        }
      }
      if (KEY_METHODS.has(message.method) && message.sessionId) {
        const frames = guardedFrames(message.sessionId);
        const frameId = sessionInfo.get(message.sessionId)?.targetId;
        // Only pages that hold an extension frame need the check (the I/O layer reads the focus in an
        // isolated world, then calls focusAllowed). No frame to read it in: refused.
        if (frames.size > 0) {
          if (!frameId) return { reply: error(message.id, EXTENSION_TEXT, message.sessionId) };
          return { focusTest: { message, frames, frameId } };
        }
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
        else if (verdict.hitTest) void hitTest(verdict.hitTest);
        else if (verdict.focusTest) void focusTest(verdict.focusTest);
        else toBrowser(verdict.forward);
      });
      /** Answers of the filter's own commands (hit tests), by id. */
      const own = new Map();
      let ownId = HIT_TEST_ID_BASE;
      const ask = (sessionId, method, params) =>
        new Promise((resolve) => {
          const id = ownId++;
          const timer = setTimeout(() => {
            own.delete(id);
            resolve(null);
          }, 3000);
          own.set(id, (answer) => {
            clearTimeout(timer);
            resolve(answer.error ? null : answer.result);
          });
          toBrowser({ id, sessionId, method, params });
        });
      // Pointer commands of one session stay in order: each waits for the one before it.
      const pointerQueues = new Map();
      /** The filter's focus world per session and frame: execution context id. */
      const worlds = new Map();
      const hitTest = ({ message, points, frames }) => {
        const before = pointerQueues.get(message.sessionId) ?? Promise.resolve();
        const done = before.then(async () => {
          const nodes = [];
          for (const point of points) {
            const hit = await ask(message.sessionId, "DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false });
            const described = hit && typeof hit.backendNodeId === "number" ? await ask(message.sessionId, "DOM.describeNode", { backendNodeId: hit.backendNodeId }) : null;
            nodes.push(described?.node ?? null);
          }
          // The checks took a moment: a takeover that began meanwhile wins.
          if (filter.isHeld()) {
            if (client.readyState === 1) client.send(JSON.stringify(filter.heldRefusal(message)));
          } else if (filter.hitAllowed(frames, nodes)) toBrowser(message);
          else if (client.readyState === 1) {
            log("refused a click or tap on an extension frame");
            client.send(JSON.stringify(filter.refusal(message)));
          }
        });
        pointerQueues.set(message.sessionId, done.catch(() => undefined));
      };
      // Keys: where is the focus? Read in the filter's own isolated world (page scripts cannot fake
      // document.activeElement there), described with shadow roots pierced. In the same queue as
      // pointer input, so input stays in order.
      const focusTest = ({ message, frames, frameId }) => {
        const before = pointerQueues.get(message.sessionId) ?? Promise.resolve();
        const done = before.then(async () => {
          let focused = null;
          const read = async (contextId) => ask(message.sessionId, "Runtime.evaluate", { contextId, expression: "document.activeElement || document.body", returnByValue: false });
          // The world is made once per frame and document; a navigation (or a gone context) makes a new one.
          const key = `${message.sessionId}|${frameId}`;
          let contextId = worlds.get(key);
          let active = contextId ? await read(contextId) : null;
          if (!active?.result?.objectId) {
            const world = await ask(message.sessionId, "Page.createIsolatedWorld", { frameId, worldName: FOCUS_WORLD });
            contextId = world?.executionContextId;
            if (contextId) worlds.set(key, contextId);
            else worlds.delete(key);
            active = contextId ? await read(contextId) : null;
          }
          const objectId = active?.result?.objectId;
          if (objectId) {
            focused = (await ask(message.sessionId, "DOM.describeNode", { objectId, depth: -1, pierce: true }))?.node ?? null;
            await ask(message.sessionId, "Runtime.releaseObject", { objectId });
          }
          if (filter.isHeld()) {
            if (client.readyState === 1) client.send(JSON.stringify(filter.heldRefusal(message)));
          } else if (filter.focusAllowed(frames, focused)) toBrowser(message);
          else if (client.readyState === 1) {
            log("refused keyboard input into an extension frame");
            client.send(JSON.stringify(filter.refusal(message)));
          }
        });
        pointerQueues.set(message.sessionId, done.catch(() => undefined));
      };
      browser.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof message.id === "number" && own.has(message.id)) {
          const answer = own.get(message.id);
          own.delete(message.id);
          answer(message);
          return;
        }
        if (message.method === "Runtime.executionContextsCleared" || message.method === "Runtime.executionContextDestroyed") {
          for (const [key, contextId] of worlds) {
            if (!key.startsWith(`${message.sessionId}|`)) continue;
            if (message.method === "Runtime.executionContextsCleared" || message.params?.executionContextId === contextId) worlds.delete(key);
          }
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
