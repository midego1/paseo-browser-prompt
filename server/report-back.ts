import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  buildReportMessage,
  finalAssistantText,
  isBrowserRun,
  reportTarget,
  type ReportOutcome,
} from "../shared/report-back.ts";

/** Timeline items read from the end of the browser agent's chat to find its report. */
export const REPORT_TAIL_ITEMS = 60;
/** How long a busy source agent gets to finish its turn before the report steers into it. */
export const SOURCE_BUSY_WAIT_MS = 30 * 60 * 1000;
/** Bounds on remembered agent ids. */
const MAX_REMEMBERED = 1000;

type AgentSnapshotLike = {
  labels?: Record<string, string> | null;
  status?: string | null;
  archivedAt?: string | null;
};

/** The slice of the Paseo SDK this module uses, so tests can pass a fake. */
export interface ReportBackPaseo {
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: AgentSnapshotLike } | null>;
      timeline: {
        refetch(options: { direction: "tail"; limit: number }): Promise<{
          entries: readonly { item: { type: string; text?: unknown } }[];
        }>;
      };
      waitForFinish(timeoutMs?: number): Promise<{ status: string }>;
      send(text: string, options?: { activeTurnBehavior?: "interrupt" | "steer" }): Promise<void>;
    };
  };
}

export type TurnEndedEvent = Pick<PluginLifecycleEvents["agent.turn_ended"], "agent" | "outcome">;

export interface ReportBackOptions {
  /** Current "Report back to chat" setting; read on every event. */
  enabled(): Promise<boolean>;
  log?(message: string): void;
  busyWaitMs?: number;
}

export type ReportResult =
  | "sent"
  | "canceled"
  | "duplicate"
  | "not-a-run"
  | "disabled"
  | "no-source"
  | "source-missing"
  | "source-is-run"
  | "failed";

/** Insertion-ordered set that drops its oldest ids beyond `max`. */
function boundedSet(max: number) {
  const items = new Set<string>();
  return {
    has: (id: string) => items.has(id),
    add(id: string) {
      items.delete(id);
      items.add(id);
      while (items.size > max) items.delete(items.values().next().value!);
    },
  };
}

/**
 * Sends a browser agent's final report to the agent whose card started it, once per run.
 * Only agents labelled `browser-prompt: run` are considered, and a report never goes to an agent
 * that is itself a browser run, so reports cannot loop. Logs carry agent ids only, never content.
 */
export function createReportBack(options: ReportBackOptions) {
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const busyWaitMs = options.busyWaitMs ?? SOURCE_BUSY_WAIT_MS;
  const reported = boundedSet(MAX_REMEMBERED);
  const inFlight = new Set<string>();
  /** Agents seen without the run label. Labels are fixed at creation, so this never goes stale. */
  const notRuns = boundedSet(MAX_REMEMBERED);

  async function onTurnEnded(event: TurnEndedEvent, paseo: ReportBackPaseo): Promise<ReportResult> {
    const agentId = event.agent.id;
    // A stopped run is not a report; a later turn of the same agent may still report.
    if (event.outcome.kind === "canceled") return "canceled";
    if (notRuns.has(agentId)) return "not-a-run";
    if (reported.has(agentId) || inFlight.has(agentId)) return "duplicate";
    inFlight.add(agentId);
    try {
      const run = paseo.agents.ref(agentId);
      // Labels first: other agents' turns cost one snapshot read, then are remembered as not runs.
      const labels = (await run.refresh())?.agent.labels ?? null;
      if (!isBrowserRun(labels)) {
        notRuns.add(agentId);
        return "not-a-run";
      }
      if (!(await options.enabled())) return "disabled";
      const sourceId = reportTarget(agentId, labels);
      if (!sourceId) {
        log(`run ${agentId} has no source agent label; not reporting`);
        reported.add(agentId);
        return "no-source";
      }

      const source = paseo.agents.ref(sourceId);
      let snapshot: AgentSnapshotLike | null = null;
      try {
        snapshot = (await source.refresh())?.agent ?? null;
      } catch {
        snapshot = null;
      }
      if (!snapshot || snapshot.archivedAt) {
        log(`source agent ${sourceId} of run ${agentId} is gone; not reporting`);
        reported.add(agentId);
        return "source-missing";
      }
      if (isBrowserRun(snapshot.labels)) {
        log(`source agent ${sourceId} of run ${agentId} is itself a browser run; not reporting`);
        reported.add(agentId);
        return "source-is-run";
      }

      const outcome: ReportOutcome =
        event.outcome.kind === "failed"
          ? { kind: "failed", message: event.outcome.error.message }
          : { kind: "completed" };
      const page = await run.timeline.refetch({ direction: "tail", limit: REPORT_TAIL_ITEMS });
      const message = buildReportMessage({
        title: event.agent.title,
        browserAgentId: agentId,
        outcome,
        report: finalAssistantText(page.entries.map((entry) => entry.item)),
      });
      // Claim the run before waiting so a later turn of the same agent cannot report twice.
      reported.add(agentId);

      // Never interrupt the source agent: wait for its turn to end, then steer only as a last resort.
      let steer = false;
      if (snapshot.status === "running") {
        const waited = await source.waitForFinish(busyWaitMs).catch(() => ({ status: "timeout" }));
        steer = waited.status !== "idle" && waited.status !== "error";
      }
      await source.send(message, steer ? { activeTurnBehavior: "steer" } : undefined);
      log(`reported run ${agentId} to agent ${sourceId}`);
      return "sent";
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      log(`report for run ${agentId} failed (${reason.replace(/\s+/g, " ").slice(0, 200)})`);
      return "failed";
    } finally {
      inFlight.delete(agentId);
    }
  }

  return { onTurnEnded };
}
