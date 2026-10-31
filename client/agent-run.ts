import type { PluginOpenScreenInput, usePaseo } from "@getpaseo/plugin/client";
import { agentTitle, buildAgentPrompt, providerOf, resolveAgentConfig, type AgentSettingsInput } from "../shared/agent-prompt";
import { enforceRunMode, type ModeCheck, type ModeGuardAgent } from "../shared/mode-guard";
import { runLabels } from "../shared/report-back";

type PaseoApi = ReturnType<typeof usePaseo>;

/** Screen that hands off to Paseo's own agent view (timeline renderers get no navigation). */
export const RUN_SCREEN_ID = "agent-run";

let openScreenRef: ((input: PluginOpenScreenInput) => void) | null = null;

/** Called from the client entry so card renderers can open the plugin's screen. */
export function setOpenScreen(open: ((input: PluginOpenScreenInput) => void) | null): void {
  openScreenRef = open;
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
  },
): Promise<StartedAgent> {
  const { workspaceId, source } = await chooseWorkspace(paseo, input.sourceAgentId, input.cachedWorkspaceId);
  const config = resolveAgentConfig(input.settings);
  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    config,
    title: agentTitle(input.cardTitle, input.displayTitle),
    prompt: buildAgentPrompt(input.cardTitle, input.steps, config),
    labels: runLabels(input.sourceAgentId, input.cardId, config.modeId),
  });
  // Paseo or the provider can end up in another mode than requested; never leave such a run going.
  const modeCheck = await enforceRunMode(agent as unknown as ModeGuardAgent, providerOf(config.provider), config.modeId);
  return { agentId: agent.id, workspaceId, workspaceSource: source, modeCheck };
}
