import type { PluginSettingsState } from "@getpaseo/plugin/server";
import type { preferences } from "../shared/settings";
import { DEFAULT_REPORT_MODE, MOST_RECENT_FALLBACK, parseReportMode, runKey, type ReportMode } from "../shared/report-back.ts";
import { chatQuestionBudget } from "../shared/agent-prompt.ts";
import { addLifecycleHook, type HookServer } from "./hooks.ts";
import { createReportBack, type ReportBackOptions, type ReportBackPaseo, type TalkSettings } from "./report-back.ts";

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

/** The card's `runs` entry for this run, if any. */
export async function readRecordedRun(settings: SettingsReader, query: { sourceId: string; cardId: string; runId: string }) {
  const state = await settings.read().catch(() => null);
  if (state?.status !== "ready") return null;
  const key = runKey(query.sourceId, query.cardId);
  const entry = state.values.runs.find(([k, id]) => k === key && id === query.runId);
  return entry ? { fallback: entry[2] === MOST_RECENT_FALLBACK } : null;
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
  extra: Partial<Pick<ReportBackOptions, "store" | "log" | "busyWaitMs" | "permissionPollMs" | "recordWaitMs" | "recordPollMs">> = {},
) {
  const reportBack = createReportBack({
    mode: () => readReportMode(settings),
    talk: () => readTalkSettings(settings),
    recordedRun: (query) => readRecordedRun(settings, query),
    ...extra,
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
