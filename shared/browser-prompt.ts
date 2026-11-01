// Pure, dependency-free logic shared by the client entry and the unit tests.
// Keep this file free of imports so `node --experimental-strip-types` can load it directly.

/** Info-string word that marks a fenced block as a browser prompt. */
export const INFO_WORD = "browser-prompt";

/** Keep the raw fenced block in the rendered message text; the card follows it. */
export const KEEP_BLOCK_IN_MESSAGE = true;

/** Longest ChatGPT URL we open with a prefilled prompt. */
export const MAX_URL_LENGTH = 1500;

export const CHATGPT_AGENT_URL = "https://chatgpt.com/?hints=agent";

export const COMPUTER_USE_HEADER =
  "Use computer use (@Computer) to carry out the following steps for me in my web browser, " +
  "where I am already signed in. Stop and ask me before entering any password, token, or other " +
  "secret, and before confirming any destructive or irreversible action.";

export interface BrowserPromptBlock {
  /** 0-based position among browser-prompt blocks in the message. */
  index: number;
  title: string;
  body: string;
  /** Offset of the first character of the opening fence line. */
  start: number;
  /** Offset just past the closing fence line (including its newline), or text.length. */
  end: number;
  closed: boolean;
}

interface Line {
  text: string;
  start: number;
  /** Offset just past this line including its line break. */
  next: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const stop = nl === -1 ? text.length : nl;
    const raw = text.slice(start, stop);
    lines.push({
      text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
      start,
      next: nl === -1 ? text.length : nl + 1,
    });
    if (nl === -1) return lines;
    start = nl + 1;
  }
}

const OPEN_FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

function stripIndent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

interface OpenFence {
  char: string;
  size: number;
  indent: number;
  prompt: boolean;
  title: string;
  start: number;
  body: string[];
}

/**
 * Finds every ```browser-prompt fenced block. Fences inside other fenced blocks are ignored,
 * so a ```markdown example that shows the convention is not treated as a prompt.
 */
export function findBrowserPrompts(text: string): BrowserPromptBlock[] {
  const blocks: BrowserPromptBlock[] = [];
  let open: OpenFence | null = null;

  for (const line of splitLines(text)) {
    if (open === null) {
      const match = OPEN_FENCE.exec(line.text);
      if (!match) continue;
      const fence = match[2]!;
      const info = match[3]!.trim();
      if (fence[0] === "`" && info.includes("`")) continue; // not a fence per CommonMark
      const [word = "", ...rest] = info.split(/\s+/);
      open = {
        char: fence[0]!,
        size: fence.length,
        indent: match[1]!.length,
        prompt: word.toLowerCase() === INFO_WORD,
        title: rest.join(" ").trim(),
        start: line.start,
        body: [],
      };
      continue;
    }
    const fenceChar = open.char;
    const trimmed = line.text.trim();
    if (trimmed.length >= open.size && [...trimmed].every((c) => c === fenceChar)) {
      if (open.prompt) {
        blocks.push({
          index: blocks.length,
          title: open.title,
          body: open.body.join("\n"),
          start: open.start,
          end: line.next,
          closed: true,
        });
      }
      open = null;
      continue;
    }
    open.body.push(stripIndent(line.text, open.indent));
  }
  if (open !== null && open.prompt) {
    blocks.push({
      index: blocks.length,
      title: open.title,
      body: open.body.join("\n"),
      start: open.start,
      end: text.length,
      closed: false,
    });
  }
  return blocks;
}

/** FNV-1a 32-bit, hex. Stable id for a prompt's content. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const MARKDOWN_KIND = "browser-prompt-markdown";
export const CARD_KIND = "browser-prompt-card";

export type MarkdownItemData = {
  text: string;
  phase: "streaming" | "complete";
};

export type CardItemData = {
  cardId: string;
  index: number;
  title: string;
  text: string;
  /** The message's id from Paseo, when the provider gives one: places the card in its chat. */
  messageId?: string;
};

export type ExplodedItem =
  | { type: "plugin"; id: string; kind: typeof MARKDOWN_KIND; version: 1; data: MarkdownItemData }
  | { type: "plugin"; id: string; kind: typeof CARD_KIND; version: 1; data: CardItemData };

/**
 * Splits an assistant message into markdown segments plus one card per closed browser-prompt
 * block. Returns undefined when no block has closed yet, so Paseo keeps its native row
 * (including while the first block is still streaming).
 */
