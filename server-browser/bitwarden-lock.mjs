// Locks Bitwarden in the signed-in Server browser and verifies it, for the daemon (never the run's
// agent). It runs in a short-lived container that joins neko's network namespace (like the run's
// MCP container, but started by the daemon, with its own direct DevTools connection to Chromium on
// neko's loopback, not through the agent's filter) and prints one JSON line.
//
//   node bitwarden-lock.mjs status  <id>   -> every Bitwarden account's state, nothing changed
//   node bitwarden-lock.mjs lock    <id>   -> Bitwarden's own "lock all accounts" (it then reloads
//                                             itself), then verify
//   node bitwarden-lock.mjs reload  <id>   -> chrome.runtime.reload() (clears chrome.storage.session,
//                                             where Bitwarden keeps the key of its unlocked session),
//                                             then verify
//   node bitwarden-lock.mjs restart        -> closes Chromium; neko's supervisor starts it again
//                                             (logins kept, every in-memory key gone)
//   node bitwarden-lock.mjs cleanup <ids>  -> clears the storage of Bitwarden builds no longer
//                                             installed (their chrome-extension:// origins)
//
// <id> is the extension id of the installed Bitwarden build (made per image build).
// Verification asks Bitwarden's service worker for the authentication status of every account
// (0 logged out, 1 locked, 2 unlocked) and counts as locked only when it answers and no account is
// unlocked. It does not depend on keyboard focus, the desktop, or what a page does. A reload also
// checks that a marker it put into chrome.storage.session is gone afterwards (the session storage
// was really cleared). Node's standard library only (global fetch and WebSocket).

const UNLOCKED = 2;
const EXTENSION_ID = /^[a-p]{32}$/;

/** Bitwarden's authentication status of every account, in its service worker (internal API of the pinned version; the smoke test checks it). */
export const STATUS_EXPRESSION = `(async () => {
  const main = self.bitwardenMain && self.bitwardenMain.ossMain;
  if (!main || !main.authService || !main.authService.authStatuses$) return { ready: false };
  const statuses = await new Promise((resolve, reject) => {
    let sub = null;
    let done = false;
    const timer = setTimeout(() => { done = true; sub && sub.unsubscribe(); reject(new Error("no status")); }, 4000);
    sub = main.authService.authStatuses$.subscribe((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
      queueMicrotask(() => sub && sub.unsubscribe());
    });
    if (done && sub) sub.unsubscribe();
  });
  // A map of account id to status (an array of { userId, status } in other versions).
  const list = Array.isArray(statuses) ? statuses.map((s) => s && s.status) : Object.values(statuses || {});
  return { ready: true, statuses: list.map((status) => ({ status: Number(status) })) };
})()`;
export const LOCK_EXPRESSION = `(async () => {
  const main = self.bitwardenMain && self.bitwardenMain.ossMain;
  if (!main || !main.lockService || typeof main.lockService.lockAll !== "function") return { locked: false, reason: "no lock service" };
  await main.lockService.lockAll("browser-prompt");
  return { locked: true };
})()`;

/** Whether a status answer shows Bitwarden locked: it answered, and no account is unlocked. */
export function isLocked(answer) {
  return !!answer && answer.ready === true && Array.isArray(answer.statuses) && answer.statuses.every((s) => s && Number.isInteger(s.status) && s.status !== UNLOCKED);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A raw DevTools connection to the browser target (flattened sessions). */
async function connect(endpoint) {
  const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
    }
  });
  const send = (method, params = {}, sessionId, timeoutMs = 8000) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `timeout: ${method}` } });
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => ws.close() };
}

/** Bitwarden's service worker target, woken by opening (and closing) its popup page in the background when it is not running. */
async function serviceWorker(cdp, id, { except = null, waitMs = 20_000 } = {}) {
  const find = async () => {
    const { result } = await cdp.send("Target.getTargets");
    return (result?.targetInfos ?? []).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${id}/`) && t.targetId !== except) ?? null;
  };
  const until = Date.now() + waitMs;
  let woke = null;
  let sw = await find();
  while (!sw && Date.now() < until) {
    if (!woke) woke = (await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/popup/index.html`, background: true })).result?.targetId ?? "failed";
    await sleep(500);
    sw = await find();
  }
  if (woke && woke !== "failed") await cdp.send("Target.closeTarget", { targetId: woke });
  return sw;
}

async function evaluate(cdp, sessionId, expression, timeoutMs = 8000) {
  const answer = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
  if (answer.error) return { error: answer.error.message };
  if (answer.result?.exceptionDetails) return { error: answer.result.exceptionDetails.exception?.description?.split("\n")[0] ?? "exception" };
  return answer.result?.result?.value ?? null;
}

async function attach(cdp, targetId) {
  const { result, error } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  if (error || !result?.sessionId) return null;
  await cdp.send("Runtime.runIfWaitingForDebugger", {}, result.sessionId);
  return result.sessionId;
}

