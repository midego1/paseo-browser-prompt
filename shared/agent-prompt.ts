// Pure, dependency-free logic for the "Run with Paseo agent" action.
// Keep this file free of imports so `node --experimental-strip-types` can load it directly.

/** Defaults for the agent the card starts. Anthropic only; Claude Sonnet 5.5, thinking high. */
export const DEFAULT_AGENT_SETTINGS = {
  agentProvider: "claude",
  agentModel: "claude-sonnet-5-5",
  agentThinking: "high",
  /** Claude's "Always Ask" mode: every new tool use asks the owner first. */
  agentMode: "default",
  /** Ask "Start a Paseo agent to do these steps in your browser?" before launching. */
  confirmAgentLaunch: true,
} as const;

/**
 * Permission modes the card may start an agent in, per provider family. Only modes that ask before
 * tool use (or never run tools) are listed; every other mode, including bypass, auto-approve and
 * accept-edits modes, is refused. The first entry is the provider's ask-first fallback.
 */
export const ASK_FIRST_MODES: Readonly<Record<string, readonly string[]>> = {
  /** Claude: "Always Ask" (default) and "Plan Mode". */
  claude: ["default", "plan"],
  /** Oh My Pi: "Ask". */
  omp: ["ask"],
};

/** Modes known to skip or auto-approve permission prompts, for clearer settings errors. */
export const UNSAFE_MODES: readonly string[] = [
  "bypassPermissions",
  "bypass",
  "full-access",
  "full",
  "allow-all",
  "auto",
  "auto-review",
  "acceptEdits",
];

/** Provider family: `claude` for `claude` and custom ids such as `claude-work`, else the id. */
export function providerFamily(provider: string): string {
  const id = provider.trim().toLowerCase();
  const base = id.split(/[-_/]/)[0] ?? id;
  return Object.hasOwn(ASK_FIRST_MODES, base) ? base : id;
}

/** Ask-first modes for a provider, or null. Own keys only, so ids like `constructor` match nothing. */
function askFirstModes(provider: string): readonly string[] | null {
  const family = providerFamily(provider);
  return Object.hasOwn(ASK_FIRST_MODES, family) ? ASK_FIRST_MODES[family]! : null;
}

/** Error text for a provider/mode pair the card refuses to start, or null when it is allowed. */
export function agentModeError(provider: string, mode: string): string | null {
  const allowed = askFirstModes(provider);
  if (!allowed) {
    return `Provider "${provider.trim()}" has no known ask-first mode. Use ${Object.keys(ASK_FIRST_MODES).join(" or ")}.`;
  }
  if (!allowed.includes(mode.trim())) {
    return `Mode "${mode.trim()}" is not an ask-first mode for this provider. Allowed: ${allowed.join(", ")}.`;
  }
  return null;
}

export const AGENT_TITLE_PREFIX = "Browser: ";
export const MAX_AGENT_TITLE = 80;

export const AGENT_SAFETY_PREAMBLE = [
  "You are carrying out browser steps for the owner in the Paseo browser: the browser tabs inside the owner's own Paseo desktop app, where they are already signed in.",
  "",
  "Rules:",
  "1. Use ONLY the Paseo browser_* tools (browser_list_tabs, browser_new_tab, browser_navigate, browser_snapshot, browser_click, browser_fill, browser_type, browser_select, browser_keypress, browser_scroll, browser_wait, browser_screenshot and the other browser_* tools). Do not use Playwright or any browser on the server. Do not run shell commands. Do not edit files.",
  "2. Start with browser_list_tabs or browser_new_tab, then browser_snapshot. Always act on fresh element refs from the latest snapshot and take a new snapshot after every navigation or page change. If a tab reports that it \"has not painted\", ask the owner to bring the Paseo app and that tab to the front, then retry.",
  "3. STOP and ask the owner with your question tool (AskUserQuestion) before:",
  "   - typing any password, token, API key or other secret. Never ask the owner to paste a secret into the chat. Ask them to type it into the page themselves and reply \"done\".",
  "   - confirming anything destructive or irreversible: delete, revoke, merge, deploy, publish, payment, or changing security, permissions, billing, DNS or WAF settings.",
  "   - continuing whenever the page differs from what the steps expect.",
  "4. Never read out, print, copy or repeat secret values shown on a page (tokens, keys, passwords, recovery codes). Refer to them by name only.",
  "5. When finished, report: what was done, step by step; what is left for the owner; and a screenshot path if one is useful.",
].join("\n");

