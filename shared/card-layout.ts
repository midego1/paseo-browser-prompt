// The card's layout and its default ways, as pure functions (no React, no Paseo) so the unit tests
// can load them with `node --experimental-strip-types`. client/card.tsx renders what these decide.
//
// The card reads top to bottom: header, steps, the state area (the only part that changes), then a
// quiet row with Copy steps and Mark done. One filled button per state at most: Run (new) or Take over
// the browser (needs you). Running and done have none on purpose.

/** The browsers a Run (or a "Run once in…" row) starts a Paseo agent in. */
export type RunWay = "signed-in" | "server" | "paseo" | "chrome";
export const RUN_WAYS = ["signed-in", "server", "paseo", "chrome"] as const satisfies readonly RunWay[];

/** Where Send to ChatGPT goes: the desktop app (through the launcher), chatgpt.com, or the clipboard. */
export type ChatGptTarget = "app" | "web-agent" | "copy-only";
/** Where Send to Claude goes: the Claude desktop app (through the launcher), or the clipboard. */
export type ClaudeTarget = "claude-desktop" | "copy-only";

/** Today's "usual way" setting (`startMode` / `mobileStartMode` in `preferences`). */
export type UsualWay = "app" | "web-agent" | "copy-only" | "claude-desktop" | RunWay;

/** The card settings document's choices; "" = follow the remembered usual way (see below). */
export interface CardChoices {
  runWay: "" | RunWay;
  chatGpt: "" | ChatGptTarget;
  claude: ClaudeTarget;
}

export const DEFAULT_CARD_CHOICES: CardChoices = { runWay: "", chatGpt: "", claude: "claude-desktop" };

/** The default way when neither the card settings nor the usual way name a browser (the design's default). */
export const FALLBACK_RUN_WAY: RunWay = "signed-in";

const isRunWay = (way: string): way is RunWay => (RUN_WAYS as readonly string[]).includes(way);

/**
 * The browser the Run button uses. The card setting wins; until the owner picks one there, a usual way
 * that is a browser keeps working as before, and any other usual way (ChatGPT, Claude, Copy only)
 * falls back to the signed-in Server browser. Claude in Chrome only when its launch would work.
 */
export function defaultRunWay(choices: Pick<CardChoices, "runWay">, usual: UsualWay, chromeAvailable: boolean): RunWay {
  const pick = choices.runWay || (isRunWay(usual) ? usual : FALLBACK_RUN_WAY);
  return pick === "chrome" && !chromeAvailable ? FALLBACK_RUN_WAY : pick;
}

/**
 * Where Send to ChatGPT goes. The card setting wins; until the owner picks one there, today's usual
 * way decides when it is a ChatGPT way (web or copy only), else the desktop app. Phones have no
 * ChatGPT app link, so the desktop app becomes the phone's own usual ChatGPT way (copy only by default).
 */
export function chatGptTarget(choices: Pick<CardChoices, "chatGpt">, usual: UsualWay, mobile: boolean): ChatGptTarget {
  const remembered: ChatGptTarget | null = usual === "web-agent" || usual === "copy-only" ? usual : null;
  if (mobile) {
    if (choices.chatGpt && choices.chatGpt !== "app") return choices.chatGpt;
    return remembered ?? "copy-only";
  }
  return choices.chatGpt || remembered || "app";
}

/** The card's state area. "ended": a run that failed, was stopped or cannot be read (not done). */
export type CardPhase = "new" | "running" | "needs-you" | "ended" | "done";

/**
 * Which state area shows. `runState` is the shown run state (null without a run); `done` is the
 * owner's done mark. A run that is going wins over the mark, so its Stop and owner prompts stay
 * reachable; a finished run or a mark folds the card.
 */
export function cardPhase(input: { runState: string | null; done: boolean }): CardPhase {
  const state = input.runState;
  if (state === "starting" || state === "running") return "running";
  if (state === "needs-input" || state === "asking") return "needs-you";
  if (input.done || state === "done") return "done";
  if (state === null) return "new";
  return "ended";
}

export interface CardLayoutInput {
  phase: CardPhase;
  /** iOS or Android: no Claude desktop app and no ChatGPT app link there. */
  mobile: boolean;
  /** Paseo's compact layout (a phone-width column): the Send buttons get their own row. */
  compact: boolean;
  /** The folded done card's Show steps was pressed. */
  expanded: boolean;
}

export interface CardLayout {
  /** The monospace steps box. */
  showSteps: boolean;
  /** The Run split button (Run, or Run again once there was a run). */
  showRun: boolean;
  /** Run is the filled (primary) button. */
  runPrimary: boolean;
  runLabel: "Run" | "Run again";
  showSendChatGpt: boolean;
  showSendClaude: boolean;
  /** Phone: the Send buttons sit on their own row after a "Send to" caption. */
  sendOwnRow: boolean;
  /** Watch and Stop for a run that is going. */
  showWatch: boolean;
  showStop: boolean;
  /** The amber needs-you panel (Take over, owner prompts). */
  showNeedsPanel: boolean;
  /** The folded done card's Show steps / Hide steps toggle. */
  showFoldToggle: boolean;
  /** Copy steps and Mark done (or Not done) in the quiet last row: always, so no state loses them. */
  showQuietRow: true;
}

