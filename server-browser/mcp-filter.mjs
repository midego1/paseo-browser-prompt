// Filters the MCP stdio stream between the agent and Playwright MCP inside the browser container.
// Only the tools in ALLOWED_TOOLS (the same list as SERVER_BROWSER_TOOLS in shared/agent-prompt.ts;
// a test keeps them equal) are listed and callable; every other tool is removed from tools/list and
// refused in tools/call. DENIED_TOOLS is a second check for the ones that must never pass:
// browser_run_code_unsafe runs code in the Playwright server process, browser_file_upload and
// browser_drop pick files; Playwright MCP has no option to leave them out. Messages are
// newline-delimited JSON-RPC objects; batches (arrays), other JSON values and non-JSON lines are
// dropped in both directions.

export const ALLOWED_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_wait_for",
  "browser_navigate_back",
  "browser_handle_dialog",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_evaluate",
  "browser_find",
  "browser_resize",
  "browser_close",
]);

export const DENIED_TOOLS = new Set(["browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install"]);

/**
 * Tools a signed-in run does not get on top of that (the same list as SIGNED_IN_REMOVED_TOOLS in
 * shared/agent-prompt.ts; a test keeps them equal): they read page script state of a browser that
 * holds the owner's sessions. browser_evaluate runs page JavaScript (cookies, storage, input values
 * the owner types, a keylogger left behind), browser_console_messages and browser_network_requests
 * show what pages log and send.
 */
export const SIGNED_IN_REMOVED_TOOLS = new Set(["browser_evaluate", "browser_console_messages", "browser_network_requests"]);
export const SIGNED_IN_ALLOWED_TOOLS = new Set([...ALLOWED_TOOLS].filter((name) => !SIGNED_IN_REMOVED_TOOLS.has(name)));

export const DENIED_TEXT = "This tool is turned off in the browser-prompt Server browser.";

/** What a tool call that names a chrome-extension:// page gets (a password manager's pages are never the agent's). */
export const EXTENSION_URL_TEXT =
  "Browser extension pages (chrome-extension://) are not available in the browser-prompt Server browser. Never open or use the password manager: ask the owner to take over for logins and passkeys.";

/** Whether any string in a tool call's arguments names an extension page (chrome-extension:, also percent-encoded). */
export function namesExtensionPage(args) {
  const seen = [];
  const visit = (value, depth) => {
    if (depth > 6) return false;
    if (typeof value === "string") {
      let text = value;
      for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) {
        try {
          text = decodeURIComponent(text);
        } catch {
          break;
        }
      }
      return /chrome-extension:/i.test(text.replace(/[\s\u0000-\u001f]+/g, ""));
    }
    if (!value || typeof value !== "object" || seen.includes(value)) return false;
    seen.push(value);
    return Object.values(value).some((item) => visit(item, depth + 1));
  };
  return visit(args, 0);
}

/** Tools whose arguments open a page. */
const NAVIGATING_TOOLS = new Set(["browser_navigate", "browser_tabs"]);

/** Whether a tool may be listed and called: on the (signed-in) allowlist and not on the denylist. */
export function toolAllowed(name, signedIn = false) {
  const allowed = signedIn ? SIGNED_IN_ALLOWED_TOOLS : ALLOWED_TOOLS;
  return typeof name === "string" && allowed.has(name) && !DENIED_TOOLS.has(name);
}

