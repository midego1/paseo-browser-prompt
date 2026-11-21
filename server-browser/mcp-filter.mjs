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

export const DENIED_TEXT = "This tool is turned off in the browser-prompt Server browser.";

/** Whether a tool may be listed and called: on the allowlist and not on the denylist. */
export function toolAllowed(name) {
  return typeof name === "string" && ALLOWED_TOOLS.has(name) && !DENIED_TOOLS.has(name);
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
  "The owner has taken over the signed-in browser and holds control right now, so browser tools are paused (no reading and no actions). Do not retry in a loop: ask the owner with AskUserQuestion to answer \"done\" when they are finished and have released control (tap the mouse icon again or close the viewer), then take a new snapshot and continue.";

/**
 * A message from the agent: `{ forward }` to pass it on, `{ reply }` to answer it here, or
 * `{ drop: true }` to discard it. With `ownerControl` (signed-in runs, while the owner holds control
 * in the viewer) every tool call is answered with OWNER_CONTROL_TEXT instead of reaching the browser.
 */
export function filterClientLine(line, { ownerControl = false } = {}) {
  const message = parseObject(line);
  if (!message) return { drop: true };
  if (ownerControl && message.method === "tools/call") {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: OWNER_CONTROL_TEXT }], isError: true } }),
    };
  }
  if (message.method === "tools/call" && !toolAllowed(message.params?.name)) {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: DENIED_TEXT }], isError: true } }),
    };
  }
  return { forward: line };
}

/** A message from Playwright MCP: tools/list results keep only allowed tools; non-objects are dropped (null). */
export function filterServerLine(line) {
  const message = parseObject(line);
  if (!message) return null;
  const tools = message.result?.tools;
  if (!Array.isArray(tools)) return line;
  const kept = tools.filter((tool) => toolAllowed(tool?.name));
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
