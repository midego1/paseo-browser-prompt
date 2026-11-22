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

/**
 * A message from the agent: `{ forward }` to pass it on, `{ reply }` to answer it here, or
 * `{ drop: true }` to discard it. With `ownerControl` (signed-in runs, while the owner holds control
 * in the viewer) every tool call is answered with OWNER_CONTROL_TEXT instead of reaching the browser.
 */
export function filterClientLine(line, { ownerControl = false, securing = false, signedIn = false } = {}) {
  const message = parseObject(line);
  if (!message) return { drop: true };
  if (ownerControl && message.method === "tools/call") {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: securing ? SECURING_TEXT : OWNER_CONTROL_TEXT }], isError: true } }),
    };
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
 * The owner's takeover state as the run sees it. Polled results carry a sequence number; older ones
 * are ignored. The relay's `ownerControl` decides (it already counts "unsure while a viewer is
 * connected" as held, and never holds without a viewer). After
 * a failed poll the state stays held while the last held state is younger than `holdMs`, and opens
 * only after `failuresToOpen` failed polls in a row (when the relay cannot be asked at all, no viewer
 * can hold control either: the relay is the viewer's only way in). With Bitwarden in the browser
 * `failuresToOpen` is infinite: a failed poll keeps the state, and it never opens on failures alone
 * (the relay is also what says the vault was locked after a takeover).
 */
export function createControlGuard({ now = Date.now, holdMs = 10_000, failuresToOpen = 3 } = {}) {
  let held = false;
  let securing = false;
  let lastHeldAt = -Infinity;
  let failures = 0;
  let issued = 0;
  let applied = 0;
  return {
    /** Sequence number for the next poll. */
    next: () => ++issued,
    result(seq, body) {
      if (seq <= applied) return;
      applied = seq;
      failures = 0;
      // The relay decides (held only while a viewer is connected and holds control or it is unsure);
      // `known` is informational.
      held = body?.ownerControl === true;
      securing = held && body?.securing === true;
      if (held) lastHeldAt = now();
    },
    failure(seq) {
      if (seq <= applied) return;
      applied = seq;
      failures++;
      securing = false;
      if (now() - lastHeldAt < holdMs) held = true;
      else if (failures >= failuresToOpen) held = false;
      else if (!Number.isFinite(failuresToOpen)) held = true;
    },
    held: () => held,
    /** Held only because the vault is being locked (nobody holds control). */
    securing: () => securing,
  };
}

/**
 * Tool calls on their way through Playwright MCP. A result that arrives while the owner holds
 * control, or whose call overlapped a held period, is replaced with OWNER_CONTROL_TEXT, so a call
 * that started before a takeover cannot hand back what the owner typed.
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
    finish(line, heldNow) {
      const message = parseObject(line);
      if (!message || message.id === undefined || message.id === null || message.method) return line;
      const key = JSON.stringify(message.id);
      if (!pending.has(key)) return line;
      const during = pending.get(key);
      pending.delete(key);
      if (!heldNow && !during) return line;
      return JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: OWNER_CONTROL_TEXT }], isError: true } });
    },
    size: () => pending.size,
  };
}