export function explodeMessage(
  text: string,
  phase: "streaming" | "complete",
  messageId?: string,
): ExplodedItem[] | undefined {
  if (!text.includes(INFO_WORD)) return undefined;
  const closed = findBrowserPrompts(text).filter((block) => block.closed);
  if (closed.length === 0) return undefined;

  const items: ExplodedItem[] = [];
  const pushText = (segment: string, id: string, segmentPhase: "streaming" | "complete") => {
    if (segment.trim().length === 0) return;
    items.push({
      type: "plugin",
      id,
      kind: MARKDOWN_KIND,
      version: 1,
      data: { text: segment, phase: segmentPhase },
    });
  };

  // Item ids name their message: Paseo keeps plugin items by id within a chat, so `card-0` in two
  // messages showed the later message's card in both. Without a message id, the text up to the first
  // closed block names it (it no longer changes while the message streams).
  const scope = messageId ? `${messageId}-` : `h${hashText(text.slice(0, closed[0]!.end))}-`;
  let cursor = 0;
  for (const block of closed) {
    pushText(text.slice(cursor, KEEP_BLOCK_IN_MESSAGE ? block.end : block.start), `md-${scope}${block.index}`, "complete");
    items.push({
      type: "plugin",
      id: `card-${scope}${block.index}`,
      kind: CARD_KIND,
      version: 1,
      data: {
        cardId: hashText(`${block.title}\n${block.body}`),
        index: block.index,
        title: block.title,
        text: block.body,
        ...(messageId ? { messageId } : {}),
      },
    });
    cursor = block.end;
  }
  pushText(text.slice(cursor), `md-${scope}${closed.length}`, phase);
  return items;
}

/** The full text placed on the clipboard and in the ChatGPT URL. */
export function composePrompt(title: string, body: string): string {
  const heading = title ? `Task: ${title}\n\n` : "";
  return `${COMPUTER_USE_HEADER}\n\n${heading}${body.trim()}\n`;
}

const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // Long opaque run without slashes or dots, so ordinary URLs and names do not match.
  /[A-Za-z0-9+_=-]{40,}/,
];

/** True when the text looks like it contains a credential value rather than a name. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export interface LaunchPlan {
  url: string;
  prefilled: boolean;
  reason?: "too-long" | "possible-secret";
}

/** ChatGPT agent-mode URL, prefilled only when short enough and free of secret-looking values. */
export function planChatGptLaunch(prompt: string): LaunchPlan {
  if (looksLikeSecret(prompt)) {
    return { url: CHATGPT_AGENT_URL, prefilled: false, reason: "possible-secret" };
  }
  const url = `${CHATGPT_AGENT_URL}&q=${encodeURIComponent(prompt)}`;
  if (url.length > MAX_URL_LENGTH) {
    return { url: CHATGPT_AGENT_URL, prefilled: false, reason: "too-long" };
  }
  return { url, prefilled: true };
}

// ---------------------------------------------------------------------------------------------
// ChatGPT desktop app deep link + http(s) trampoline page.

/**
 * Documented deep link of the ChatGPT desktop app (macOS/Windows), which keeps the `codex://`
 * scheme: https://learn.chatgpt.com/docs/app/commands#deep-links. `{prompt}` is replaced by the
 * URI-encoded prompt; the link opens a new chat with the prompt in the composer (not sent).
 */
export const DEFAULT_APP_LINK_TEMPLATE = "codex://new?prompt={prompt}";

/**
 * Schemes the app deep-link template may use: the ChatGPT desktop app's documented `codex:` scheme,
 * and `https:` for a web fallback. Everything else (javascript:, file:, other apps) is refused.
 */
export const ALLOWED_APP_LINK_SCHEMES: readonly string[] = ["codex", "https"];

/** Returns an error message, or null when the template is usable. */
export function validateAppLinkTemplate(template: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(template.trim());
  if (!match) return "Must start with a URL scheme, for example codex://";
  if (!ALLOWED_APP_LINK_SCHEMES.includes(match[1]!.toLowerCase())) {
    return `Only ${ALLOWED_APP_LINK_SCHEMES.map((scheme) => `${scheme}:`).join(" and ")} links are allowed.`;
  }
  if (!template.includes("{prompt}")) return "Must contain {prompt} where the prompt goes.";
  return null;
}

/** Links in rendered agent messages are opened only when they are plain http(s) URLs. */
export function isSafeLinkHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href.trim());
}

export function buildAppLink(template: string, prompt: string): string {
  const usable = validateAppLinkTemplate(template) === null ? template.trim() : DEFAULT_APP_LINK_TEMPLATE;
  return usable.split("{prompt}").join(encodeURIComponent(prompt));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Self-contained page that immediately hands the deep link to the OS, with a manual fallback. */
export function renderTrampolinePage(deepLink: string, nonce: string): string {
  const scriptLink = JSON.stringify(deepLink).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, " ");
  const href = escapeHtml(deepLink);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Opening ChatGPT</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:3em auto;max-width:36em;padding:0 1em;color-scheme:light dark}</style>
</head><body>
<p>Opening ChatGPT&hellip; the prompt is also on your clipboard, so you can paste it. <a href="${href}">Open ChatGPT</a></p>
<script nonce="${nonce}">location.replace(${scriptLink});</script>
</body></html>
`;
}

export function trampolineHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
