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

/**
 * What a tool call's result is replaced with when the takeover state could not be confirmed while
 * the call ran (a failed, invalid or stale status, and no confirmation within a few seconds after).
 */
export const UNCONFIRMED_TEXT =
  "The browser status could not be confirmed while this call ran, so its result is withheld. The call may have been carried out: take a snapshot before you repeat it.";

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

/** Longest line the agent may send (requests are small); longer ones are dropped whole, never in part. */
export const MAX_CLIENT_LINE = 8 * 1024 * 1024;
/** Longest line Playwright MCP may send (a screenshot result is a few MB at most). */
export const MAX_SERVER_LINE = 32 * 1024 * 1024;

/**
 * Splits a byte stream into lines and calls `onLine` for each complete one. A line longer than
 * `maxLength` is dropped whole (its start is never passed on, the rest up to the next newline is
 * skipped) and `onOverflow` is called once for it.
 */
export function lineSplitter(onLine, { maxLength = MAX_CLIENT_LINE, onOverflow = () => {} } = {}) {
  let buffer = "";
  let skipping = false;
  return {
    push(chunk) {
      let text = String(chunk);
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const piece = text.slice(0, index);
        text = text.slice(index + 1);
        if (skipping) {
          skipping = false;
          buffer = "";
          continue;
        }
        const line = buffer + piece;
        buffer = "";
        if (line.length > maxLength) onOverflow();
        else onLine(line);
      }
      if (skipping) return;
      buffer += text;
      if (buffer.length > maxLength) {
        buffer = "";
        skipping = true;
        onOverflow();
      }
    },
    end() {
      if (buffer && !skipping) onLine(buffer);
      buffer = "";
      skipping = false;
    },
  };
}

/**
 * The signed-in run's polling of the relay's takeover state. A release is good for
 * CONTROL_MAX_AGE_MS from the relay's own read of neko: one poll's timeout, two poll intervals and
 * one relay poll interval (the relay reads neko every RELAY_CONTROL_POLL_MS), so a healthy relay
 * always refreshes it in time and a stalled one cannot keep it open.
 */
export const CONTROL_POLL = Object.freeze({ intervalMs: 500, timeoutMs: 1500 });
export const RELAY_CONTROL_POLL_MS = 500;
export const CONTROL_MAX_AGE_MS = CONTROL_POLL.timeoutMs + 2 * CONTROL_POLL.intervalMs + RELAY_CONTROL_POLL_MS;

/** A release status from the relay: everything the guard needs, or null (then the status is invalid). */
function parseStatus(body, askedAt) {
  if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.ownerControl !== "boolean") return null;
  const bootId = typeof body.bootId === "string" && /^[0-9a-f]{1,64}$/.test(body.bootId) ? body.bootId : null;
  const epoch = Number.isSafeInteger(body.epoch) && body.epoch >= 0 ? body.epoch : null;
  if (body.ownerControl) return { ownerControl: true, securing: body.securing === true, lockFailed: body.lockFailed === true, bootId, epoch, sampledAt: askedAt };
  const ago = body.sampledAgoMs;
  if (bootId === null || epoch === null || typeof ago !== "number" || !Number.isFinite(ago) || ago < 0) return null;
  return { ownerControl: false, securing: false, lockFailed: false, bootId, epoch, sampledAt: askedAt - ago };
}

/**
 * The owner's takeover state as a signed-in run sees it. It fails closed: tools are paused (held)
 * until a valid relay status confirms release, and paused again as soon as that confirmation is
 * missing.
 *
 * - It starts held: nothing reaches the browser before the first valid status.
 * - A status is valid only when the body is a JSON object whose `ownerControl` is a boolean; a
 *   release (`ownerControl` strictly `false`) also needs the relay's `bootId`, control `epoch` and
 *   `sampledAgoMs` (the age of its read of neko). `true` holds; anything else (missing, not a
 *   boolean, not an object, a release without those fields) holds, as unknown.
 * - A failed poll (relay unreachable, timeout, an error status, a body that is not JSON) holds. There
 *   is no number of failures after which it opens.
 * - A release is good for `maxAgeMs` counted from the relay's read of neko (the poll's start minus
 *   `sampledAgoMs`), on a monotonic clock; older, or a clock that went backwards, counts as
 *   unavailable and holds (`held()` checks the age on every call, also between polls).
 * - Results carry a sequence number from `next()`; a result or failure older than the last applied
 *   one, or with a number `next()` did not hand out, is ignored.
 */
