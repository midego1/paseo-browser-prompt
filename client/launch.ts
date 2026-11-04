import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";
import { CHATGPT_EXTENSION_HEADER, composePrompt, planChatGptLaunch } from "../shared/browser-prompt";
import { LAUNCHER_UNAVAILABLE_MESSAGES } from "../shared/trampoline-host";

export type StartMode = "app" | "web-agent" | "extension" | "copy-only";

/** The way highlighted on the card: a way to open ChatGPT, or a Paseo agent in either browser. */
export type UsualWay = StartMode | "paseo" | "chrome";

export interface ModeSettings {
  startMode: UsualWay;
  mobileStartMode: Exclude<UsualWay, "app" | "extension">;
}

export const DEFAULT_MODES: ModeSettings = { startMode: "app", mobileStartMode: "copy-only" };

/** Desktop/web use `startMode`; iOS and Android use `mobileStartMode` (no mobile app deep link). */
export function effectiveMode(settings: ModeSettings): UsualWay {
  return Platform.OS === "ios" || Platform.OS === "android" ? settings.mobileStartMode : settings.startMode;
}

/** Server RPC that stashes the prompt and returns the one-time launcher URL, or why it is off. */
/** How the Command Center opens ChatGPT when the usual way is a Paseo agent, which it cannot start. */
export function chatGptMode(way: UsualWay): StartMode {
  if (way !== "paseo" && way !== "chrome") return way;
  return Platform.OS === "ios" || Platform.OS === "android" ? "copy-only" : "app";
}

export type StashFn = (
  prompt: string,
) => Promise<{ url: string } | { unavailable: keyof typeof LAUNCHER_UNAVAILABLE_MESSAGES }>;

export interface ActionResult {
  ok: boolean;
  message: string;
}

const PASTE_HINT = "Prompt copied. Paste it into a ChatGPT Work chat.";
const EXTENSION_HINT =
  "Prompt copied. In Chrome, open the ChatGPT side panel (its toolbar icon, or ⌘⇧. on a Mac), paste and send.";

/** Copies the prompt with the computer-use header, then opens ChatGPT according to the mode. */
export async function startInChatGpt(
  title: string,
  body: string,
  mode: StartMode,
  stash: StashFn,
): Promise<ActionResult> {
  const prompt = composePrompt(title, body, mode === "extension" ? CHATGPT_EXTENSION_HEADER : undefined);
  let copied = true;
  try {
    await copyText(prompt);
  } catch {
    copied = false;
  }
  const copyFailed = "Could not copy. Select the prompt text and copy it manually.";

  // Nothing outside the extension can open its side panel or hand it a prompt, so the owner pastes.
  if (mode === "extension") {
    return copied ? { ok: true, message: EXTENSION_HINT } : { ok: false, message: copyFailed };
  }

  if (mode === "copy-only") {
    return copied ? { ok: true, message: PASTE_HINT } : { ok: false, message: copyFailed };
  }

  if (mode === "app") {
    let url: string;
    try {
      const outcome = await stash(prompt);
      if ("unavailable" in outcome) {
        // e.g. "ChatGPT launcher needs Tailscale on this host": the clipboard is the fallback.
        const reason = LAUNCHER_UNAVAILABLE_MESSAGES[outcome.unavailable];
        return copied ? { ok: false, message: `${reason}. ${PASTE_HINT}` } : { ok: false, message: `${reason}. ${copyFailed}` };
      }
      url = outcome.url;
    } catch {
      return copied
        ? { ok: false, message: `ChatGPT launcher unreachable. ${PASTE_HINT}` }
        : { ok: false, message: `ChatGPT launcher unreachable. ${copyFailed}` };
    }
    try {
      await openExternalUrl(url);
    } catch {
      return { ok: false, message: copied ? `Could not open ChatGPT. ${PASTE_HINT}` : copyFailed };
    }
    return {
      ok: true,
      message: copied ? "Opening the ChatGPT app (prompt also copied)." : "Opening the ChatGPT app.",
    };
  }

  const plan = planChatGptLaunch(prompt);
  try {
    await openExternalUrl(plan.url);
  } catch {
    return { ok: false, message: copied ? `Could not open ChatGPT. ${PASTE_HINT}` : "Could not open ChatGPT or copy the prompt." };
  }
  if (plan.prefilled) {
    return { ok: true, message: copied ? "Opened ChatGPT agent mode (prompt also copied)." : "Opened ChatGPT agent mode." };
  }
  if (!copied) return { ok: false, message: `Opened ChatGPT, but ${copyFailed.toLowerCase()}` };
  return {
    ok: true,
    message:
      plan.reason === "possible-secret"
        ? `Prompt not put in the URL (looks like it holds a secret). ${PASTE_HINT}`
        : PASTE_HINT,
  };
}

export async function copyPrompt(title: string, body: string): Promise<ActionResult> {
  try {
    await copyText(composePrompt(title, body));
    return { ok: true, message: "Prompt copied." };
  } catch {
    return { ok: false, message: "Could not copy. Select the prompt text and copy it manually." };
  }
}

/** Most recently rendered complete prompt, for the Command Center item. In-memory per client. */
export interface SeenPrompt {
  agentId: string;
  title: string;
  text: string;
  at: number;
}

let lastSeen: SeenPrompt | null = null;
let lastModes: ModeSettings = DEFAULT_MODES;

/** Cards remember the host's modes so the Command Center item can follow them. */
export function rememberModes(modes: ModeSettings): void {
  lastModes = modes;
}

export function getRememberedModes(): ModeSettings {
  return lastModes;
}

export function recordSeenPrompt(prompt: SeenPrompt): void {
  if (lastSeen === null || prompt.at >= lastSeen.at) lastSeen = prompt;
}

export function getLastSeenPrompt(): SeenPrompt | null {
  return lastSeen;
}