/** What the card shows in each state, on a phone and in the chat column. */
export function cardLayout(input: CardLayoutInput): CardLayout {
  const { phase, mobile, compact, expanded } = input;
  const active = phase === "running" || phase === "needs-you";
  const folded = phase === "done" && !expanded;
  const showRun = !active;
  // The Send buttons hide while a run is going and in the folded done card.
  const showSend = !active && !folded;
  return {
    showSteps: !folded,
    showRun,
    runPrimary: phase === "new" || phase === "ended",
    runLabel: phase === "new" ? "Run" : "Run again",
    showSendChatGpt: showSend,
    // No Claude desktop app on a phone or tablet, so no working target there (as before).
    showSendClaude: showSend && !mobile,
    sendOwnRow: compact,
    showWatch: active,
    showStop: active,
    showNeedsPanel: phase === "needs-you",
    showFoldToggle: phase === "done",
    showQuietRow: true,
  };
}

/** One row of the "Run once in…" menu. */
export interface RunMenuItem {
  way: RunWay;
  title: string;
  detail: string;
  isDefault: boolean;
}

export const RUN_WAY_TITLES: Record<RunWay, string> = {
  "signed-in": "Server browser · signed in",
  server: "Server browser · clean",
  paseo: "Paseo browser",
  chrome: "Claude in Chrome tab",
};

export const RUN_WAY_DETAILS: Record<RunWay, string> = {
  "signed-in": "Your logins on the Paseo server. Take over from any device.",
  server: "No logins. For public pages.",
  paseo: "Tabs in the Paseo app on your Mac. The app must be open.",
  chrome: "A Paseo agent in your Chrome, through Claude in Chrome.",
};

/** How a menu row and the Run button name a way for screen readers ("in the Paseo browser"). */
export const RUN_WAY_A11Y: Record<RunWay, string> = {
  "signed-in": "in your signed-in browser on the Paseo server",
  server: "in a browser on the Paseo server, not signed in to your accounts",
  paseo: "in the Paseo browser",
  chrome: "in a tab of your Chrome, through Claude in Chrome",
};

/**
 * The "Run once in…" rows: every browser, the default marked. A row runs once and never changes the
 * default (the menu's last row, "Change the default…", opens the settings). Claude in Chrome shows
 * only when its launch would work (a Claude provider), as before.
 */
export function runMenuItems(defaultWay: RunWay, chromeAvailable: boolean): RunMenuItem[] {
  return RUN_WAYS.filter((way) => way !== "chrome" || chromeAvailable).map((way) => ({
    way,
    title: RUN_WAY_TITLES[way],
    detail: RUN_WAY_DETAILS[way],
    isDefault: way === defaultWay,
  }));
}

/** Names for the Send buttons and their one-line note after a send. */
export const SEND_NAMES = { chatgpt: "ChatGPT", claude: "Claude" } as const;
export type SendTo = keyof typeof SEND_NAMES;

/** The note under the actions after a send: a hand-off does not report back, so Mark done matters. */
export function sentNote(to: SendTo): string {
  return `Sent to ${SEND_NAMES[to]}. It does not report back here, so mark the card done when it has finished.`;
}

/**
 * The progress bar's segments, one per step, for up to MAX_SEGMENTS steps (more: one continuous bar,
 * null). Steps before `step` are done, `step` is current, the rest pending; a finished run is all done.
 */
export const MAX_SEGMENTS = 12;
export function progressSegments(step: number, total: number, finished: boolean): ("done" | "current" | "pending")[] | null {
  if (!Number.isInteger(total) || total < 1 || total > MAX_SEGMENTS) return null;
  if (finished) return Array.from({ length: total }, () => "done");
  return Array.from({ length: total }, (_, i) => (i + 1 < step ? "done" : i + 1 === step ? "current" : "pending"));
}

/** How long Stop waits for its second press before it goes back to "Stop". */
export const STOP_CONFIRM_MS = 4000;

/** Parses #rgb, #rrggbb or rgb()/rgba() into 0–255 channels; null for anything else. */
function parseColor(color: string): [number, number, number] | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/**
 * `amount` of `color` over `base` as a fixed #rrggbb (React Native has no color-mix). A color it
 * cannot read gives `base`, so a tint never comes out as something unreadable.
 */
export function mixColor(color: string, base: string, amount: number): string {
  const a = parseColor(color);
  const b = parseColor(base);
  if (!a || !b) return base;
  const t = Math.min(1, Math.max(0, amount));
  return `#${a.map((channel, i) => Math.round(channel * t + b[i]! * (1 - t)).toString(16).padStart(2, "0")).join("")}`;
}

/** Whether a surface is dark (relative luminance under 0.4); unreadable colors count as light. */
export function isDarkColor(color: string): boolean {
  const rgb = parseColor(color);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}

/** The card's fixed tints, computed once per theme (the design's color-mix values). */
export function cardTints(colors: { accent: string; surface1: string; border: string; statusWarning: string; statusSuccess: string }) {
  const dark = isDarkColor(colors.surface1);
  return {
    /** The accent as text, focus ring, Default tag and progress: lightened in dark so it stays readable. */
    accentText: dark ? mixColor(colors.accent, "#ffffff", 0.48) : colors.accent,
    warningTint: mixColor(colors.statusWarning, colors.surface1, 0.09),
    warningLine: mixColor(colors.statusWarning, colors.surface1, 0.55),
    successLine: mixColor(colors.statusSuccess, colors.border, 0.45),
  };
}