export function createControlGuard({ now = () => performance.now(), maxAgeMs = CONTROL_MAX_AGE_MS } = {}) {
  /** The last valid status, or null (none yet, or the last poll failed or was invalid). */
  let status = null;
  const issuedAt = new Map();
  let issued = 0;
  let applied = 0;
  const fresh = () => {
    if (!status || status.ownerControl) return false;
    const age = now() - status.sampledAt;
    return age >= 0 && age <= maxAgeMs;
  };
  /** The issue time of `seq` (undefined when stale or unknown); forgets it and every older one. */
  const take = (seq) => {
    if (!Number.isSafeInteger(seq) || seq <= applied || !issuedAt.has(seq)) return undefined;
    const at = issuedAt.get(seq);
    for (const key of issuedAt.keys()) if (key <= seq) issuedAt.delete(key);
    applied = seq;
    return at;
  };
  const reason = () => (fresh() ? "released" : status?.ownerControl ? (status.lockFailed ? "lockFailed" : status.securing ? "securing" : "owner") : "unavailable");
  return {
    /** Sequence number for the next poll (its start time is kept for the release's age). */
    next() {
      const seq = ++issued;
      issuedAt.set(seq, now());
      if (issuedAt.size > 64) issuedAt.delete(issuedAt.keys().next().value);
      return seq;
    },
    result(seq, body) {
      const at = take(seq);
      if (at === undefined) return;
      status = parseStatus(body, at);
    },
    failure(seq) {
      if (take(seq) === undefined) return;
      status = null;
    },
    /** Whether tool calls are paused: true unless a valid, recent status said `ownerControl: false`. */
    held: () => !fresh(),
    /** Why: "released", "owner" (holds control), "securing" (vault being locked), "lockFailed", or "unavailable" (no valid, recent status). */
    reason,
    /** Held only because the vault is being locked (nobody holds control). */
    securing: () => reason() === "securing",
    /** Held because the vault could not be locked: the owner has to act. */
    lockFailed: () => reason() === "lockFailed",
    /** Held because the takeover state cannot be confirmed (no status yet, a failed poll, an invalid or stale one). */
    unavailable: () => reason() === "unavailable",
    /** The relay start and control epoch of the current release, or null while held. */
    confirmation: () => (fresh() ? { bootId: status.bootId, epoch: status.epoch } : null),
  };
}

/** How bad what happened while a call ran is: its result is passed, buffered, or replaced by the text. */
const MARK = Object.freeze({ none: 0, unconfirmed: 1, lost: 2, owner: 3, lockFailed: 4 });
const MARK_TEXT = [null, UNCONFIRMED_TEXT, UNCONFIRMED_TEXT, OWNER_CONTROL_TEXT, LOCK_FAILED_TEXT];

/** Whether a JSON-RPC id may be used for a request here: a string or a finite number. */
export function validRequestId(id) {
  return (typeof id === "string" && id.length <= 200) || (typeof id === "number" && Number.isFinite(id));
}

/**
 * Requests of a signed-in run on their way through Playwright MCP, by id. A request id may be in
 * flight once (a second request with it is refused before it is forwarded), and an answer from
 * Playwright MCP passes only when it answers a tracked request (anything else is dropped). For each
 * tool call it keeps the relay start and control epoch it began under and the worst thing seen while
 * it ran (`sync`, after every poll and before every decision):
 *
 * - The owner held control, or the vault was being locked (a real `ownerControl: true`), or the
 *   epoch or relay start changed (a takeover began and ended between two polls, or the relay
 *   restarted): its result is withheld (OWNER_CONTROL_TEXT, LOCK_FAILED_TEXT, UNCONFIRMED_TEXT).
 * - The status was only unavailable (a failed, invalid or stale poll): the call is *unconfirmed*. A
 *   result that arrives then is buffered for at most `bufferMs`; the next valid release under the
 *   same relay start and epoch confirms that no takeover happened and lets it (and the call's later
 *   result) through; otherwise it is replaced with UNCONFIRMED_TEXT.
 */
