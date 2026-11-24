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
 * `maxLength` is dropped whole (no part of it is passed on); when it ends, `onOverflow({ head, tail })`
 * gets its first 4096 and last 256 characters, to answer it by its id.
 */
export function lineSplitter(onLine, { maxLength = MAX_CLIENT_LINE, onOverflow = () => {} } = {}) {
  let buffer = "";
  /** While skipping an over-long line: its start and its last characters so far. */
  let skipped = null;
  const finishSkip = () => {
    const info = { head: skipped.head, tail: skipped.tail };
    skipped = null;
    onOverflow(info);
  };
  return {
    push(chunk) {
      let text = String(chunk);
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const piece = text.slice(0, index);
        text = text.slice(index + 1);
        if (skipped) {
          skipped.tail = (skipped.tail + piece).slice(-256);
          finishSkip();
          continue;
        }
        const line = buffer + piece;
        buffer = "";
        if (line.length > maxLength) onOverflow({ head: line.slice(0, 4096), tail: line.slice(-256) });
        else onLine(line);
      }
      if (skipped) {
        skipped.tail = (skipped.tail + text).slice(-256);
        return;
      }
      buffer += text;
      if (buffer.length > maxLength) {
        skipped = { head: buffer.slice(0, 4096), tail: buffer.slice(-256) };
        buffer = "";
      }
    },
    end() {
      if (skipped) finishSkip();
      else if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

const ID_VALUE = String.raw`("(?:[^"\\]|\\.){0,200}"|-?\d{1,16})`;
/** `{"jsonrpc":"2.0","id":…` or `{"id":…` at the start of a message. */
const ID_AT_START = new RegExp(String.raw`^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*${ID_VALUE}\s*[,}]`);
/** `…,"id":…}` at the end of a message (the MCP SDK writes the id last). */
const ID_AT_END = new RegExp(String.raw`[,{]\s*"id"\s*:\s*${ID_VALUE}\s*\}\s*$`);

/** The JSON-RPC id of an over-long message from its start or end, or undefined when it cannot be read. */
export function idOfDroppedLine({ head = "", tail = "" } = {}) {
  for (const match of [ID_AT_START.exec(head), ID_AT_END.exec(tail)]) {
    if (!match) continue;
    try {
      const id = JSON.parse(match[1]);
      if (validRequestId(id)) return id;
    } catch {
      // not an id
    }
  }
  return undefined;
}

/** What the agent gets for a message of its own that was too long. */
export const TOO_LONG_REQUEST_TEXT = "This message is too long for the browser-prompt Server browser (more than 8 MB) and was not sent.";
/** What the agent gets for a call whose answer from Playwright MCP was too long. */
export const TOO_LONG_RESULT_TEXT = "The browser's answer to this call was too large and was dropped. The call may have been carried out: take a snapshot before you repeat it.";

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
  // Held with `known: false`: the relay could not read neko (a viewer is connected), not a takeover it saw.
  if (body.ownerControl) return { ownerControl: true, unsure: body.known === false, securing: body.securing === true, lockFailed: body.lockFailed === true, bootId, epoch, sampledAt: askedAt };
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
 * - `ownerControl: true` with `known: false` (the relay holds because it cannot read neko while a
 *   viewer is connected) holds as unavailable, not as a takeover.
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
  const reason = () =>
    fresh() ? "released" : !status?.ownerControl ? "unavailable" : status.lockFailed ? "lockFailed" : status.securing ? "securing" : status.unsure ? "unavailable" : "owner";
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

/** How bad what happened while a call ran is: its result is passed, or replaced by the text. */
const MARK = Object.freeze({ none: 0, unconfirmed: 1, owner: 2, lockFailed: 3 });
const MARK_TEXT = [null, UNCONFIRMED_TEXT, OWNER_CONTROL_TEXT, LOCK_FAILED_TEXT];

/** What a request gets when Playwright MCP does not answer it within the maximum call time. */
export const NO_ANSWER_TEXT =
  "No answer from the browser within 10 minutes, so this call was given up. It may have been carried out: take a snapshot before you repeat it.";

/** Whether a JSON-RPC id may be used for a request here: a string or a finite number. */
export function validRequestId(id) {
  return (typeof id === "string" && id.length <= 200) || (typeof id === "number" && Number.isFinite(id));
}

/**
 * Requests of a signed-in run on their way through Playwright MCP, by id. A request id may be in
 * flight once (a second request with it is refused before it is forwarded), and an answer from
 * Playwright MCP passes only when it answers a tracked request (anything else is dropped). For each
 * tool call it keeps the relay start and control epoch it began under and the worst thing seen while
 * it ran (`sync`, after every poll and before every decision). Its result passes only when nothing
 * was seen; otherwise it is withheld, never released later:
 *
 * - The owner held control or the vault was being locked (a real `ownerControl: true`), or the
 *   epoch moved between two good polls (a takeover, a viewer, a control request): OWNER_CONTROL_TEXT.
 * - The vault could not be locked: LOCK_FAILED_TEXT.
 * - The status was unavailable (a failed, invalid or stale poll) or the relay started again while it
 *   ran: UNCONFIRMED_TEXT. A later release does not prove that nobody took over meanwhile.
 *
 * A request with no answer within `maxCallMs` gets an error (NO_ANSWER_TEXT, through `emit`); its id
 * stays retired until Playwright MCP answers it (that late answer is dropped). A cancelled id stays
 * retired for `retireMs`. A retired id is not reused; with `maxRetired` of them new requests are refused.
 */
export function createCallTracker({ now = () => performance.now(), maxPending = 256, maxRetired = 1000, maxCallMs = 10 * 60_000, retireMs = 10 * 60_000, emit = () => {} } = {}) {
  /** JSON of the id -> { id, call, confirm, mark, startedAt } */
  const pending = new Map();
  /**
   * Ids given up on -> { at, untilAnswered }. Cancelled by the agent: dropped by age (`retireMs`). No
   * answer in time (the call may still run): kept until Playwright MCP answers it, never by age.
   */
  const retired = new Map();
  const refusal = (id, mark) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: MARK_TEXT[mark] }], isError: true } });
  const raise = (entry, mark) => {
    if (mark > entry.mark) entry.mark = mark;
  };
  const retire = (key, untilAnswered = false) => {
    pending.delete(key);
    retired.set(key, { at: now(), untilAnswered });
  };
  const expire = () => {
    const t = now();
    for (const [key, { at, untilAnswered }] of retired) if (!untilAnswered && (t - at > retireMs || t < at)) retired.delete(key);
    for (const [key, entry] of pending) {
      if (t - entry.startedAt <= maxCallMs && t >= entry.startedAt) continue;
      retire(key, true);
      emit(JSON.stringify({ jsonrpc: "2.0", id: entry.id, error: { code: -32000, message: NO_ANSWER_TEXT } }));
    }
  };
  const tracker = {
    /** Whether this id is in flight, or retired and maybe still running. */
    known: (id) => pending.has(JSON.stringify(id)) || retired.has(JSON.stringify(id)),
    /** No room for another request (in flight, or retired ids that have not aged out). */
    full: () => pending.size >= maxPending || retired.size >= maxRetired,
    /** A request that was forwarded (`confirm`: the guard's confirmation then). */
    started(message, confirm) {
      pending.set(JSON.stringify(message.id), { id: message.id, call: message.method === "tools/call", confirm, mark: MARK.none, startedAt: now() });
    },
    /** The agent cancelled a request: Playwright MCP may never answer it. */
    cancel(id) {
      if (!validRequestId(id)) return;
      const key = JSON.stringify(id);
      if (pending.has(key)) retire(key);
    },
    /** Updates every tool call with the guard's state, and gives up on requests that took too long. */
    sync(guard) {
      expire();
      const reason = guard.reason();
      const confirm = guard.confirmation();
      for (const entry of pending.values()) {
        if (!entry.call) continue;
        if (reason === "owner" || reason === "securing") raise(entry, MARK.owner);
        else if (reason === "lockFailed") raise(entry, MARK.lockFailed);
        else if (reason === "unavailable") raise(entry, MARK.unconfirmed);
        else if (!entry.confirm || !confirm || confirm.bootId !== entry.confirm.bootId) raise(entry, MARK.unconfirmed);
        else if (confirm.epoch !== entry.confirm.epoch) raise(entry, MARK.owner);
      }
    },
    /** An answer from Playwright MCP: the line to pass on, or null (dropped). */
    finish(line, guard) {
      const message = parseObject(line);
      if (!message || message.method !== undefined || !validRequestId(message.id)) return null;
      const key = JSON.stringify(message.id);
      const entry = pending.get(key);
      if (!entry) {
        // The late answer of a call given up on: dropped, and its id is free again.
        if (retired.get(key)?.untilAnswered) retired.delete(key);
        return null;
      }
      pending.delete(key);
      if (!entry.call) return line;
      tracker.sync(guard);
      if (entry.mark === MARK.none && !guard.held()) return line;
      return refusal(entry.id, entry.mark === MARK.none ? MARK.unconfirmed : entry.mark);
    },
    /** The request with this id got an answer that cannot be passed on: no longer in flight. Whether it was. */
    settle(id) {
      if (!validRequestId(id)) return false;
      const key = JSON.stringify(id);
      if (retired.get(key)?.untilAnswered) retired.delete(key);
      return pending.delete(key);
    },
    size: () => pending.size,
    retiredCount: () => retired.size,
  };
  return tracker;
}

