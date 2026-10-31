// Pure, dependency-free logic for the "Run with Paseo agent" action.
// Keep this file free of imports so `node --experimental-strip-types` can load it directly.

/** Defaults for the agent the card starts. Anthropic only; Claude Sonnet 5.5, thinking high. */
export const DEFAULT_AGENT_SETTINGS = {
  agentProvider: "claude",
  agentModel: "claude-sonnet-5-5",
  agentThinking: "high",
  /**
   * Claude's "Auto mode": a model classifier reviews permission prompts. Always Ask ("default") and
   * Plan stay selectable; bypass and accept-edits modes are refused.
   */
  agentMode: "auto",
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

/**
 * Modes where a model classifier, not the owner, reviews permission prompts. The provider's default
 * for browser runs when it has one; never counted as ask-first (report back treats it as unsafe).
 */
export const CLASSIFIER_MODES: Readonly<Record<string, readonly string[]>> = {
  /** Claude: "Auto mode" (needs the Anthropic API; Paseo refuses it on Bedrock and Vertex). */
  claude: ["auto"],
};

/**
 * Modes known to skip or auto-approve permission prompts, for clearer settings errors. Claude's
 * `auto` is the one exception the card accepts (and its default), as the classifier mode above.
 */
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

function classifierModes(provider: string): readonly string[] {
  const family = providerFamily(provider);
  return Object.hasOwn(CLASSIFIER_MODES, family) ? CLASSIFIER_MODES[family]! : [];
}

/** True only for a known ask-first mode: the owner approves each new tool use. */
export function isAskFirstMode(provider: string, mode: string): boolean {
  return askFirstModes(provider)?.includes(mode.trim()) ?? false;
}

/** True for a mode where a model classifier, not the owner, approves tool calls (Claude Auto mode). */
export function isClassifierMode(provider: string, mode: string): boolean {
  return askFirstModes(provider) !== null && classifierModes(provider).includes(mode.trim());
}

/** Error text for a provider/mode pair the card refuses to start, or null when it is allowed. */
export function agentModeError(provider: string, mode: string): string | null {
  const allowed = askFirstModes(provider);
  if (!allowed) {
    return `Provider "${provider.trim()}" has no known ask-first mode. Use ${Object.keys(ASK_FIRST_MODES).join(" or ")}.`;
  }
  if (isAskFirstMode(provider, mode) || isClassifierMode(provider, mode)) return null;
  const classifier = classifierModes(provider);
  const extra = classifier.length ? `, or ${classifier.join(", ")} (classifier-reviewed, the default)` : "";
  return `Mode "${mode.trim()}" is not allowed for this provider. Allowed: ${allowed.join(", ")} (ask first)${extra}.`;
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

/**
 * Whether a browser run may be in `actualMode`: any ask-first or classifier mode of the provider
 * (for Claude `default`, `plan` and `auto`; drift between them is fine). Bypass, accept-edits and
 * every other mode are not.
 */
export function runModeAllowed(provider: string, actualMode: string): boolean {
  return isAskFirstMode(provider, actualMode) || isClassifierMode(provider, actualMode);
}

/** The mode a provider's browser runs use when none (or a refused one) is set: Auto mode for Claude. */
export function defaultModeFor(provider: string): string | null {
  const askFirst = askFirstModes(provider);
  if (!askFirst) return null;
  return classifierModes(provider)[0] ?? askFirst[0]!;
}

/** Provider id of a `provider/model` config value. */
export function providerOf(providerModel: string): string {
  const slash = providerModel.indexOf("/");
  return slash >= 0 ? providerModel.slice(0, slash) : providerModel;
}

/**
 * Extra rule for classifier-reviewed modes: a tool call being approved is not the owner's approval,
 * so rule 3's stops must be real questions to the owner.
 */
export const CLASSIFIER_MODE_RULE = [
  "6. You run in Auto mode: a model classifier, not the owner, approves your tool calls. An approved tool call is NOT the owner's approval. Before every action listed in rule 3 (secrets, anything destructive or irreversible, merges, deploys, publishing, payments, security, permission, billing, DNS or WAF changes, or a page that differs from the steps), you MUST ask the owner with AskUserQuestion, as a question and not as a permission request, and wait for their answer. If you cannot ask, stop and report instead of acting.",
].join("\n");

export function agentTitle(cardTitle: string, fallback = "browser steps"): string {
  const name = cardTitle.trim().replace(/\s+/g, " ") || fallback;
  const title = `${AGENT_TITLE_PREFIX}${name}`;
  return title.length > MAX_AGENT_TITLE ? `${title.slice(0, MAX_AGENT_TITLE - 1)}…` : title;
}

/** Whether a resolved config runs in a classifier-reviewed mode. */
export function usesClassifierMode(config: { provider: string; modeId: string } | undefined): boolean {
  return !!config && isClassifierMode(providerOf(config.provider), config.modeId);
}

/**
 * The agent's initial prompt: fixed safety preamble (plus the Auto mode rule when the agent runs in
 * a classifier-reviewed mode), then the card's steps verbatim.
 */
export function buildAgentPrompt(cardTitle: string, steps: string, config?: { provider: string; modeId: string }): string {
  const task = cardTitle.trim() ? `Task: ${cardTitle.trim()}\n\n` : "";
  const rules = usesClassifierMode(config) ? `${AGENT_SAFETY_PREAMBLE}\n${CLASSIFIER_MODE_RULE}` : AGENT_SAFETY_PREAMBLE;
  return (
    `${rules}\n\n` +
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
 * Turns the stored settings into an SDK agent config. Blank values fall back to the defaults. A blank
 * mode, or one that is neither ask-first nor classifier-reviewed (bypass, accept-edits, ...), falls
 * back to the provider's default mode (Claude: Auto mode; Oh My Pi: Ask). Throws for a provider with
 * no known ask-first mode: the card never starts an agent that skips permission prompts.
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
  const fallback = defaultModeFor(providerId) ?? allowed[0]!;
  let modeId = pick(settings.agentMode, fallback);
  if (!runModeAllowed(providerId, modeId)) modeId = fallback;
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