export function agentTitle(cardTitle: string, fallback = "browser steps"): string {
  const name = cardTitle.trim().replace(/\s+/g, " ") || fallback;
  const title = `${AGENT_TITLE_PREFIX}${name}`;
  return title.length > MAX_AGENT_TITLE ? `${title.slice(0, MAX_AGENT_TITLE - 1)}…` : title;
}

/** The agent's initial prompt: fixed safety preamble, then the card's steps verbatim. */
export function buildAgentPrompt(cardTitle: string, steps: string): string {
  const task = cardTitle.trim() ? `Task: ${cardTitle.trim()}\n\n` : "";
  return (
    `${AGENT_SAFETY_PREAMBLE}\n\n` +
    `${task}Steps (from the owner's browser-prompt card, verbatim):\n` +
    `<steps>\n${steps}\n</steps>\n`
  );
}

export interface AgentSettingsInput {
  agentProvider?: string;
  agentModel?: string;
  agentThinking?: string;
  agentMode?: string;
}

export interface ResolvedAgentConfig {
  provider: string;
  modeId: string;
  thinkingOptionId?: string;
}

/**
 * Turns the stored settings into an SDK agent config. Blank values fall back to the defaults, and a
 * mode outside the provider's ask-first list falls back to its ask-first mode. Throws for a provider
 * with no known ask-first mode: the card never starts an agent that skips permission prompts.
 */
export function resolveAgentConfig(settings: AgentSettingsInput): ResolvedAgentConfig {
  const pick = (value: string | undefined, fallback: string) => (value && value.trim()) || fallback;
  const provider = pick(settings.agentProvider, DEFAULT_AGENT_SETTINGS.agentProvider);
  const model = pick(settings.agentModel, DEFAULT_AGENT_SETTINGS.agentModel);
  const thinking = (settings.agentThinking ?? DEFAULT_AGENT_SETTINGS.agentThinking).trim();
  const providerModel = model.includes("/") ? model : `${provider}/${model}`;
  const providerId = providerModel.slice(0, providerModel.indexOf("/"));
  const allowed = askFirstModes(providerId);
  if (!allowed) throw new Error(agentModeError(providerId, "")!);
  let modeId = pick(settings.agentMode, allowed[0]!);
  if (!allowed.includes(modeId)) modeId = allowed[0]!;
  return {
    provider: providerModel,
    modeId,
    ...(thinking ? { thinkingOptionId: thinking } : {}),
  };
}

export type RunState = "starting" | "running" | "needs-input" | "done" | "failed" | "stopped" | "unknown";

/** Maps the observed agent snapshot to the card's run label. */
export function runStateFrom(
  snapshot: { status: string; attentionReason: string | null } | null,
  seenRunning: boolean,
): RunState {
  if (!snapshot) return "unknown";
  if (snapshot.status === "error") return "failed";
  if (snapshot.status === "closed") return "stopped";
  if (snapshot.attentionReason === "permission") return "needs-input";
  if (snapshot.status === "running") return "running";
  if (snapshot.status === "initializing") return "starting";
  if (snapshot.status === "idle") {
    if (snapshot.attentionReason === "error") return "failed";
    if (snapshot.attentionReason === "finished" || seenRunning) return "done";
    return "starting";
  }
  return "unknown";
}