export function createCallTracker({ now = () => performance.now(), bufferMs = 5000, maxPending = 256, maxBuffered = 16, emit = () => {} } = {}) {
  /** JSON of the id -> { id, call, confirm, mark, buffered } */
  const pending = new Map();
  /** Cancelled ids (the agent gave up on them): a late answer is dropped, the id is not reused meanwhile. */
  const retired = new Set();
  let buffered = 0;
  const refusal = (id, mark) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: MARK_TEXT[mark] }], isError: true } });
  const raise = (entry, mark) => {
    if (mark > entry.mark) entry.mark = mark;
  };
  const settle = (key, entry, line) => {
    pending.delete(key);
    if (entry.buffered) buffered--;
    entry.buffered = null;
    return line;
  };
  const tracker = {
    /** Whether this id is in flight (or cancelled and maybe still running). */
    known: (id) => pending.has(JSON.stringify(id)) || retired.has(JSON.stringify(id)),
    full: () => pending.size >= maxPending,
    /** A request that was forwarded (`confirm`: the guard's confirmation then). */
    started(message, confirm) {
      pending.set(JSON.stringify(message.id), { id: message.id, call: message.method === "tools/call", confirm, mark: MARK.none, buffered: null });
    },
    /** The agent cancelled a request: Playwright MCP may never answer it. */
    cancel(id) {
      if (!validRequestId(id)) return;
      const key = JSON.stringify(id);
      const entry = pending.get(key);
      if (!entry) return;
      settle(key, entry, null);
      retired.add(key);
      if (retired.size > 1000) retired.delete(retired.keys().next().value);
    },
    /** Updates every tool call with the guard's state, and releases or replaces buffered results. */
    sync(guard) {
      const reason = guard.reason();
      const confirm = guard.confirmation();
      for (const [key, entry] of pending) {
        if (!entry.call) continue;
        if (reason === "owner" || reason === "securing") raise(entry, MARK.owner);
        else if (reason === "lockFailed") raise(entry, MARK.lockFailed);
        else if (reason === "unavailable") raise(entry, MARK.unconfirmed);
        else if (!entry.confirm || !confirm || confirm.bootId !== entry.confirm.bootId) raise(entry, MARK.lost);
        else if (confirm.epoch !== entry.confirm.epoch) raise(entry, MARK.owner);
        else if (entry.mark === MARK.unconfirmed) entry.mark = MARK.none;
        if (!entry.buffered) continue;
        if (entry.mark === MARK.none) emit(settle(key, entry, entry.buffered.line));
        else if (entry.mark >= MARK.lost) emit(settle(key, entry, refusal(entry.id, entry.mark)));
        else if (now() - entry.buffered.at > bufferMs || now() < entry.buffered.at) emit(settle(key, entry, refusal(entry.id, MARK.unconfirmed)));
      }
    },
    /** An answer from Playwright MCP: the line to pass on now, or null (dropped, or buffered for `sync`). */
    finish(line, guard) {
      const message = parseObject(line);
      if (!message) return null;
      if (message.method !== undefined) return line;
      if (!validRequestId(message.id)) return null;
      const key = JSON.stringify(message.id);
      const entry = pending.get(key);
      if (!entry) {
        retired.delete(key);
        return null;
      }
      if (entry.buffered) return null;
      if (!entry.call) return settle(key, entry, line);
      tracker.sync(guard);
      if (entry.mark === MARK.none && !guard.held()) return settle(key, entry, line);
      if (entry.mark >= MARK.lost) return settle(key, entry, refusal(entry.id, entry.mark));
      if (buffered >= maxBuffered) return settle(key, entry, refusal(entry.id, MARK.unconfirmed));
      entry.buffered = { line, at: now() };
      buffered++;
      return null;
    },
    size: () => pending.size,
    bufferedCount: () => buffered,
  };
  return tracker;
}

