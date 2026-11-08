import type { PluginSettingsState } from "@getpaseo/plugin/server";
import type { preferences } from "../shared/settings";
import { DEFAULT_REPORT_MODE, MOST_RECENT_FALLBACK, parseReportMode, runKey, type ReportMode } from "../shared/report-back.ts";
import { chatQuestionBudget } from "../shared/agent-prompt.ts";
import { addLifecycleHook, type HookServer } from "./hooks.ts";
import { createReportBack, type RecordedRun, type ReportBackOptions, type ReportBackPaseo, type TalkSettings } from "./report-back.ts";

type PreferencesState = PluginSettingsState<(typeof preferences)["schema"]>;
export type SettingsReader = { read(): Promise<PreferencesState> };

/** The setting's mode; invalid or unreadable settings fail closed to `auto`, never to `full`. */
export async function readReportMode(settings: SettingsReader): Promise<ReportMode> {
  try {
    const state = await settings.read();
    return state.status === "ready" ? parseReportMode(state.values.reportBack) : DEFAULT_REPORT_MODE;
  } catch {
    return DEFAULT_REPORT_MODE;
  }
}

/**
 * "Talk to the chat" from settings. Invalid or unreadable settings fail closed to off: questions
 * carry page text, so they are only forwarded on a positive, readable setting.
 */
export async function readTalkSettings(settings: SettingsReader): Promise<TalkSettings> {
  try {
    const state = await settings.read();
    if (state.status !== "ready") return { maxQuestions: 0 };
    return { maxQuestions: chatQuestionBudget(state.values) };
  } catch {
    return { maxQuestions: 0 };
  }
}

/** "Archive the agent after a successful run"; invalid or unreadable settings fail closed to off. */
export async function readArchiveOnSuccess(settings: SettingsReader): Promise<boolean> {
  try {
    const state = await settings.read();
    return state.status === "ready" && state.values.archiveAgentOnSuccess === true;
  } catch {
    return false;
  }
}

/** Runs remembered as recorded, per daemon process. */
const MAX_SEEN_RUNS = 1000;

/**
 * Runs this process has seen recorded by a card. A record can drop out of `runs` while its run still
 * goes (a sixth run of the card, past the total cap, or Clear on "Agent links on cards"); the run
 * keeps its mode guard and report back. Bounded: the oldest entries go first.
 */
export function createSeenRuns(max = MAX_SEEN_RUNS) {
  const seen = new Map<string, RecordedRun>();
  const key = (query: { sourceId: string; cardId: string; runId: string }) => `${runKey(query.sourceId, query.cardId)}\u0000${query.runId}`;
  return {
    get: (query: { sourceId: string; cardId: string; runId: string }) => seen.get(key(query)) ?? null,
    add(query: { sourceId: string; cardId: string; runId: string }, record: RecordedRun) {
      const k = key(query);
      seen.delete(k);
      seen.set(k, record);
      if (seen.size > max) seen.delete(seen.keys().next().value!);
    },
    size: () => seen.size,
  };
}

export type SeenRuns = ReturnType<typeof createSeenRuns>;

/**
 * The card's `runs` entry for this run, if any; with `seen`, also a run whose record this process
 * read before (see `createSeenRuns`).
 */
export async function readRecordedRun(
  settings: SettingsReader,
  query: { sourceId: string; cardId: string; runId: string },
  seen?: SeenRuns,
): Promise<RecordedRun | null> {
  const state = await settings.read().catch(() => null);
  if (state?.status === "ready") {
    const key = runKey(query.sourceId, query.cardId);
    const entry = state.values.runs.find(([k, id]) => k === key && id === query.runId);
    if (entry) {
      const record = { fallback: entry[2] === MOST_RECENT_FALLBACK };
      seen?.add(query, record);
      return record;
    }
  }
  return seen?.get(query) ?? null;
}

/**
 * Wires "Report back to chat" to the turn-ended hook (`agent.turn.after`, `agent.turn_ended` up to Paseo
 * 0.14). The handler returns at once and the report is delivered in the background, because Paseo
 * cancels hook requests after 30 seconds and a report may wait for a busy chat. The returned cleanup
 * aborts every pending wait.
 */
export function registerReportBack(
  server: HookServer,
  settings: SettingsReader,
  extra: Partial<Pick<ReportBackOptions, "store" | "archivedStore" | "log" | "busyWaitMs" | "permissionPollMs" | "recordWaitMs" | "recordPollMs">> & {
    /** Shared with the mode guard, so both keep a run whose record dropped out. */
    seen?: SeenRuns;
  } = {},
) {
  const { seen = createSeenRuns(), ...rest } = extra;
  const reportBack = createReportBack({
    mode: () => readReportMode(settings),
    talk: () => readTalkSettings(settings),
    archiveOnSuccess: () => readArchiveOnSuccess(settings),
    recordedRun: (query) => readRecordedRun(settings, query, seen),
    ...rest,
  });
  const off = addLifecycleHook(server, "agent.turn_ended", async (event, { paseo }) => {
    void reportBack.onTurnEnded(event, paseo as ReportBackPaseo);
  });
  return {
    reportBack,
    async dispose() {
      off();
      await reportBack.dispose();
    },
  };
}