/** The line as a JSON-RPC object, or null for anything else (batches, other JSON, non-JSON). */
function parseObject(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** What a signed-in run's tool call gets while the owner holds control of the browser (Take over). */
export const OWNER_CONTROL_TEXT =
  "The owner has taken over the signed-in browser and holds control right now (or the takeover just ended and the browser is being secured for a few seconds), so browser tools are paused (no reading and no actions). Do not retry in a loop: ask the owner with AskUserQuestion to answer \"done\" when they are finished and have released control (tap the mouse icon again or close the viewer), then take a new snapshot and continue.";

/** What a tool call gets while the vault is being locked after a takeover or a start (nobody holds control). */
export const SECURING_TEXT =
  "The signed-in browser is being secured right now (its password manager is being locked after a takeover or a start); this takes a few seconds. Wait about 5 seconds and try the same call again. Do not ask the owner about it unless it still fails after a minute.";

/** What a tool call gets when the vault could not be locked after a takeover: only the owner can fix it. */
export const LOCK_FAILED_TEXT =
  "The signed-in browser stays paused for safety: its password manager (Bitwarden) could not be locked after the takeover. Only the owner can fix this. Ask the owner with AskUserQuestion to press Lock Bitwarden now or Restart browser on the card (or in the plugin settings), and to check Bitwarden's vault timeout (not Never), then answer \"done\". Wait for that answer and try again; do not retry in a loop.";

/**
 * What a tool call gets while the takeover state cannot be confirmed: before the first status from
 * the relay, after a failed poll, or when the last status is invalid or too old (fail closed).
 */
export const UNAVAILABLE_TEXT =
  "The signed-in browser is paused for safety: the plugin cannot confirm right now that the owner is not holding control of it (the takeover state is still being checked, or the browser's relay does not answer). Browser tools stay paused until that is confirmed. Wait about 5 seconds and try the same call again. Do not retry in a tight loop; if it still fails after a minute, ask the owner with AskUserQuestion to press Restart browser on the card (or in the plugin settings) and answer \"done\".";

/** The refusal for a tool call while the guard is held, by why it is held. */
function refusalText({ securing = false, lockFailed = false, unavailable = false } = {}) {
  return lockFailed ? LOCK_FAILED_TEXT : securing ? SECURING_TEXT : unavailable ? UNAVAILABLE_TEXT : OWNER_CONTROL_TEXT;
}

/** The refusal that fits a guard's current state (see createControlGuard). */
export function heldText(guard) {
  return refusalText({ securing: guard.securing(), lockFailed: guard.lockFailed(), unavailable: guard.unavailable() });
}

/**
 * A message from the agent: `{ forward }` to pass it on, `{ reply }` to answer it here, or
 * `{ drop: true }` to discard it. With `ownerControl` (signed-in runs, whenever the takeover guard is
 * held: the owner holds control in the viewer, or release is not confirmed) every tool call is
 * answered with a refusal (OWNER_CONTROL_TEXT, SECURING_TEXT, LOCK_FAILED_TEXT or UNAVAILABLE_TEXT)
 * instead of reaching the browser. Other messages (initialize, tools/list) do not touch the browser
 * and pass.
 */
export function filterClientLine(line, { ownerControl = false, securing = false, lockFailed = false, unavailable = false, signedIn = false } = {}) {
  const message = parseObject(line);
  if (!message) return { drop: true };
  if (ownerControl && message.method === "tools/call") {
    if (message.id === undefined || message.id === null) return { drop: true };
    const text = refusalText({ securing, lockFailed, unavailable });
    return { reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: true } }) };
  }
  if (message.method === "tools/call" && !toolAllowed(message.params?.name, signedIn)) {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: DENIED_TEXT }], isError: true } }),
    };
  }
  if (message.method === "tools/call" && NAVIGATING_TOOLS.has(message.params?.name) && namesExtensionPage(message.params?.arguments)) {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: EXTENSION_URL_TEXT }], isError: true } }),
    };
  }
  return { forward: line };
}

/** A message from Playwright MCP: tools/list results keep only allowed tools; non-objects are dropped (null). */
export function filterServerLine(line, { signedIn = false } = {}) {
  const message = parseObject(line);
  if (!message) return null;
  const tools = message.result?.tools;
  if (!Array.isArray(tools)) return line;
  const kept = tools.filter((tool) => toolAllowed(tool?.name, signedIn));
  if (kept.length === tools.length) return line;
  return JSON.stringify({ ...message, result: { ...message.result, tools: kept } });
}

/** Splits a byte stream into lines and calls `onLine` for each complete one. */
export function lineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
      }
    },
    end() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

/**
 * The owner's takeover state as a signed-in run sees it. It fails closed: tools are paused (held)
 * until a valid relay status confirms release, and paused again as soon as that confirmation is
 * missing.
 *
 * - It starts held: nothing reaches the browser before the first valid status.
 * - A status is valid only when the body is a JSON object whose `ownerControl` is a boolean.
 *   `ownerControl: false` (strictly) releases; `true` holds; anything else (missing, not a boolean,
 *   not an object) holds, as unknown.
 * - A failed poll (relay unreachable, timeout, an error status, a body that is not JSON) holds. There
 *   is no number of failures after which it opens.
 * - A release is only good for `maxAgeMs` after it arrived: without a newer valid release it counts
 *   as unavailable and holds (`held()` checks the age on every call, also between polls).
 * - Results carry a sequence number from `next()`; a result or failure older than the last applied
 *   one is ignored, so a slow poll cannot overwrite a newer state.
 */
