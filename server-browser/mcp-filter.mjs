// Filters the MCP stdio stream between the agent and Playwright MCP inside the browser container:
// tools the Server browser must not offer are removed from tools/list and refused in tools/call.
// browser_run_code_unsafe runs code in the Playwright server process, browser_file_upload and
// browser_drop pick files; Playwright MCP has no option to leave them out. Messages are
// newline-delimited JSON-RPC; anything that is not JSON passes unchanged.

export const DENIED_TOOLS = new Set(["browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install"]);

export const DENIED_TEXT = "This tool is turned off in the browser-prompt Server browser.";

function parse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** A message from the agent: `{ forward }` to pass it on, or `{ reply }` to answer it here. */
export function filterClientLine(line) {
  const message = parse(line);
  if (!message || Array.isArray(message)) return { forward: line };
  if (message.method === "tools/call" && DENIED_TOOLS.has(message.params?.name)) {
    if (message.id === undefined || message.id === null) return { drop: true };
    return {
      reply: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: DENIED_TEXT }], isError: true } }),
    };
  }
  return { forward: line };
}

/** A message from Playwright MCP: tools/list results lose the denied tools. */
export function filterServerLine(line) {
  const message = parse(line);
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return line;
  const kept = tools.filter((tool) => !DENIED_TOOLS.has(tool?.name));
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
