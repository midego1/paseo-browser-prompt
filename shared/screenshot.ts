// Pure helpers for the card's live screenshot thumbnail, and for keeping screenshots out of
// anything sent to a chat. Import-free so `node --experimental-strip-types` can load it.

/**
 * An inline Markdown image, including a <bracketed> destination, escaped brackets and parentheses in
 * alt text and destination, balanced parentheses and an optional title. Paseo turns each image a
 * tool returns (such as browser_screenshot's PNG) into an assistant message `![alt](file:///…)`
 * pointing at a private copy on the daemon host.
 */
const INLINE_IMAGE =
  /!\[(?:\\.|[^\]\\\n])*\]\(\s*(<[^>\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/g;
/** `![alt][ref]`, `![alt][]` and the shortcut `![ref]`. */
const REFERENCE_IMAGE = /!\[(?:\\.|[^\]\\\n])*\](?:\[(?:\\.|[^\]\\\n])*\])?/g;
/**
 * Reference definitions `[ref]: destination "title"` on their own line whose destination is an image
 * or a local file (file:, data:, an absolute path, or an image extension). Other `[x]: text` lines,
 * which reports use as plain text, are kept.
 */
const REFERENCE_DEFINITION =
  /^[ \t]{0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*<?(?:file:|data:|\/|[A-Za-z]:[\\/]|\S*\.(?:png|jpe?g|webp|gif|bmp|svg|avif)\b)\S*.*$/gim;
/** HTML image tags, also self-closing and spread over lines. */
const IMG_TAG = /<img\b[^>]*>/gi;
/** file:// URIs, and bare paths into Paseo's private image attachment directory. */
const FILE_URI = /\bfile:\/\/[^\s)>\]"']*/gi;
const ATTACHMENT_PATH = /(?:[A-Za-z]:)?[^\s()<>\[\]"']*paseo-attachments[^\s()<>\[\]"']*/g;

/**
 * Removes images and image locations from text bound for a chat: inline and reference-style
 * Markdown images (and reference definitions), <img> tags, file:// URIs and paths into Paseo's
 * attachment directory. Screenshots and their file paths never reach a chat.
 */
export function stripImagesForChat(text: string): string {
  return text
    .replace(INLINE_IMAGE, "")
    .replace(REFERENCE_DEFINITION, "")
    .replace(REFERENCE_IMAGE, "")
    .replace(IMG_TAG, "")
    .replace(FILE_URI, "[file omitted]")
    .replace(ATTACHMENT_PATH, "[file omitted]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The destination of a message that is exactly one inline Markdown image, else null. */
function soleImageSource(text: string): string | null {
  const trimmed = text.trim();
  INLINE_IMAGE.lastIndex = 0;
  const match = INLINE_IMAGE.exec(trimmed);
  if (!match || match.index !== 0 || match[0].length !== trimmed.length) return null;
  const raw = match[1]!;
  return raw.startsWith("<") ? raw.slice(1, -1) : raw.replace(/\\(.)/g, "$1");
}

/** True when the text is nothing but images (an image output of a tool). */
export function isImageOnly(text: string): boolean {
  if (!/!\[|<img\b/i.test(text)) return false;
  return !stripImagesForChat(text).replace(/\[file omitted\]/g, "").trim();
}

const ATTACHMENT_DIR = /^paseo-attachments(?:-[A-Za-z0-9_]+)?$/;
const ATTACHMENT_FILE = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif)$/;

/**
 * Accepts only the shape Paseo gives a tool's image: a `file://` URI or an absolute path whose file
 * is `<64 hex>.<png|jpg|jpeg|webp|gif>` directly inside a `paseo-attachments[-suffix]` directory.
 * No http(s) or other schemes, no query or fragment, no traversal. Returns the source unchanged
 * (the form the host's Markdown renderer gets from Paseo itself), or null.
 */
export function safeImageSource(source: string): string | null {
  const value = source.trim();
  if (!value || value.length > 1024 || /[\s?#"'`<>\\]/.test(value)) return null;
  let path: string;
  if (/^file:\/\//i.test(value)) path = value.slice(7);
  else if (value.startsWith("/") && !value.startsWith("//")) path = value;
  else return null;
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").slice(1);
  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (decoded.some((segment) => segment === "" || segment === "." || segment === ".." || /[\/\\\u0000-\u001f]/.test(segment))) return null;
  const file = decoded[decoded.length - 1] ?? "";
  const dir = decoded[decoded.length - 2] ?? "";
  if (!ATTACHMENT_FILE.test(file) || !ATTACHMENT_DIR.test(dir)) return null;
  return value;
}

export function isScreenshotTool(name: unknown): boolean {
  return typeof name === "string" && /(^|__|[.:/])browser_screenshot$/.test(name);
}

type Item = { type: string; text?: unknown; name?: unknown };

/**
 * Tracks the latest browser screenshot in a run's timeline: the first assistant message after a
 * browser_screenshot tool call, when it is a lone image with a Paseo attachment source. Keeps one
 * reference only (the image source), never image data.
 */
export function createScreenshotTracker() {
  let latest: string | null = null;
  let afterScreenshot = false;
  return {
    push(item: Item): void {
      if (item.type === "tool_call") {
        afterScreenshot = isScreenshotTool(item.name);
        return;
      }
      if (item.type !== "assistant_message" || typeof item.text !== "string") {
        if (item.type === "user_message") afterScreenshot = false;
        return;
      }
      // Only the first assistant message after the call, and only when it is a lone image.
      if (afterScreenshot) {
        const source = soleImageSource(item.text);
        const safe = source ? safeImageSource(source) : null;
        if (safe) latest = safe;
      }
      afterScreenshot = false;
    },
    latest(): string | null {
      return latest;
    },
  };
}

/** The latest browser screenshot reference in a list of timeline items, or null. */
export function latestScreenshot(items: readonly Item[]): string | null {
  const tracker = createScreenshotTracker();
  for (const item of items) tracker.push(item);
  return tracker.latest();
}

/** Markdown the host renders as the thumbnail; the source was checked by `safeImageSource`. */
export function screenshotMarkdown(source: string): string {
  return `![Latest browser screenshot](${source})`;
}