/**
 * One poll of the relay's takeover state into `guard` (signed-in runs; never two at once: a call
 * while one runs does nothing). `onPoll()` runs right before the result is applied (so a release that
 * went stale meanwhile is seen before a new one replaces it) and again after it. A response that is not 2xx, not JSON, or not a
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
      const body = await response.json();
      // The state up to now (perhaps a release gone stale meanwhile) is seen before the new one.
      onPoll();
      guard.result(seq, body);
      if (guard.unavailable()) throw new Error("not a valid takeover state");
      warned = false;
    } catch {
      onPoll();
      guard.failure(seq);
      if (!warned) log("could not read a valid takeover state from the relay; browser tools are paused");
      warned = true;
    } finally {
      polling = false;
      onPoll();
    }
  };
}

/** Requests a signed-in run may send to Playwright MCP (none of them but tools/call touches the browser). */
const SIGNED_IN_CLIENT_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);
/** Requests answered here with an empty result (never forwarded). */
const LOCAL_CLIENT_METHODS = new Set(["logging/setLevel"]);
/** Notifications a signed-in run may send. */
const SIGNED_IN_CLIENT_NOTIFICATIONS = new Set(["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]);
/** What Playwright MCP may send on its own in a signed-in run: these notifications and requests (progress and log messages could carry page content and are dropped). */
const SIGNED_IN_SERVER_NOTIFICATIONS = new Set(["notifications/tools/list_changed", "notifications/cancelled"]);
const SIGNED_IN_SERVER_REQUESTS = new Set(["roots/list", "ping"]);

const rpcError = (id, code, message) => ({ reply: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) });

/**
 * The stdio filter of one run, both directions. `guard` is the signed-in run's takeover guard (null
 * for the clean Server browser, which no owner can take over: its filter is as before).
 *
 * Signed-in, from the agent: requests need a string or number id that is not in flight or retired,
 * and one of SIGNED_IN_CLIENT_METHODS (logging/setLevel is answered here); notifications other than
 * SIGNED_IN_CLIENT_NOTIFICATIONS (a tools/call without an id included) are dropped; then
 * filterClientLine decides with the guard's state, and a forwarded request is tracked
 * (createCallTracker). From Playwright MCP: answers to untracked ids are dropped, a tool result passes
 * or is withheld as the tracker decides, and only SIGNED_IN_SERVER_NOTIFICATIONS and
 * SIGNED_IN_SERVER_REQUESTS pass on their own. Call `sync()` after each poll and on a short timer;
 * `emit` gets the errors for requests that were given up on.
 */
export function createRunFilter({ signedIn = false, guard = null, now = () => performance.now(), emit = () => {}, log = () => {}, maxCallMs, retireMs } = {}) {
  if (signedIn && !guard) throw new Error("a signed-in run needs the takeover guard");
  const calls = guard ? createCallTracker({ now, emit, ...(maxCallMs ? { maxCallMs } : {}), ...(retireMs ? { retireMs } : {}) }) : null;
  const state = () => (guard ? { ownerControl: guard.held(), securing: guard.securing(), lockFailed: guard.lockFailed(), unavailable: guard.unavailable() } : { ownerControl: false });
  return {
    calls,
    client(line) {
      if (!guard) return filterClientLine(line, { ownerControl: false, signedIn });
      const message = parseObject(line);
      if (!message) return { drop: true };
      const hasMethod = message.method !== undefined;
      const request = hasMethod && message.id !== undefined;
      if (hasMethod && typeof message.method !== "string") return { drop: true };
      if (hasMethod && !request && !SIGNED_IN_CLIENT_NOTIFICATIONS.has(message.method)) return { drop: true };
      calls.sync(guard);
      if (request) {
        if (!validRequestId(message.id)) return rpcError(null, -32600, "Invalid request: the id must be a string or a number.");
        if (calls.known(message.id)) return rpcError(message.id, -32600, "A request with this id is still in flight or was given up on; use a new id.");
        if (LOCAL_CLIENT_METHODS.has(message.method)) return { reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) };
        if (!SIGNED_IN_CLIENT_METHODS.has(message.method)) return rpcError(message.id, -32601, "Not available in the signed-in browser.");
        if (calls.full()) return rpcError(message.id, -32000, "Too many requests in flight; wait for the earlier ones.");
      }
      if (message.method === "notifications/cancelled") calls.cancel(message.params?.requestId);
      const verdict = filterClientLine(line, { ...state(), signedIn });
      if ("forward" in verdict && request) calls.started(message, guard.confirmation());
      return verdict;
    },
    server(line) {
      const kept = filterServerLine(line, { signedIn });
      if (kept === null || !guard) return kept;
      const message = parseObject(kept);
      if (message?.method !== undefined) {
        const allowed = message.id === undefined ? SIGNED_IN_SERVER_NOTIFICATIONS : SIGNED_IN_SERVER_REQUESTS;
        return allowed.has(message.method) ? kept : null;
      }
      return calls.finish(kept, guard);
    },
    sync() {
      if (guard) calls.sync(guard);
    },
    /**
     * An over-long line from the agent (dropped whole, never forwarded in part): the error answer
     * for its id (read from its start or end), or null when no id can be read or the id is in use.
     */
    overflowFromClient(info) {
      log("dropped an over-long message from the agent");
      const id = idOfDroppedLine(info);
      if (id === undefined || calls?.known(id)) return null;
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: TOO_LONG_REQUEST_TEXT } });
    },
    /**
     * An over-long line from Playwright MCP (dropped whole): an error answer for the request it
     * answered (its id read from its end), or null. Signed-in, only for a tracked request; one that
     * cannot be matched gets the no-answer error after the maximum call time.
     */
    overflowFromServer(info) {
      log("dropped an over-long message from Playwright MCP");
      const id = idOfDroppedLine(info);
      if (id === undefined || (calls && !calls.settle(id))) return null;
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: TOO_LONG_RESULT_TEXT } });
    },
  };
}