export function createControlGuard({ now = Date.now, maxAgeMs = 3000 } = {}) {
  let releasedAt = -Infinity;
  let released = false;
  let securing = false;
  let lockFailed = false;
  /** Paused because no valid status is at hand (none yet, a failed poll, an invalid body). */
  let unavailable = true;
  let issued = 0;
  let applied = 0;
  const fresh = () => released && now() - releasedAt <= maxAgeMs;
  return {
    /** Sequence number for the next poll. */
    next: () => ++issued,
    result(seq, body) {
      if (!Number.isSafeInteger(seq) || seq <= applied) return;
      applied = seq;
      const valid = body !== null && typeof body === "object" && !Array.isArray(body) && typeof body.ownerControl === "boolean";
      unavailable = !valid;
      released = valid && body.ownerControl === false;
      releasedAt = released ? now() : -Infinity;
      securing = valid && !released && body.securing === true;
      lockFailed = valid && !released && body.lockFailed === true;
    },
    failure(seq) {
      if (!Number.isSafeInteger(seq) || seq <= applied) return;
      applied = seq;
      unavailable = true;
      released = false;
      releasedAt = -Infinity;
      securing = false;
      lockFailed = false;
    },
    /** Whether tool calls are paused: true unless a valid, recent status said `ownerControl: false`. */
    held: () => !fresh(),
    /** Held only because the vault is being locked (nobody holds control). */
    securing: () => !fresh() && securing,
    /** Held because the vault could not be locked: the owner has to act. */
    lockFailed: () => !fresh() && lockFailed,
    /** Held because the takeover state cannot be confirmed (no status yet, a failed poll, an invalid or stale one). */
    unavailable: () => !fresh() && (unavailable || released),
  };
}

/**
 * Tool calls on their way through Playwright MCP. A result that arrives while the guard is held, or
 * whose call overlapped a held period, is replaced with a refusal (OWNER_CONTROL_TEXT, or `text`),
 * so a call that started before a takeover cannot hand back what the owner typed.
 */
export function createCallTracker() {
  /** JSON of the request id -> whether the owner held control while it ran */
  const pending = new Map();
  return {
    started(line) {
      const message = parseObject(line);
      if (message?.method === "tools/call" && message.id !== undefined && message.id !== null) pending.set(JSON.stringify(message.id), false);
    },
    markHeld() {
      for (const key of pending.keys()) pending.set(key, true);
    },
    finish(line, heldNow, text = OWNER_CONTROL_TEXT) {
      const message = parseObject(line);
      if (!message || message.id === undefined || message.id === null || message.method) return line;
      const key = JSON.stringify(message.id);
      if (!pending.has(key)) return line;
      const during = pending.get(key);
      pending.delete(key);
      if (!heldNow && !during) return line;
      return JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: true } });
    },
    size: () => pending.size,
  };
}

/**
 * One poll of the relay's takeover state into `guard` (signed-in runs; never two at once: a call
 * while one runs does nothing). A response that is not 2xx, not JSON, or not a valid status, a
 * timeout or an unreachable relay all count as a failed poll: held. `fetchImpl` and `log` are for tests.
 */
export function createControlPoller({ guard, calls, url, fetchImpl = fetch, timeoutMs = 1500, log = () => {} }) {
  let polling = false;
  let warned = false;
  return async function poll() {
    if (polling) return;
    polling = true;
    const seq = guard.next();
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      guard.result(seq, await response.json());
      if (guard.unavailable()) throw new Error("not a valid takeover state");
      warned = false;
    } catch {
      guard.failure(seq);
      if (!warned) log("could not read a valid takeover state from the relay; browser tools are paused");
      warned = true;
    } finally {
      polling = false;
      if (guard.held()) calls.markHeld();
    }
  };
}

/**
 * The stdio filter of one run, both directions. `guard` is the signed-in run's takeover guard (null
 * for the clean Server browser, which no owner can take over). `client(line)` returns
 * filterClientLine's verdict; a forwarded tool call is tracked. `server(line)` returns the line to
 * pass on or null; a tool result that arrives while held, or whose call overlapped a held period, is
 * replaced with the refusal for the guard's state.
 */
export function createRunFilter({ signedIn = false, guard = null, calls = createCallTracker() } = {}) {
  if (signedIn && !guard) throw new Error("a signed-in run needs the takeover guard");
  const state = () => (guard ? { ownerControl: guard.held(), securing: guard.securing(), lockFailed: guard.lockFailed(), unavailable: guard.unavailable() } : { ownerControl: false });
  return {
    client(line) {
      const verdict = filterClientLine(line, { ...state(), signedIn });
      if ("forward" in verdict && guard) calls.started(verdict.forward);
      return verdict;
    },
    server(line) {
      const kept = filterServerLine(line, { signedIn });
      if (kept === null || !guard) return kept;
      return calls.finish(kept, guard.held(), heldText(guard));
    },
  };
}
