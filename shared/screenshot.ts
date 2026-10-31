// Pure helpers for the card's live screenshot thumbnail, and for keeping screenshots out of
// anything sent to a chat. Imports only pure shared modules so `node --experimental-strip-types` can load it.
import { latestStep as latestStepMarker } from "./steps.ts";

/**
 * An inline Markdown image, including a <bracketed> destination, escaped brackets and parentheses in
 * alt text and destination, balanced parentheses and an optional title. Paseo turns each image a
 * tool returns (such as browser_screenshot's PNG) into an assistant message `![alt](file:///…)`
 * pointing at a private copy on the daemon host.
 */
const INLINE_IMAGE =
  /!\[(?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n])*\])*\]\(\s*(<[^>\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/g;
/** `![alt][ref]`, `![alt][]` and the shortcut `![ref]` (alt text may hold one level of [...]). */
const REFERENCE_IMAGE = /!\[(?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n])*\])*\](?:\[(?:\\.|[^[\]\\\n])*\])?/g;
/**
 * Reference definitions `[ref]: destination "title"` on their own line whose destination is an image
 * or a local file (file:, data:, an absolute path, or an image extension). Other `[x]: text` lines,
 * which reports use as plain text, are kept.
 */
const REFERENCE_DEFINITION =
  /^[ \t]{0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*<?(?:file:|data:|\/|[A-Za-z]:[\\/]|\S*\.(?:png|jpe?g|webp|gif|bmp|svg|avif)\b)\S*.*$/gim;
/** HTML image tags, also self-closing and spread over lines. */
const IMG_TAG = /<img\b[^<>]*>/gi;
/** file:// URIs, and bare paths into Paseo's private image attachment directory. */
const FILE_URI = /\bfile:\/\/[^\s)>\]"']*/gi;
const ATTACHMENT_PATH = /(?<![^\s()<>\[\]"'])(?:[A-Za-z]:)?[^\s()<>\[\]"']*paseo-attachments[^\s()<>\[\]"']*/g;

/**
 * Text longer than this is cut before stripping. Chat-bound text is cut much shorter afterwards
 * (reports 4,000, questions 1,500 characters), so nothing that would be sent is lost, and the
 * regular expressions below never see unbounded input.
 */
export const MAX_STRIP_INPUT = 20_000;
/** Paseo's image messages are one short `![Image](file:///…)` line; anything longer is not one. */
export const MAX_IMAGE_MESSAGE = 4096;

/**
 * Removes images and image locations from text bound for a chat: inline and reference-style
 * Markdown images (and reference definitions), <img> tags, file:// URIs and paths into Paseo's
 * attachment directory. Screenshots and their file paths never reach a chat. Linear in the input:
 * alt text holds at most one level of balanced `[...]` (an inner part never contains `[`), an
 * `<img` tag never contains `<`, attachment paths only match at the start of a token, and input is
 * cut at MAX_STRIP_INPUT. Images with deeper nesting are not removed as a whole; their file URI or
 * attachment path still is, and `defuseImages` keeps them from rendering.
 */
export function stripImagesForChat(text: string): string {
  const input = text.length > MAX_STRIP_INPUT ? text.slice(0, MAX_STRIP_INPUT) : text;
  return input
    .replace(INLINE_IMAGE, "")
    .replace(REFERENCE_DEFINITION, "")
    .replace(REFERENCE_IMAGE, "")
    .replace(IMG_TAG, "")
    .replace(FILE_URI, "[file omitted]")
    .replace(ATTACHMENT_PATH, "[file omitted]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Turns every remaining `![` into `!\\[`, so nothing left after stripping can render as an image
 * (for example one with deeply nested alt text and a remote URL). Linear.
 */
export function defuseImages(text: string): string {
  return text.replace(/!\[/g, "!\\[");
}

/** The destination of a message that is exactly one inline Markdown image, else null. */
function soleImageSource(text: string): string | null {
  if (text.length > MAX_IMAGE_MESSAGE) return null;
  const trimmed = text.trim();
  INLINE_IMAGE.lastIndex = 0;
  const match = INLINE_IMAGE.exec(trimmed);
  if (!match || match.index !== 0 || match[0].length !== trimmed.length) return null;
  const raw = match[1]!;
  return raw.startsWith("<") ? raw.slice(1, -1) : raw.replace(/\\(.)/g, "$1");
}

/** True when the text is nothing but images (an image output of a tool). */
export function isImageOnly(text: string): boolean {
  if (text.length > MAX_IMAGE_MESSAGE || !/!\[|<img\b/i.test(text)) return false;
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

type Item = { type: string; text?: unknown; name?: unknown; detail?: unknown; error?: unknown };

/**
 * Shown on the card when a run's screenshot failed because its tab was hidden. Paseo's browser only
 * captures a tab the desktop app is showing, and no plugin API can show the run's own tab.
 */
export const SCREENSHOT_BLOCKED_HINT =
  "Screenshots need the run's browser tab to be visible in your Paseo app (for example in a split next to the chat). This run stopped taking them.";

/** Paseo's browser host refuses screenshots of a tab the desktop app is not showing. */
const UNPAINTED = /has not painted|not painted yet/i;

/**
 * A browser_screenshot call that failed because its tab was not visible in the owner's Paseo app.
 * Browser tool errors come back as an ordinary result whose text carries the error, so the call's
 * output and error are both checked (only their first 4,000 characters).
 */
export function isUnpaintedScreenshot(item: Item): boolean {
  if (item.type !== "tool_call" || !isScreenshotTool(item.name)) return false;
  for (const part of [item.detail, item.error]) {
    if (part == null) continue;
    let text: string;
    try {
      text = typeof part === "string" ? part : JSON.stringify(part);
    } catch {
      continue;
    }
    if (UNPAINTED.test(text.slice(0, 4000))) return true;
  }
  return false;
}

/** Screenshots remembered per run: one path string per step, at most this many steps. */
export const MAX_STEP_SCREENSHOTS = 20;

export interface StepScreenshot {
  /** The step whose marker preceded the screenshot; 0 when no marker came before it. */
  step: number;
  source: string;
}

/**
 * Tracks a run's browser screenshots in its timeline: the first assistant message after a
 * browser_screenshot call, when it is a lone image with a Paseo attachment source. Each one belongs
 * to the step whose `[browser-prompt step N/M]` marker came last before it; a later screenshot in
 * the same step replaces the earlier one. Keeps path strings only, at most MAX_STEP_SCREENSHOTS
 * steps (the least recently captured are dropped), never image data.
 *
 * `total` is the card's step count, used to read markers in whole messages; a live stream that
 * splits markers across chunks passes the step it read itself through `setStep`.
 */
export function createScreenshotTracker(total = 0) {
  let afterScreenshot = false;
  let blocked = false;
  let currentStep = 0;
  /** Step -> source, in order of capture (least recent first). */
  const byStep = new Map<number, string>();
  let latestStepNumber: number | null = null;
  return {
    push(item: Item): void {
      if (item.type === "tool_call") {
        afterScreenshot = isScreenshotTool(item.name);
        if (isUnpaintedScreenshot(item)) blocked = true;
        return;
      }
      if (item.type !== "assistant_message" || typeof item.text !== "string") {
        if (item.type === "user_message") afterScreenshot = false;
        return;
      }
      // Only the first assistant message after the call, and only when it is a lone image.
      const source = afterScreenshot ? soleImageSource(item.text) : null;
      const safe = source ? safeImageSource(source) : null;
      afterScreenshot = false;
      if (safe) {
        byStep.delete(currentStep);
        byStep.set(currentStep, safe);
        while (byStep.size > MAX_STEP_SCREENSHOTS) byStep.delete(byStep.keys().next().value!);
        latestStepNumber = currentStep;
        return;
      }
      if (total > 0) {
        const marker = latestStepMarker(item.text, total);
        if (marker) currentStep = marker.step;
      }
    },
    /** The step a live stream read from its own buffer (markers can be split across chunks). */
    setStep(step: number | null | undefined): void {
      if (typeof step === "number" && step >= 1) currentStep = step;
    },
    latest(): string | null {
      return latestStepNumber === null ? null : (byStep.get(latestStepNumber) ?? null);
    },
    /** The step of the latest screenshot, or null when there is none. */
    latestStep(): number | null {
      return latestStepNumber;
    },
    /** One screenshot per step, in step order. */
    steps(): StepScreenshot[] {
      return [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([step, source]) => ({ step, source }));
    },
    /** A screenshot failed because the run's tab was not visible; the run stops taking them. */
    blocked(): boolean {
      return blocked;
    },
    /**
     * Keeps steps an older tracker knew that this one (a newer, shorter tail read) does not; they
     * count as captured before this tracker's own. The cap still applies.
     */
    adoptOlder(older: { steps(): StepScreenshot[] }): void {
      const mine = [...byStep.entries()];
      byStep.clear();
      for (const { step, source } of older.steps()) if (!mine.some(([own]) => own === step)) byStep.set(step, source);
      for (const [step, source] of mine) byStep.set(step, source);
      while (byStep.size > MAX_STEP_SCREENSHOTS) byStep.delete(byStep.keys().next().value!);
    },
  };
}

/** One screenshot per step from a list of timeline items (`total` = the card's step count). */
export function stepScreenshots(items: readonly Item[], total: number): StepScreenshot[] {
  const tracker = createScreenshotTracker(total);
  for (const item of items) tracker.push(item);
  return tracker.steps();
}

/** The latest browser screenshot reference in a list of timeline items, or null. */
export function latestScreenshot(items: readonly Item[]): string | null {
  const tracker = createScreenshotTracker();
  for (const item of items) tracker.push(item);
  return tracker.latest();
}

/** Markdown the host renders as the thumbnail; the source was checked by `safeImageSource`. */
export function screenshotMarkdown(source: string, step?: number): string {
  return `![${step ? `Screenshot after step ${step}` : "Latest browser screenshot"}](${source})`;
}

export type ThumbnailMode = "all" | "latest";
export const THUMBNAIL_MODES = ["all", "latest"] as const;

/** Thumbnail sizes in the card, in layout pixels. */
export const THUMB_MIN = 140;
export const THUMB_MAX = 180;
export const THUMB_GAP = 8;
export const THUMB_SINGLE_MAX = 240;

export type ThumbnailLayout =
  | { kind: "latest"; size: number }
  | { kind: "row"; size: number }
  | { kind: "scroll"; size: number };

/**
 * How the card shows its screenshots in `width` layout pixels:
 * - "row": every step side by side when all fit at 140 px or more (up to 180 px each);
 * - "scroll": a horizontal strip of 160 px thumbnails when at least two fit but not all of them,
 *   so step order stays readable and phones can swipe it;
 * - "latest": only the newest one (up to 240 px) when there is one screenshot, the setting asks for
 *   it, or the card is too narrow for two.
 */
export function thumbnailLayout(width: number, count: number, mode: ThumbnailMode): ThumbnailLayout {
  const single = Math.max(0, Math.min(THUMB_SINGLE_MAX, Math.floor(width)));
  if (mode === "latest" || count <= 1 || !(width > 0)) return { kind: "latest", size: single };
  const allFit = count * THUMB_MIN + (count - 1) * THUMB_GAP;
  if (width >= allFit) {
    const size = Math.min(THUMB_MAX, Math.floor((width - (count - 1) * THUMB_GAP) / count));
    return { kind: "row", size };
  }
  if (width >= 2 * THUMB_MIN + THUMB_GAP) return { kind: "scroll", size: 160 };
  return { kind: "latest", size: single };
}
