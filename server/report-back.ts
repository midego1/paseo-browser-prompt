import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  buildReportMessage,
  buildStatusNotice,
  finalAssistantText,
  isBrowserRun,
  reportTarget,
  sourceAllowsFullReport,
  type ReportMode,
  type ReportOutcome,
} from "../shared/report-back.ts";
import { buildQuestionMessage, buildQuestionRedirect, parseQuestion, type RedirectReason } from "../shared/talk.ts";

/** Timeline items read from the end of the browser agent's chat to find its report. */
export const REPORT_TAIL_ITEMS = 60;
/** How long a busy source agent gets to become idle before the report is dropped. */
export const SOURCE_BUSY_WAIT_MS = 2 * 60 * 60 * 1000;
/** Longest single `waitForFinish` call; the loop re-checks the source after each. */
const WAIT_SLICE_MS = 5 * 60 * 1000;
/** Pause between checks while the source waits for a permission or question. */
export const PERMISSION_POLL_MS = 15 * 1000;
/** Least time between two waits on a source that is still not settled, so the loop cannot spin. */
export const MIN_RECHECK_MS = 1000;
/** Agents seen without the run label are skipped for this long, then their labels are read again. */
export const NOT_A_RUN_TTL_MS = 60 * 1000;
/** How long to wait for the card to record a new run in host settings. */
export const RECORD_WAIT_MS = 10 * 1000;
const RECORD_POLL_MS = 500;
/** Run ids remembered (and persisted) as already reported. */
export const MAX_REPORTED = 200;

type AgentSnapshotLike = {
  provider?: string | null;
  currentModeId?: string | null;
  workspaceId?: string | null;
  labels?: Record<string, string> | null;
  status?: string | null;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
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

export type TurnEndedEvent = Pick<PluginLifecycleEvents["agent.turn_ended"], "agent" | "outcome"> & {
  turnId?: string | null;
  timeline?: PluginLifecycleEvents["agent.turn_ended"]["timeline"];
};

/** A card's record of a run it started, from the host `runs` setting. */
export interface RecordedRun {
  /** The run was started in the most recent workspace, not the card agent's. */
  fallback: boolean;
}

export interface ReportedStore {
  load(): Promise<string[]>;
  save(ids: string[]): Promise<void>;
}

/** "Talk to the chat" as read from settings; `maxQuestions` 0 means off. */
export interface TalkSettings {
  maxQuestions: number;
}

export interface ReportBackOptions {
  /** Current "Report back to chat" mode; read on every event. Must fail closed to `auto`. */
  mode(): Promise<ReportMode>;
  /** Current "Talk to the chat" settings; read on every question. Must fail closed to off. */
  talk?(): Promise<TalkSettings>;
  /** The card's record of this run, or null when the host settings do not list it. */
  recordedRun(query: { sourceId: string; cardId: string; runId: string }): Promise<RecordedRun | null>;
  store?: ReportedStore;
  log?(message: string): void;
  busyWaitMs?: number;
  permissionPollMs?: number;
  minRecheckMs?: number;
  notARunTtlMs?: number;
  recordWaitMs?: number;
  recordPollMs?: number;
}

export type ReportResult =
  | "question-sent"
  | "question-redirected"
  | "sent"
  | "sent-status"
  | "canceled"
  | "aborted"
  | "duplicate"
  | "not-a-run"
  | "disabled"
  | "no-source"
  | "unrecorded"
  | "workspace-mismatch"
  | "source-missing"
  | "source-is-run"
  | "busy-timeout"
  | "failed";

const ABORTED = Symbol("aborted");

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Resolves with the promise's value, or ABORTED as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void | typeof ABORTED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return abortable(new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), signal).finally(() =>
    clearTimeout(timer),
  );
}

