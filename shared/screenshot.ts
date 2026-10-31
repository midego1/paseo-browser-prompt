// Pure helpers for the card's live screenshot thumbnail, and for keeping screenshots out of
// anything sent to a chat. Import-free so `node --experimental-strip-types` can load it.

/**
 * A Markdown image. Paseo turns each image a tool returns (such as browser_screenshot's PNG) into
 * an assistant message `![alt](path)`, with the path of a private copy on the daemon host.
 */
const IMAGE_MARKDOWN = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;

/** Removes Markdown images, so screenshots and their file paths never reach a chat. */
export function stripMarkdownImages(text: string): string {
  return text.replace(IMAGE_MARKDOWN, "").replace(/\n{3,}/g, "\n\n");
}

/** True when the text is nothing but Markdown images (an image output of a tool). */
export function isImageOnly(text: string): boolean {
  IMAGE_MARKDOWN.lastIndex = 0;
  return IMAGE_MARKDOWN.test(text) && !stripMarkdownImages(text).trim();
}

/** Accepts an absolute path on the daemon host or an http(s) URL, nothing else (no data: URIs). */
export function safeImageSource(source: string): string | null {
  const value = source.trim();
  if (!value || value.length > 1024 || /[\s()<>"'`\\]/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/(?!\/)/.test(value) && !value.split("/").includes("..")) return value;
  return null;
}

export function isScreenshotTool(name: unknown): boolean {
  return typeof name === "string" && /(^|__|[.:/])browser_screenshot$/.test(name);
}

type Item = { type: string; text?: unknown; name?: unknown };

/**
 * Tracks the latest browser screenshot in a run's timeline: an image message that directly follows
 * a browser_screenshot tool call. Keeps one reference only (the image path), never image data.
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
      IMAGE_MARKDOWN.lastIndex = 0;
      let found: string | null = null;
      for (let match = IMAGE_MARKDOWN.exec(item.text); match; match = IMAGE_MARKDOWN.exec(item.text)) {
        found = safeImageSource(match[1]!) ?? found;
      }
      if (found && afterScreenshot) latest = found;
      if (!isImageOnly(item.text)) afterScreenshot = false;
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
