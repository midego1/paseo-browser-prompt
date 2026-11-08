import type { PluginOpenScreenInput, usePaseo } from "@getpaseo/plugin/client";
import {
  agentTitle,
  buildAgentPrompt,
  chatQuestionBudget,
  parseBrowserAgent,
  providerOf,
  type AgentSettingsInput,
  type BrowserAgent,
  resolveLaunchWith,
  type ResolvedLaunch,
} from "../shared/agent-prompt";
import { enforceRunMode, type ModeCheck, type ModeGuardAgent } from "../shared/mode-guard";
import { runLabels } from "../shared/report-back";
import { countSteps } from "../shared/steps";

type PaseoApi = ReturnType<typeof usePaseo>;

/** Screen that hands off to Paseo's own agent view (timeline renderers get no navigation). */
export const RUN_SCREEN_ID = "agent-run";

let openScreenRef: ((input: PluginOpenScreenInput) => void) | null = null;

/** Called from the client entry so card renderers can open the plugin's screen. */
export function setOpenScreen(open: ((input: PluginOpenScreenInput) => void) | null): void {
  openScreenRef = open;
}

/** The plugin's settings page, which Paseo lists under this id. */
export const SETTINGS_SCREEN_ID = "preferences";

let openSettingsRef: ((id: string) => void) | null = null;

/** Called from the client entry so cards can open the settings page. */
export function setOpenSettings(open: ((id: string) => void) | null): void {
  openSettingsRef = open;
}

export function openPluginSettings(): boolean {
  if (!openSettingsRef) return false;
  openSettingsRef(SETTINGS_SCREEN_ID);
  return true;
}

/** Each launch opens the agent automatically once; Back to the screen does not loop. */
const consumedOpenTokens = new Set<string>();

export function consumeOpenToken(token: string | undefined): boolean {
  if (!token || consumedOpenTokens.has(token)) return false;
  consumedOpenTokens.add(token);
  return true;
}

export function openRunScreen(agentId: string, title: string, autoOpen: boolean): boolean {
  if (!openScreenRef) return false;
  const params: Record<string, string> = { agentId, title };
  if (autoOpen) params.open = `${agentId}:${Date.now()}`;
  openScreenRef({ screenId: RUN_SCREEN_ID, params });
  return true;
}

export type WorkspaceSource = "card-agent" | "card-agent-refresh" | "most-recent";

export interface StartedAgent {
  agentId: string;
  workspaceId: string;
  workspaceSource: WorkspaceSource;
  /** Whether the agent actually runs in an allowed mode; when not, it was stopped if possible. */
  modeCheck: ModeCheck;
}

/**
 * Workspace for the new agent: the workspace of the agent whose message holds the card, read from
 * the app's agent cache, else by refreshing that agent, else the most recently active workspace.
 */
async function chooseWorkspace(
  paseo: PaseoApi,
  sourceAgentId: string,
  cachedWorkspaceId: string | null,
): Promise<{ workspaceId: string; source: WorkspaceSource }> {
  if (cachedWorkspaceId) return { workspaceId: cachedWorkspaceId, source: "card-agent" };
  try {
    const handle = paseo.agents.ref(sourceAgentId);
    await handle.refresh();
    if (handle.workspaceId) return { workspaceId: handle.workspaceId, source: "card-agent-refresh" };
  } catch {
    // fall through to the most recent workspace
  }
  const { entries } = await paseo.workspaces.list({
    sort: [{ key: "activity_at", direction: "desc" }],
    page: { limit: 1 },
  });
  const recent = entries[0];
  if (!recent) throw new Error("No Paseo workspace found to start the agent in.");
  return { workspaceId: recent.id, source: "most-recent" };
}

export type { ResolvedLaunch };

/** Resolves a launch, including the automatically chosen Chrome provider, without starting it. */
export function resolveLaunch(paseo: PaseoApi, settings: AgentSettingsInput, browser: BrowserAgent): Promise<ResolvedLaunch> {
  return resolveLaunchWith(() => paseo.providers.listAvailable(), settings, browser);
}

/**
 * Creates the browser agent in the card agent's workspace with the safety-preamble prompt. Its labels
 * link it to the card's agent and card, so the server can report back when it finishes.
 */
export async function startBrowserAgent(
  paseo: PaseoApi,
  input: {
    sourceAgentId: string;
    cardId: string;
    cachedWorkspaceId: string | null;
    cardTitle: string;
    displayTitle: string;
    steps: string;
    settings: AgentSettingsInput;
    /** The launch the owner confirmed: started with exactly this config. */
    launch?: Extract<ResolvedLaunch, { config: unknown }>;
    /**
     * Called as soon as the agent exists, before its mode is checked, so the card records it (and
     * the server's guard and report back see it) even when the check is slow or cannot read it.
     */
    onCreated?: (agentId: string, workspaceSource: WorkspaceSource) => Promise<void>;
  },
): Promise<StartedAgent> {
  const { workspaceId, source } = await chooseWorkspace(paseo, input.sourceAgentId, input.cachedWorkspaceId);
  const launch = input.launch ?? (await resolveLaunch(paseo, input.settings, parseBrowserAgent(input.settings.browserAgent)));
  if ("error" in launch) throw new Error(launch.error);
  const config = launch.config;
  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    config,
    title: agentTitle(input.cardTitle, input.displayTitle),
    prompt: buildAgentPrompt(input.cardTitle, input.steps, config, {
      sourceAgentId: input.sourceAgentId,
      maxQuestions: chatQuestionBudget(input.settings),
    },
    input.settings.showStepProgress === false ? undefined : { totalSteps: countSteps(input.steps) },
    input.settings.showLiveScreenshot !== false,
    input.settings.closeTabsOnSuccess !== false,
    input.settings.archiveAgentOnSuccess === true,
    parseBrowserAgent(input.settings.browserAgent),
    ),
    labels: runLabels(input.sourceAgentId, input.cardId),
  });
  // From here on the agent runs: nothing below may throw, or the card would call it "not started".
  const recording = input.onCreated?.(agent.id, source).catch(() => undefined);
  // Paseo or the provider can end up in another mode than requested; never leave a run going in a
  // refused mode (drift between the provider's allowed modes is fine). An unreadable mode is
  // unverified; the server's guard checks it again at every turn and permission request.
  const modeCheck = await enforceRunMode(agent as unknown as ModeGuardAgent, providerOf(config.provider), {
    restoreMode: config.modeId,
  }).catch((): ModeCheck => ({ ok: true, actualMode: null, corrected: false }));
  // Logged with the agent id only, so an unverified start is visible.
  if (modeCheck.ok && modeCheck.actualMode === null) {
    console.warn(`[browser-prompt] could not read the permission mode of run ${agent.id}; the server's mode guard checks it on its next turn`);
  }
  await recording;
  return { agentId: agent.id, workspaceId, workspaceSource: source, modeCheck };
}