/**
 * One poll of the relay's takeover state into `guard` (signed-in runs; never two at once: a call
 * while one runs does nothing), then `onPoll()`. A response that is not 2xx, not JSON, or not a
 * valid status, a timeout or an unreachable relay all count as a failed poll: held. `fetchImpl` and
 * `log` are for tests.
 */
export function createControlPoller({ guard, url, fetchImpl = fetch, timeoutMs = CONTROL_POLL.timeoutMs, log = () => {}, onPoll = () => {} }) {
  let polling = false;
  let warned = false;
  return async function poll() {
    if (polling) return;
    polling = true;
    const seq = guard.next();
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        await response.body?.cancel?.().catch?.(() => undefined);
        throw new Error(`status ${response.status}`);
      }
      guard.result(seq, await response.json());
      if (guard.unavailable()) throw new Error("not a valid takeover state");
      warned = false;
    } catch {
      guard.failure(seq);
      if (!warned) log("could not read a valid takeover state from the relay; browser tools are paused");
      warned = true;
    } finally {
      polling = false;
      onPoll();
    }
  };
}

/** Requests a signed-in run may send (none of them but tools/call touches the browser). */
const SIGNED_IN_CLIENT_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call", "logging/setLevel"]);

const rpcError = (id, code, message) => ({ reply: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) });

/**
 * The stdio filter of one run, both directions. `guard` is the signed-in run's takeover guard (null
 * for the clean Server browser, which no owner can take over: its filter is as before).
 *
 * Signed-in: `client(line)` refuses requests with an id that is not a string or number, an id still
 * in flight, and methods other than SIGNED_IN_CLIENT_METHODS; then filterClientLine decides with the
 * guard's state; a forwarded request is tracked (createCallTracker). `server(line)` returns the line
 * to pass on now or null; answers to untracked ids are dropped, and a tool result is passed,
 * buffered (`emit` gets it later) or replaced as the tracker decides. Call `sync()` after each poll
 * and on a short timer.
 */
export function createRunFilter({ signedIn = false, guard = null, now = () => performance.now(), emit = () => {}, bufferMs = 5000, log = () => {} } = {}) {
  if (signedIn && !guard) throw new Error("a signed-in run needs the takeover guard");
  const calls = guard ? createCallTracker({ now, bufferMs, emit }) : null;
  const state = () => (guard ? { ownerControl: guard.held(), securing: guard.securing(), lockFailed: guard.lockFailed(), unavailable: guard.unavailable() } : { ownerControl: false });
  return {
    calls,
    client(line) {
      if (!guard) return filterClientLine(line, { ownerControl: false, signedIn });
      const message = parseObject(line);
      if (!message) return { drop: true };
      const request = typeof message.method === "string" && message.id !== undefined;
      if (request) {
        if (!validRequestId(message.id)) return rpcError(null, -32600, "Invalid request: the id must be a string or a number.");
        if (!SIGNED_IN_CLIENT_METHODS.has(message.method)) return rpcError(message.id, -32601, "Not available in the signed-in browser.");
        if (calls.known(message.id)) return rpcError(message.id, -32600, "A request with this id is still in flight; use a new id.");
        if (calls.full()) return rpcError(message.id, -32000, "Too many requests in flight; wait for the earlier ones.");
      }
      if (message.method === "notifications/cancelled") calls.cancel(message.params?.requestId);
      calls.sync(guard);
      const verdict = filterClientLine(line, { ...state(), signedIn });
      if ("forward" in verdict && request) calls.started(message, guard.confirmation());
      return verdict;
    },
    server(line) {
      const kept = filterServerLine(line, { signedIn });
      if (kept === null || !guard) return kept;
      return calls.finish(kept, guard);
    },
    sync() {
      if (guard) calls.sync(guard);
    },
    /** An over-long line from the agent (dropped whole, never forwarded in part). */
    overflowFromClient() {
      log("dropped an over-long message from the agent");
    },
    overflowFromServer() {
      log("dropped an over-long message from Playwright MCP");
    },
  };
}
