import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";
import { composePrompt, planChatGptLaunch } from "../shared/browser-prompt";
import { LAUNCHER_UNAVAILABLE_MESSAGES } from "../shared/trampoline-host";

export type StartMode = "app" | "web-agent" | "copy-only";

export interface ModeSettings {
  startMode: StartMode;
  mobileStartMode: "copy-only" | "web-agent";
}

export const DEFAULT_MODES: ModeSettings = { startMode: "app", mobileStartMode: "copy-only" };

/** Desktop/web use `startMode`; iOS and Android use `mobileStartMode` (no mobile app deep link). */
export function effectiveMode(settings: ModeSettings): StartMode {
  return Platform.OS === "ios" || Platform.OS === "android" ? settings.mobileStartMode : settings.startMode;
}

/** Server RPC that stashes the prompt and returns the one-time launcher URL, or why it is off. */
export type StashFn = (
  prompt: string,
) => Promise<{ url: string } | { unavailable: keyof typeof LAUNCHER_UNAVAILABLE_MESSAGES }>;

export interface ActionResult {
  ok: boolean;
  message: string;
}

const PASTE_HINT = "Prompt copied. Paste it into ChatGPT (computer use).";

/** Copies the prompt with the computer-use header, then opens ChatGPT according to the mode. */
export async function startInChatGpt(
  title: string,
  body: string,
  mode: StartMode,
  stash: StashFn,
): Promise<ActionResult> {
  const prompt = composePrompt(title, body);
  let copied = true;
  try {
    await copyText(prompt);
  } catch {
    copied = false;
  }
  const copyFailed = "Could not copy. Select the prompt text and copy it manually.";

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