/** Idle and not waiting on the owner: a send now starts a fresh turn and clears nothing. */
function isSettled(agent: AgentSnapshotLike): boolean {
  const status = agent.status ?? "";
  const pending = agent.pendingPermissions?.length ?? 0;
  return (status === "idle" || status === "error" || status === "closed") && !agent.activeTurn && pending === 0;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Sends a browser agent's final report to the agent whose card started it, once per run.
 *
 * Only agents labelled `browser-prompt: run` whose run the card recorded in host settings are
 * considered, and a report never goes to an agent that is itself a browser run, so reports cannot
 * loop. A busy source is not interrupted on purpose: sends to one source are serialized, and each
 * waits until the source is idle with no pending permission. Whether the full report or only a
 * status notice is sent is decided from the source's mode right before sending. Logs carry agent
 * ids only, never content.
 */
export function createReportBack(options: ReportBackOptions) {
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const busyWaitMs = options.busyWaitMs ?? SOURCE_BUSY_WAIT_MS;
  const permissionPollMs = options.permissionPollMs ?? PERMISSION_POLL_MS;
  const minRecheckMs = options.minRecheckMs ?? MIN_RECHECK_MS;
  const notARunTtlMs = options.notARunTtlMs ?? NOT_A_RUN_TTL_MS;
  const recordWaitMs = options.recordWaitMs ?? RECORD_WAIT_MS;
  const recordPollMs = options.recordPollMs ?? RECORD_POLL_MS;
  const lifetime = new AbortController();

  const reported: string[] = [];
  /** Runs whose delivery failed once; a second failure keeps them claimed. */
  const retried = new Set<string>();
  const inFlight = new Set<string>();
  /** Questions each run sent to the chat (in memory; a plugin reload resets the count). */
  const questionCounts = new Map<string, number>();
  /** Turns whose question was already handled, so a repeated event is not forwarded twice. */
  const handledQuestionTurns = new Set<string>();
  /** Agents seen without the run label, until when they are skipped. Labels can change, hence the TTL. */
  const notRuns = new Map<string, number>();
  /** Per source agent: the tail of its delivery queue. */
  const queues = new Map<string, Promise<unknown>>();
  const active = new Set<Promise<ReportResult>>();
  let writes: Promise<void> = Promise.resolve();
  const loaded = (options.store?.load() ?? Promise.resolve([])).then(
    (ids) => void reported.push(...ids.slice(-MAX_REPORTED)),
    () => log("could not read reported runs; starting empty"),
  );

  function persist() {
    const store = options.store;
    if (!store) return;
    const snapshot = reported.slice();
    writes = writes.then(() => store.save(snapshot)).catch((error) => log(`could not save reported runs (${describe(error)})`));
  }
  function claim(runId: string) {
    if (!reported.includes(runId)) reported.push(runId);
    if (reported.length > MAX_REPORTED) reported.splice(0, reported.length - MAX_REPORTED);
    persist();
  }
  /** Lets a run report again after a delivery that sent nothing, once. */
  function release(runId: string) {
    if (retried.has(runId)) return;
    retried.add(runId);
    const index = reported.indexOf(runId);
    if (index >= 0) reported.splice(index, 1);
    persist();
  }

  async function waitForRecord(query: { sourceId: string; cardId: string; runId: string }, signal: AbortSignal) {
    const deadline = Date.now() + recordWaitMs;
    for (;;) {
      const record = await options.recordedRun(query);
      if (record || Date.now() >= deadline) return record;
      if ((await sleep(recordPollMs, signal)) === ABORTED) throw new AbortedError();
    }
  }

  /**
   * Waits until the source is settled or `deadline` passes; re-reads it right before returning.
   * A wait that returns early while the source is still busy is followed by a pause (longer while a
   * permission or question is pending), so the loop never spins.
   */
  async function waitUntilSettled(source: ReturnType<ReportBackPaseo["agents"]["ref"]>, deadline: number, signal: AbortSignal) {
    let pause = 0;
    for (;;) {
      if (signal.aborted) throw new AbortedError();
      const snapshot = (await source.refresh())?.agent ?? null;
      if (!snapshot || snapshot.archivedAt) return "missing" as const;
      if (isSettled(snapshot)) return snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout" as const;
      if (pause > 0) {
        if ((await sleep(Math.min(pause, remaining), signal)) === ABORTED) throw new AbortedError();
        pause = 0;
        continue;
      }
      const started = Date.now();
      const waited = await abortable(source.waitForFinish(Math.min(remaining, WAIT_SLICE_MS)), signal);
      if (waited === ABORTED) throw new AbortedError();
      // A pending permission or question keeps the turn open: wait for the owner, never steer into it.
      const elapsed = Date.now() - started;
      pause = waited.status === "permission" ? permissionPollMs : Math.max(0, minRecheckMs - elapsed);
    }
  }

  /** Runs `task` after every earlier delivery to the same source. */
  function enqueue<T>(sourceId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(sourceId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    queues.set(sourceId, tail);
    void tail.then(() => {
      if (queues.get(sourceId) === tail) queues.delete(sourceId);
    });
    return next;
  }

  async function readFinalText(event: TurnEndedEvent, run: ReturnType<ReportBackPaseo["agents"]["ref"]>): Promise<string> {
    const fromEvent = event.timeline ?? [];
    const items = fromEvent.some((item) => item.type === "assistant_message")
      ? fromEvent
      : (await run.timeline.refetch({ direction: "tail", limit: REPORT_TAIL_ITEMS })).entries.map((entry) => entry.item);
    return finalAssistantText(items);
  }

  /** Tells the run its question did not reach the chat, so it asks the owner instead. */
  async function redirect(run: ReturnType<ReportBackPaseo["agents"]["ref"]>, runId: string, reason: RedirectReason, max: number) {
    await run.send(buildQuestionRedirect(reason, max), { activeTurnBehavior: "steer" });
    log(`question of run ${runId} not forwarded (${reason}); run told to ask the owner`);
    return "question-redirected" as const;
  }

  /**
   * A run ended its turn with a question for the chat. It is never claimed as the run's report.
   * Forwarded, framed by the plugin, only while "Talk to the chat" is on and under the run's cap,
   * and only for runs a card recorded; otherwise the run is told to ask the owner.
   */
  async function handleQuestion(
    event: TurnEndedEvent,
    paseo: ReportBackPaseo,
    labels: Record<string, string> | null,
    runSnapshot: AgentSnapshotLike | null,
    question: string,
    signal: AbortSignal,
  ): Promise<ReportResult> {
    const runId = event.agent.id;
    const run = paseo.agents.ref(runId);
    const turnKey = `${runId}:${event.turnId ?? ""}`;
    if (event.turnId && handledQuestionTurns.has(turnKey)) return "duplicate";
    const target = reportTarget(runId, labels);
    if (!target) return "no-source";
    const { sourceId, cardId } = target;
    // An agent that only copies the labels gets nothing forwarded, and no reply either.
    const record = await waitForRecord({ sourceId, cardId, runId }, signal);
    if (!record) {
      log(`run ${runId} is not recorded by a card of agent ${sourceId}; question not forwarded`);
      return "unrecorded";
    }
    if (event.turnId) {
      handledQuestionTurns.add(turnKey);
      if (handledQuestionTurns.size > 2000) handledQuestionTurns.delete(handledQuestionTurns.values().next().value!);
    }
    const talk = options.talk ? await options.talk().catch(() => ({ maxQuestions: 0 })) : { maxQuestions: 0 };
    const max = Math.max(0, Math.floor(talk.maxQuestions || 0));
    if (max === 0) return redirect(run, runId, "talk-off", max);
    const asked = questionCounts.get(runId) ?? 0;
    if (asked >= max) return redirect(run, runId, "limit", max);

    const source = paseo.agents.ref(sourceId);
    const sourceSnapshot = await source.refresh().then((r) => r?.agent ?? null, () => null);
    const runWorkspace = event.agent.workspaceId ?? runSnapshot?.workspaceId ?? null;
    if (
      !sourceSnapshot ||
      sourceSnapshot.archivedAt ||
      isBrowserRun(sourceSnapshot.labels) ||
      (!record.fallback && (!runWorkspace || runWorkspace !== (sourceSnapshot.workspaceId ?? null)))
    ) {
      return redirect(run, runId, "chat-unavailable", max);
    }

    questionCounts.set(runId, asked + 1);
    if (questionCounts.size > 1000) questionCounts.delete(questionCounts.keys().next().value!);
    const message = buildQuestionMessage({ title: event.agent.title, runId, question, index: asked + 1, max });
    const deadline = Date.now() + busyWaitMs;
    const delivered = await enqueue(sourceId, async () => {
      const settled = await waitUntilSettled(source, deadline, signal);
      if (typeof settled === "string") return settled;
      if (signal.aborted) throw new AbortedError();
      await source.send(message, { activeTurnBehavior: "steer" });
      return "sent" as const;
    });
    if (delivered === "missing") return redirect(run, runId, "chat-unavailable", max);
    if (delivered === "timeout") return redirect(run, runId, "chat-busy", max);
    log(`forwarded question ${asked + 1} of run ${runId} to agent ${sourceId}`);
    return "question-sent";
  }

  /**
   * Handles one ended turn. Can wait for hours on a busy source, so callers must not await it inside
   * a hook handler: Paseo cancels hook requests after 30 seconds. `dispose()` aborts every wait.
   */
  function onTurnEnded(event: TurnEndedEvent, paseo: ReportBackPaseo): Promise<ReportResult> {
    const task = handle(event, paseo);
    active.add(task);
    void task.finally(() => active.delete(task));
    return task;
  }

  async function handle(event: TurnEndedEvent, paseo: ReportBackPaseo): Promise<ReportResult> {
    const runId = event.agent.id;
    const signal = lifetime.signal;
    // A stopped run is not a report; a later turn of the same agent may still report.
    if (event.outcome.kind === "canceled") return "canceled";
    if (signal.aborted) return "aborted";
    if ((notRuns.get(runId) ?? 0) > Date.now()) return "not-a-run";
    await loaded;
    if (inFlight.has(runId)) return "duplicate";
    inFlight.add(runId);
    let claimed = false;
    try {
      const run = paseo.agents.ref(runId);
      // Labels can change after creation, so a non-run is only skipped for a short while.
      const runSnapshot = (await run.refresh())?.agent ?? null;
      const labels = runSnapshot?.labels ?? null;
      if (!isBrowserRun(labels)) {
        const now = Date.now();
        if (notRuns.size >= 1000) for (const [id, until] of notRuns) if (until <= now) notRuns.delete(id);
        if (notRuns.size < 1000) notRuns.set(runId, now + notARunTtlMs);
        return "not-a-run";
      }
      notRuns.delete(runId);

      // The final message decides: a question for the chat, or the run's final report. Read it now,
      // since the run's next turn would make a later read return the wrong message.
      const finalText = event.outcome.kind === "completed" || event.outcome.kind === "failed" ? await readFinalText(event, run) : "";
      const question = event.outcome.kind === "completed" ? parseQuestion(finalText) : null;
      if (question !== null) return await handleQuestion(event, paseo, labels, runSnapshot, question, signal);

      if (reported.includes(runId)) return "duplicate";
      const mode = await options.mode();
      if (mode === "off") return "disabled";
      const target = reportTarget(runId, labels);
      if (!target) {
        log(`run ${runId} lacks source or card labels; not reporting`);
        return "no-source";
      }
      const { sourceId, cardId } = target;

      // The card records every run it starts; an agent that only copies the labels is not reported.
      const record = await waitForRecord({ sourceId, cardId, runId }, signal);
      if (!record) {
        log(`run ${runId} is not recorded by a card of agent ${sourceId}; not reporting`);
        return "unrecorded";
      }

      const source = paseo.agents.ref(sourceId);
      let sourceSnapshot: AgentSnapshotLike | null = null;
      try {
        sourceSnapshot = (await source.refresh())?.agent ?? null;
      } catch {
        sourceSnapshot = null;
      }
      if (!sourceSnapshot || sourceSnapshot.archivedAt) {
        log(`source agent ${sourceId} of run ${runId} is gone; not reporting`);
        claim(runId);
        claimed = true;
        return "source-missing";
      }
      if (isBrowserRun(sourceSnapshot.labels)) {
        log(`source agent ${sourceId} of run ${runId} is itself a browser run; not reporting`);
        claim(runId);
        claimed = true;
        return "source-is-run";
      }
      const runWorkspace = event.agent.workspaceId ?? runSnapshot?.workspaceId ?? null;
      if (!record.fallback && (!runWorkspace || runWorkspace !== (sourceSnapshot.workspaceId ?? null))) {
        log(`run ${runId} and source agent ${sourceId} are in different workspaces; not reporting`);
        claim(runId);
        claimed = true;
        return "workspace-mismatch";
      }

      const outcome: ReportOutcome =
        event.outcome.kind === "failed"
          ? { kind: "failed", message: event.outcome.error.message }
          : { kind: "completed" };
      let report: string | null = null;
      if (mode === "full" || sourceAllowsFullReport(mode, sourceSnapshot.provider, sourceSnapshot.currentModeId)) {
        report = finalText;
      }

      // Claim before waiting so a later turn of the same run cannot report twice. The deadline runs
      // from here, so waiting behind other reports for the same source counts against it.
      claim(runId);
      claimed = true;
      const deadline = Date.now() + busyWaitMs;
      const delivered = await enqueue(sourceId, async () => {
        const settled = await waitUntilSettled(source, deadline, signal);
        if (typeof settled === "string") return settled;
        if (signal.aborted) throw new AbortedError();
        // The source's mode may have changed while waiting; decide on the snapshot just read.
        const full = report !== null && sourceAllowsFullReport(mode, settled.provider, settled.currentModeId);
        const message = full
          ? buildReportMessage({ title: event.agent.title, browserAgentId: runId, outcome, report: report! })
          : buildStatusNotice({ title: event.agent.title, browserAgentId: runId, outcome });
        // Every send clears (denies) pending permissions, which is why the source must be settled.
        // Steer: on an idle agent this starts a normal turn. If the owner starts a turn in the
        // moment since the last read, the report is steered into it (most providers, Claude
        // included) or replaces it, and a permission that turn just raised would be denied.
        await source.send(message, { activeTurnBehavior: "steer" });
        return full ? ("sent" as const) : ("sent-status" as const);
      });
      if (delivered === "missing") {
        log(`source agent ${sourceId} of run ${runId} went away; not reporting`);
        return "source-missing";
      }
      if (delivered === "timeout") {
        log(`source agent ${sourceId} stayed busy; report of run ${runId} not sent`);
        release(runId);
        return "busy-timeout";
      }
      log(`reported run ${runId} to agent ${sourceId}${delivered === "sent" ? "" : " (status only)"}`);
      return delivered;
    } catch (error) {
      if (error instanceof AbortedError || signal.aborted) {
        if (claimed) release(runId);
        return "aborted";
      }
      log(`report for run ${runId} failed (${describe(error)})`);
      if (claimed) release(runId);
      return "failed";
    } finally {
      inFlight.delete(runId);
    }
  }

  return {
    onTurnEnded,
    /** Aborts every pending wait, then lets running handlers and queued saves finish. */
    async dispose() {
      lifetime.abort();
      await Promise.allSettled([...active]);
      await writes;
    },
  };
}