/** Status of the running Bitwarden, retried while it is still starting (after a reload or a browser start). */
async function status(cdp, id, { except = null, waitMs = 25_000 } = {}) {
  const until = Date.now() + waitMs;
  let last = { ready: false, reason: "no service worker" };
  while (Date.now() < until) {
    const sw = await serviceWorker(cdp, id, { except, waitMs: Math.max(1000, until - Date.now()) });
    if (!sw) return { ready: false, reason: "no service worker" };
    const session = await attach(cdp, sw.targetId);
    if (session) {
      last = (await evaluate(cdp, session, STATUS_EXPRESSION)) ?? { ready: false };
      await cdp.send("Target.detachFromTarget", { sessionId: session });
      if (last.ready === true) return { ...last, targetId: sw.targetId };
    }
    await sleep(1000);
  }
  return last;
}

export async function run(mode, args = [], endpoint = "http://127.0.0.1:9222") {
  const ids = args.filter((value) => EXTENSION_ID.test(value));
  if (ids.length !== args.length) return { mode, locked: false, detail: "bad extension id" };
  const id = ids[0];
  if (["status", "lock", "reload"].includes(mode) && ids.length !== 1) return { mode, locked: false, detail: "one extension id needed" };
  const cdp = await connect(endpoint);
  try {
    if (mode === "status") {
      const answer = await status(cdp, id);
      return { mode, locked: isLocked(answer), statuses: answer.statuses ?? null, detail: answer.reason ?? answer.error ?? "" };
    }
    if (mode === "lock") {
      const sw = await serviceWorker(cdp, id);
      if (!sw) return { mode, locked: false, detail: "no service worker" };
      const session = await attach(cdp, sw.targetId);
      // Bitwarden reloads itself after locking when no account is unlocked: its answer may never come.
      const lock = session ? await evaluate(cdp, session, LOCK_EXPRESSION, 15_000) : { error: "attach failed" };
      if (session) await cdp.send("Target.detachFromTarget", { sessionId: session }, undefined, 3000);
      await sleep(1500);
      const answer = await status(cdp, id, { waitMs: 40_000 });
      const timedOut = typeof lock?.error === "string" && /^timeout/.test(lock.error);
      return {
        mode,
        locked: (lock?.locked === true || timedOut) && isLocked(answer),
        reloaded: !!answer.targetId && answer.targetId !== sw.targetId,
        statuses: answer.statuses ?? null,
        detail: (timedOut ? "" : lock?.error ?? lock?.reason) || answer.reason || answer.error || "",
      };
    }
    if (mode === "reload") {
      const sw = await serviceWorker(cdp, id);
      if (!sw) return { mode, locked: false, detail: "no service worker" };
      const session = await attach(cdp, sw.targetId);
      if (!session) return { mode, locked: false, detail: "attach failed" };
      const marker = `bp-${Math.random().toString(36).slice(2)}`;
      await evaluate(cdp, session, `chrome.storage.session.set({ bpLockMarker: ${JSON.stringify(marker)} }).then(() => true)`);
      // The worker goes away with the reload; its answer may never come.
      await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => chrome.runtime.reload(), 50); true", returnByValue: true }, session, 3000);
      const answer = await status(cdp, id, { except: sw.targetId, waitMs: 40_000 });
      let cleared = false;
      if (answer.targetId) {
        const fresh = await attach(cdp, answer.targetId);
        const value = fresh ? await evaluate(cdp, fresh, `chrome.storage.session.get("bpLockMarker").then((v) => v.bpLockMarker ?? null)`) : { error: "attach failed" };
        if (fresh) await cdp.send("Target.detachFromTarget", { sessionId: fresh }, undefined, 3000);
        cleared = value === null;
      }
      return { mode, locked: cleared && isLocked(answer), cleared, statuses: answer.statuses ?? null, detail: answer.reason ?? answer.error ?? "" };
    }
    if (mode === "restart") {
      // neko's supervisor restarts Chromium (autorestart), with the profile and its logins.
      await cdp.send("Browser.close", {}, undefined, 5000);
      return { mode, locked: false, restarted: true, detail: "" };
    }
    if (mode === "cleanup") {
      // The Storage domain works on a page's session: a blank background tab, closed right after.
      const page = (await cdp.send("Target.createTarget", { url: "about:blank", background: true })).result?.targetId;
      const session = page ? await attach(cdp, page) : null;
      const cleared = [];
      if (session) {
        for (const old of ids) {
          const byOrigin = await cdp.send("Storage.clearDataForOrigin", { origin: `chrome-extension://${old}`, storageTypes: "all" }, session);
          const byKey = await cdp.send("Storage.clearDataForStorageKey", { storageKey: `chrome-extension://${old}/`, storageTypes: "all" }, session);
          if (!byOrigin.error && !byKey.error) cleared.push(old);
        }
      }
      if (page) await cdp.send("Target.closeTarget", { targetId: page });
      return { mode, locked: false, cleared, detail: session ? "" : "no page session" };
    }
    return { mode, locked: false, detail: "unknown mode" };
  } finally {
    cdp.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "status";
  const timer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ mode, locked: false, detail: "timeout" })}\n`);
    process.exit(2);
  }, 90_000);
  run(mode, process.argv.slice(3))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => process.stdout.write(`${JSON.stringify({ mode, locked: false, detail: error instanceof Error ? error.message : String(error) })}\n`))
    .finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
}
