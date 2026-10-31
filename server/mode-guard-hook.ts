import type { PluginServerContext } from "@getpaseo/plugin/server";
import { enforceRunMode, type ModeGuardAgent } from "../shared/mode-guard.ts";
import { isBrowserRun, MODE_LABEL } from "../shared/report-back.ts";

type GuardHandle = Omit<ModeGuardAgent, "refresh"> & {
  refresh(): Promise<{ agent: { labels?: Record<string, string> | null; currentModeId?: string | null } } | null>;
};
type GuardPaseo = { agents: { ref(id: string): GuardHandle } };

/**
 * Watches browser runs while they work: when a turn starts or a permission is requested, a run whose
 * mode left the allowed set (see `runModeAllowed`) is set back or stopped. Runs started before 0.3.0
 * carry no mode label and may only be in an ask-first mode. Handlers return at once; logs carry
 * agent ids and mode ids only.
 */
export function registerModeGuard(server: Pick<PluginServerContext, "on">, log = (m: string) => console.log(`[browser-prompt] ${m}`)) {
  const stopped = new Set<string>();
  const checking = new Set<string>();

  async function check(agent: { id: string; provider: string }, paseo: GuardPaseo) {
    if (stopped.has(agent.id) || checking.has(agent.id)) return;
    checking.add(agent.id);
    try {
      const handle = paseo.agents.ref(agent.id);
      const labels = (await handle.refresh())?.agent.labels ?? null;
      if (!isBrowserRun(labels)) return;
      const requested = typeof labels![MODE_LABEL] === "string" ? labels![MODE_LABEL]! : "";
      const result = await enforceRunMode(handle, agent.provider, requested, { attempts: 1 });
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
      for (const off of offs) off();
    },
  };
}
