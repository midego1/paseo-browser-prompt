// Pure, dependency-free logic shared by the client entry and the unit tests.
// Keep this file free of imports so `node --experimental-strip-types` can load it directly.

/** Info-string word that marks a fenced block as a browser prompt. */
export const INFO_WORD = "browser-prompt";

/** Longest ChatGPT URL we open with a prefilled prompt. */
export const MAX_URL_LENGTH = 1500;

export const CHATGPT_AGENT_URL = "https://chatgpt.com/?hints=agent";

/**
 * Header for ChatGPT desktop and web: ChatGPT uses its own computer use (@Computer). The Claude
 * desktop app has its own header below.
 */
export const CHATGPT_HEADER =
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
  /** Set by the client transformer: the index of an earlier, identical block in the same message. */
  sameAs?: number;
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
    pushText(text.slice(cursor, block.start), `md-${scope}${block.index}`, "complete");
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

/** Header for the Claude desktop app: it should carry the steps out in Chrome through Claude in Chrome. */
export const CLAUDE_DESKTOP_HEADER =
  "Use Claude in Chrome to carry out the following steps for me in my Chrome browser, where I am already signed in. " +
  "Stop and ask me before entering any password, token, or other secret, and before confirming any destructive " +
  "or irreversible action.";

/** The full text placed on the clipboard, in the ChatGPT URL and in the app deep links. */
export function composePrompt(title: string, body: string, header: string = CHATGPT_HEADER): string {
  const heading = title ? `Task: ${title}\n\n` : "";
  return `${header}\n\n${heading}${body.trim()}\n`;
}

// Each pattern runs in linear time on any input: a match may start only where its token starts (a
// lookbehind or \b with nothing optional before the fixed prefix), and open-ended parts are bounded.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bSK[0-9a-fA-F]{32}\b/,
  // Bare hex run as long as an API key or hash secret; git short SHAs and UUIDs stay below it.
  /\b[0-9a-fA-F]{32,}\b/,
  // Credentials in a URL: scheme://user:password@host.
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/?#@:]{1,256}:[^\s/?#@]{1,256}@/,
  // Long opaque run without slashes or dots, so ordinary URLs and names do not match.
  /[A-Za-z0-9+_=-]{40,}/,
];

/**
 * `password: x`, `api_key=x`, `"token": "x"`, `authToken=x` on one line: a name (a bare word, `api
 * key` and the like, or a quoted JSON key), `:` or `=`, and a value. Name and value are checked
 * separately (`isSecretName`, `isAssignedValue`).
 */
const ASSIGNED_SECRET =
  /(?<![A-Za-z0-9_-])((?:api|secret|private|access) key|[A-Za-z][A-Za-z0-9_-]{0,40})["']?[ \t]{0,8}[:=][ \t]{0,8}["'`]?([^\s"'`<>{}()[\],;]{6,512})/gi;

/** A name that holds a credential: `password`, `pwd`, `passcode`, `*token`, `*secret`, `*_key`, `apiKey`. */
function isSecretName(name: string): boolean {
  if (/(?:password|passwd|passcode|pwd|secret|token)s?$/i.test(name)) return true;
  if (/^(?:api|secret|private|access)[ _-]?key$/i.test(name)) return true;
  // snake_case or kebab-case `*_key`, camelCase `*Key`; a plain word such as `hotkey` is not one.
  return /[_-]key$/i.test(name) || /[a-z0-9]Key$/.test(name);
}

/** A value after `password:` and the like, as opposed to a secret's name, a placeholder or prose. */
function isAssignedValue(value: string): boolean {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false; // a name such as DEPLOY_TOKEN
  if (/^[$%]/.test(value)) return false; // a variable such as $API_KEY or %TOKEN%
  if (/^[*•x.]+$/i.test(value)) return false; // masked
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // a URL, for example to the settings page
  return /[0-9]/.test(value); // words in a sentence carry no digits; credentials nearly always do
}

/** `Bearer <token>`; words that follow "Bearer" in prose are not tokens. */
const BEARER = /\bBearer[ \t]{1,8}([A-Za-z0-9_.~+/-]{12,2048}={0,2})/g;
const BEARER_PROSE = /^(?:authentication|authorization|authorisation|credentials?|tokens?|headers?|schemes?)$/i;

/**
 * A 40-character base64 run with `/` or `+` (an AWS secret access key): mixed case and digits, and
 * not part of a path or name, so `acme/webshop/settings/secrets/actions` does not count.
 */
const BASE64_40 = /(?<![A-Za-z0-9/+=.:_-])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=._-])/g;

function isAwsLikeSecret(run: string): boolean {
  return /[/+]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) && !run.includes("//");
}

/** True when the text looks like it contains a credential value rather than a name. */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const match of text.matchAll(ASSIGNED_SECRET)) {
    const name = match[1]!;
    const value = match[2]!.replace(/[.!?]+$/, "");
    // Digits alone are a passcode or PIN, but a count after `max tokens:` and the like.
    if (/^[0-9]+$/.test(value) && !/pass|pwd/i.test(name)) continue;
    if (isSecretName(name) && isAssignedValue(value)) return true;
  }
  for (const match of text.matchAll(BEARER)) {
    const token = match[1]!.replace(/[.!?]+$/, "");
    if (!BEARER_PROSE.test(token) && !/^[A-Z][A-Z0-9_]*$/.test(token)) return true;
  }
  for (const match of text.matchAll(BASE64_40)) {
    if (isAwsLikeSecret(match[0])) return true;
  }
  return false;
}

export interface LaunchPlan {
  url: string;
  prefilled: boolean;
  reason?: "too-long" | "possible-secret";
}

/** ChatGPT agent-mode URL, prefilled only when short enough and free of secret-looking values. */
export function planChatGptLaunch(prompt: string): LaunchPlan {
  // Too long is decided first: such a prompt is never put in the URL, so it needs no secret scan.
  const url = `${CHATGPT_AGENT_URL}&q=${encodeURIComponent(prompt)}`;
  if (url.length > MAX_URL_LENGTH) {
    return { url: CHATGPT_AGENT_URL, prefilled: false, reason: "too-long" };
  }
  if (looksLikeSecret(prompt)) {
    return { url: CHATGPT_AGENT_URL, prefilled: false, reason: "possible-secret" };
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
 * Documented deep link of the Claude desktop app (macOS, Windows, Linux): opens a new chat with `q`
 * in the prompt field, not sent (https://support.claude.com/en/articles/14729294). Fixed, not a setting.
 */
export const CLAUDE_DESKTOP_LINK_TEMPLATE = "claude://claude.ai/new?q={prompt}";

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
  const trimmed = href.trim();
  // Control characters (U+0000-U+001F, U+007F) can hide or split the real target.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return /^https?:\/\/[^\s]+$/i.test(trimmed);
}

export function buildAppLink(template: string, prompt: string): string {
  const fixed = template.trim() === CLAUDE_DESKTOP_LINK_TEMPLATE;
  const usable = fixed || validateAppLinkTemplate(template) === null ? template.trim() : DEFAULT_APP_LINK_TEMPLATE;
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
  const app = /^claude:/i.test(deepLink) ? "Claude" : "ChatGPT";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Opening ${app}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:3em auto;max-width:36em;padding:0 1em;color-scheme:light dark}</style>
</head><body>
<p>Opening ${app}&hellip; the prompt is also on your clipboard, so you can paste it. <a href="${href}">Open ${app}</a></p>
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
