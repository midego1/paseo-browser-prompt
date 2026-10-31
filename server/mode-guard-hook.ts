import type { PluginServerContext } from "@getpaseo/plugin/server";
import { enforceRunMode, type ModeGuardAgent } from "../shared/mode-guard.ts";
import { reportTarget } from "../shared/report-back.ts";
import { readRecordedRun, type SettingsReader } from "./report-back-hook.ts";

type GuardHandle = Omit<ModeGuardAgent, "refresh"> & {
  refresh(): Promise<{ agent: { labels?: Record<string, string> | null; currentModeId?: string | null } } | null>;
};
type GuardPaseo = { agents: { ref(id: string): GuardHandle } };

export interface ModeGuardOptions {
  log?: (message: string) => void;
  /** How long to wait for the card to record a new run (it saves the record right after create). */
  recordWaitMs?: number;
  recordPollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Watches browser runs while they work: when a turn starts or a permission is requested, a run in a
 * refused mode (anything but ask-first or classifier modes, see `runModeAllowed`) is set back or
 * stopped. Only agents a card recorded in the host `runs` setting count as runs, the same check
 * report back uses; labels alone are not enough, so the guard never archives an agent that merely
 * carries the plugin's labels. Handlers return at once; logs carry agent ids and mode ids only.
 */
export function registerModeGuard(server: Pick<PluginServerContext, "on">, settings: SettingsReader, options: ModeGuardOptions = {}) {
  const log = options.log ?? ((m: string) => console.log(`[browser-prompt] ${m}`));
  const recordWaitMs = options.recordWaitMs ?? 10_000;
  const recordPollMs = options.recordPollMs ?? 500;
  const stopped = new Set<string>();
  const checking = new Set<string>();
  let disposed = false;

  async function isRecorded(query: { sourceId: string; cardId: string; runId: string }): Promise<boolean> {
    const deadline = Date.now() + recordWaitMs;
    for (;;) {
      if (await readRecordedRun(settings, query)) return true;
      if (disposed || Date.now() >= deadline) return false;
      await sleep(recordPollMs);
    }
  }

  async function check(agent: { id: string; provider: string }, paseo: GuardPaseo) {
    if (disposed || stopped.has(agent.id) || checking.has(agent.id)) return;
    checking.add(agent.id);
    try {
      const handle = paseo.agents.ref(agent.id);
      const labels = (await handle.refresh())?.agent.labels ?? null;
      const target = reportTarget(agent.id, labels);
      if (!target) return;
      if (!(await isRecorded({ ...target, runId: agent.id }))) {
        log(`agent ${agent.id} has browser run labels but no card record; mode not checked`);
        return;
      }
      if (disposed) return;
      const result = await enforceRunMode(handle, agent.provider, { attempts: 1 });
      if (result.ok) {
        if (result.corrected) log(`run ${agent.id} was set back to mode ${result.actualMode}`);
        return;
      }
      stopped.add(agent.id);
      log(`run ${agent.id} was in mode ${result.actualMode}; ${result.stopped ? "stopped (archived)" : "could not be stopped"}`);
    } catch (error) {
      log(`mode check for run ${agent.id} failed (${error instanceof Error ? error.name : "error"})`);
    } finally {
      checking.delete(agent.id);
    }
  }

  const offs = [
    server.on("agent.turn_started", async (event, { paseo }) => void check(event.agent, paseo as unknown as GuardPaseo)),
    server.on("agent.permission_requested", async (event, { paseo }) => void check(event.agent, paseo as unknown as GuardPaseo)),
  ];
  return {
    check,
    dispose() {
      disposed = true;
      for (const off of offs) off();
    },
  };
}
