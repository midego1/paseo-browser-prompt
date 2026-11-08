import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { hasRunSuccessMarker, mayLoadRun, QUESTION_MARKER, stripRunSuccessMarker } from "../shared/agent-prompt.ts";
import {
  buildClosedRunNotice,
  buildReportMessage,
  buildStatusNotice,
  finalAssistantText,
  isBrowserRun,
  reportTarget,
  sourceAllowsFullReport,
  type ReportMode,
  type ReportOutcome,
} from "../shared/report-back.ts";
import { buildQuestionMessage, buildQuestionRedirect, MAX_REDIRECTS, parseQuestion, type RedirectReason } from "../shared/talk.ts";

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
export { MAX_REDIRECTS };
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
      archive(): Promise<unknown>;
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
  /** "Archive the agent after a successful run"; read when a run succeeds. Must fail closed to off. */
  archiveOnSuccess?(): Promise<boolean>;
  store?: ReportedStore;
  /** Runs this plugin archived after they succeeded, so their cards keep showing done. */
  archivedStore?: ReportedStore;
  log?(message: string): void;
  busyWaitMs?: number;
  permissionPollMs?: number;
  minRecheckMs?: number;
  notARunTtlMs?: number;
  recordWaitMs?: number;
  recordPollMs?: number;
  archiveGraceMs?: number;
}

const ARCHIVE_SETTLE_MS = 500;
const ARCHIVE_SETTLE_TRIES = 10;
/** Wait before archiving a run that succeeded. */
export const ARCHIVE_GRACE_MS = 2000;
const MAX_TRACKED_RUNS = 1000;

/** A run is archived only after these: its report went out, or the owner turned reports off. */
const ARCHIVE_AFTER: ReadonlySet<ReportResult> = new Set<ReportResult>(["sent", "sent-status", "disabled"]);

export type ReportResult =
  | "question-sent"
  | "question-redirected"
  | "sent"
  | "sent-status"
  | "sent-closed"
  | "not-forwarded-closed"
  | "question-stale"
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
  const archiveGraceMs = options.archiveGraceMs ?? ARCHIVE_GRACE_MS;
  const lifetime = new AbortController();

  const reported: string[] = [];
  /** Runs whose delivery failed once; a second failure keeps them claimed. */
  const retried = new Set<string>();
  /**
   * Runs whose turn is being read or claimed, with the handler that holds them. Released before a long
   * wait for a busy chat, so a later turn of the same run is not taken for a duplicate.
   */
  const inFlight = new Map<string, symbol>();
  /** Questions each run sent to the chat (in memory; a plugin reload resets the count). */
  const questionCounts = new Map<string, number>();
  /** Turns whose question was already handled, so a repeated event is not forwarded twice. */
  const handledQuestionTurns = new Set<string>();
  /** Redirect notices each run got (in memory, like the question counts). */
  const redirectCounts = new Map<string, number>();
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

  /** Per run: its latest turn, so an archive waiting on an older turn gives up. Oldest dropped first. */
  const latestTurns = new Map<string, { seq: number; turnId: string | null }>();
  /**
   * Per run: the turns read so far (turn id, else last message id), oldest first. A question is out of
   * date once a later turn was read; a repeated event of its own turn does not count.
   */
  const seenTurns = new Map<string, string[]>();
  /** Runs that already had a final or stopped turn: a follow-up turn is the owner's, so it stays open. */
  const concluded = new Set<string>();
  const archived: string[] = [];
  let archiveWrites: Promise<void> = Promise.resolve();
  const archivedLoaded = (options.archivedStore?.load() ?? Promise.resolve([])).then(
    (ids) => void archived.push(...ids.slice(-MAX_REPORTED)),
    () => log("could not read archived runs; starting empty"),
  );

  function persistArchived() {
    const store = options.archivedStore;
    if (!store) return;
    const snapshot = archived.slice();
    archiveWrites = archiveWrites.then(() => store.save(snapshot)).catch((error) => log(`could not save archived runs (${describe(error)})`));
  }

  /**
   * Archives a run that said it fully succeeded, after its report. Reads the run again: only a run a
   * card recorded, with no new turn and not archived by now. A failure leaves the run open.
   */
  async function archiveIfSucceeded(event: TurnEndedEvent, paseo: ReportBackPaseo, result: ReportResult, seq: number) {
    const runId = event.agent.id;
    if (!ARCHIVE_AFTER.has(result) || lifetime.signal.aborted) return;
    const superseded = () => lifetime.signal.aborted || latestTurns.get(runId)?.seq !== seq;
    try {
      if (!(await options.archiveOnSuccess?.())) return;
      const run = paseo.agents.ref(runId);
      // The hook can fire just before the run's status settles, so give it a moment.
      let snapshot = (await run.refresh())?.agent ?? null;
      for (let wait = 0; wait < ARCHIVE_SETTLE_TRIES && snapshot?.status === "running" && !snapshot.pendingPermissions?.length; wait++) {
        if ((await sleep(ARCHIVE_SETTLE_MS, lifetime.signal)) === ABORTED) return;
        snapshot = (await run.refresh())?.agent ?? null;
      }
      if (superseded()) return;
      const target = reportTarget(runId, snapshot?.labels ?? null);
      if (!snapshot || !target || !isBrowserRun(snapshot.labels) || snapshot.archivedAt) return;
      if (snapshot.status !== "idle" || snapshot.activeTurn || snapshot.pendingPermissions?.length) return;
      const record = await waitForRecord({ sourceId: target.sourceId, cardId: target.cardId, runId }, lifetime.signal);
      if (!record) return;
      await archivedLoaded;
      // Lets a card finish its last read first: reading the run once it is archived would load it.
      if ((await sleep(archiveGraceMs, lifetime.signal)) === ABORTED || superseded()) return;
      const latest = (await run.refresh())?.agent ?? null;
      if (superseded() || latest?.status !== "idle" || latest.activeTurn || latest.pendingPermissions?.length || latest.archivedAt) return;
      // Noted first, so a card that sees the closed run right away finds it as done.
      archived.push(runId);
      if (archived.length > MAX_REPORTED) archived.splice(0, archived.length - MAX_REPORTED);
      persistArchived();
      try {
        await run.archive();
        log(`archived run ${runId} after it succeeded`);
      } catch (error) {
        archived.splice(archived.indexOf(runId), 1);
        persistArchived();
        throw error;
      }
    } catch (error) {
      if (!lifetime.signal.aborted) log(`could not archive run ${runId} (${describe(error)})`);
    }
  }

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

  /**
   * The turn's final assistant text, and the id of its last assistant message when known. Null when
   * that takes reading the timeline of a run that is closed by now, which would load it again.
   */
  async function readFinal(
    event: TurnEndedEvent,
    run: ReturnType<ReportBackPaseo["agents"]["ref"]>,
    runSnapshot: AgentSnapshotLike | null,
  ): Promise<{ text: string; messageId: string | null } | null> {
    const fromEvent = event.timeline ?? [];
    const inEvent = fromEvent.some((item) => item.type === "assistant_message");
    if (!inEvent && !mayLoadRun(runSnapshot)) return null;
    const items: readonly { type: string; text?: unknown; messageId?: unknown }[] = inEvent
      ? fromEvent
      : (await run.timeline.refetch({ direction: "tail", limit: REPORT_TAIL_ITEMS })).entries.map((entry) => entry.item);
    let messageId: string | null = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "user_message") break;
      if (item.type === "assistant_message") {
        messageId = typeof item.messageId === "string" && item.messageId ? item.messageId : null;
        break;
      }
    }
    return { text: finalAssistantText(items), messageId };
  }

  /**
   * Tells the run its question did not reach the chat, so it asks the owner instead. Returns null,
   * sending nothing, once the run had MAX_REDIRECTS notices: the caller then treats the turn as the
   * run's report. A run closed by now (the wait for a busy chat can take hours) gets no notice: a send
   * would load it and start a turn. A caller that just read the run passes what it found (`known`).
   */
  async function redirect(
    run: ReturnType<ReportBackPaseo["agents"]["ref"]>,
    runId: string,
    reason: RedirectReason,
    max: number,
    known?: Awaited<ReturnType<typeof runState>>,
  ) {
    const count = redirectCounts.get(runId) ?? 0;
    if (count >= MAX_REDIRECTS) {
      log(`run ${runId} kept asking after ${count} redirects; handling its turn as the report`);
      return null;
    }
    const closed =
      known !== undefined
        ? known === "closed"
        : await run.refresh().then(
            (fresh) => !!fresh && !mayLoadRun(fresh.agent),
            () => {
              log(`could not read the status of run ${runId}; sending its redirect notice anyway`);
              return false;
            },
          );
    if (closed) {
      log(`question of run ${runId} not forwarded; the run is closed or archived, so it is not told`);
      return "not-forwarded-closed" as const;
    }
    redirectCounts.set(runId, count + 1);
    if (redirectCounts.size > 1000) redirectCounts.delete(redirectCounts.keys().next().value!);
    await run.send(buildQuestionRedirect(reason, max), { activeTurnBehavior: "steer" });
    log(`question of run ${runId} not forwarded (${reason}); run told to ask the owner`);
    return "question-redirected" as const;
  }

  /**
   * The run's state while its question waits: "busy" with a turn after the question's (an active turn
   * with another turn id, or a pending permission), "closed" when closed, archived or gone, else
   * "waiting". An active turn with the question's own id, or any while that id is unknown, is the
   * question turn still settling. Null, logged, when the status could not be read.
   */
  async function runState(run: ReturnType<ReportBackPaseo["agents"]["ref"]>, event: TurnEndedEvent) {
    const fresh = await run.refresh().catch(() => undefined);
    if (fresh === undefined) {
      log(`could not read the status of run ${event.agent.id}; its question is handled as still open`);
      return null;
    }
    if (!fresh || !mayLoadRun(fresh.agent)) return "closed" as const;
    const active = fresh.agent.activeTurn as { turnId?: unknown } | null | undefined;
    const newTurn = !!active && !!event.turnId && typeof active.turnId === "string" && active.turnId !== event.turnId;
    return newTurn || (fresh.agent.pendingPermissions?.length ?? 0) > 0 ? ("busy" as const) : ("waiting" as const);
  }

  /**
   * A run ended its turn with a question for the chat. It is never claimed as the run's report.
   * Forwarded, framed by the plugin, only while "Talk to the chat" is on and under the run's cap,
   * and only for runs a card recorded; otherwise the run is told to ask the owner. Returns null when
   * the run is past its redirects: the turn is then handled as the run's report.
   */
  async function handleQuestion(
    event: TurnEndedEvent,
    paseo: ReportBackPaseo,
    labels: Record<string, string> | null,
    runSnapshot: AgentSnapshotLike | null,
    question: string,
    messageId: string | null,
    signal: AbortSignal,
    leave: () => void,
  ): Promise<ReportResult | null> {
    const runId = event.agent.id;
    const run = paseo.agents.ref(runId);
    // Same-turn dedupe: the turn id, else the id of the turn's last assistant message.
    const turnKey = event.turnId ? `${runId}:t:${event.turnId}` : messageId ? `${runId}:m:${messageId}` : null;
    if (turnKey && handledQuestionTurns.has(turnKey)) return "duplicate";
    const target = reportTarget(runId, labels);
    if (!target) return "no-source";
    const { sourceId, cardId } = target;
    // An agent that only copies the labels gets nothing forwarded, and no reply either.
    const record = await waitForRecord({ sourceId, cardId, runId }, signal);
    if (!record) {
      log(`run ${runId} is not recorded by a card of agent ${sourceId}; question not forwarded`);
      return "unrecorded";
    }
    if (turnKey) {
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
    // The turn is handled from here on (its key guards a repeated event), so a later turn of the run
    // may report while this one waits. A turn with neither a turn id nor a message id keeps the run
    // held: nothing else would stop a repeated event from forwarding the question twice.
    if (turnKey) leave();
    const delivered = await enqueue(sourceId, async () => {
      const settled = await waitUntilSettled(source, deadline, signal);
      if (typeof settled === "string") return settled;
      if (signal.aborted) throw new AbortedError();
      // The owner answered the run in the meantime: the question is out of date.
      if (movedPast(runId, turnKey)) return "stale" as const;
      const state = await runState(run, event);
      if (state === "busy" || state === "closed") return "stale" as const;
      await source.send(message, { activeTurnBehavior: "steer" });
      return "sent" as const;
    });
    // Before a redirect, one read of the run covers both the busy check here and redirect()'s closed check.
    const state = delivered === "timeout" || delivered === "missing" ? await runState(run, event) : undefined;
    // Neither the chat nor the run is told about a question the run has moved past. A closed run is
    // left to redirect(), which sends it nothing.
    if (delivered === "stale" || (delivered !== "sent" && (movedPast(runId, turnKey) || state === "busy"))) {
      // Not forwarded, so it does not count against the run's questions.
      if (questionCounts.get(runId) === asked + 1) questionCounts.set(runId, asked);
      log(`question of run ${runId} not forwarded; the run went on in the meantime`);
      return "question-stale";
    }
    if (delivered === "missing") return redirect(run, runId, "chat-unavailable", max, state);
    if (delivered === "timeout") return redirect(run, runId, "chat-busy", max, state);
    log(`forwarded question ${asked + 1} of run ${runId} to agent ${sourceId}`);
    return "question-sent";
  }

  /**
   * Handles one ended turn. Can wait for hours on a busy source, so callers must not await it inside
   * a hook handler: Paseo cancels hook requests after 30 seconds. `dispose()` aborts every wait.
   */
  /** Counts a new turn of a run; a repeated event for the same turn keeps its number. */
  function noteTurn(event: TurnEndedEvent): number {
    const runId = event.agent.id;
    const turnId = event.turnId ?? null;
    const last = latestTurns.get(runId);
    if (last && turnId && last.turnId === turnId) return last.seq;
    const seq = (last?.seq ?? 0) + 1;
    latestTurns.delete(runId);
    latestTurns.set(runId, { seq, turnId });
    if (latestTurns.size > MAX_TRACKED_RUNS) latestTurns.delete(latestTurns.keys().next().value as string);
    return seq;
  }

  function noteSeen(runId: string, turn: string) {
    const list = seenTurns.get(runId) ?? [];
    if (!list.includes(turn)) list.push(turn);
    if (list.length > 20) list.shift();
    seenTurns.delete(runId);
    seenTurns.set(runId, list);
    if (seenTurns.size > MAX_TRACKED_RUNS) seenTurns.delete(seenTurns.keys().next().value as string);
  }

  /** Whether a turn of the run after `turn` was read. Unknown (never seen, or forgotten): no. */
  function movedPast(runId: string, turn: string | null): boolean {
    const list = turn ? seenTurns.get(runId) : undefined;
    const index = list ? list.indexOf(turn!) : -1;
    return index >= 0 && index < list!.length - 1;
  }

  function markConcluded(runId: string) {
    concluded.add(runId);
    if (concluded.size > MAX_TRACKED_RUNS) concluded.delete(concluded.values().next().value as string);
  }

  function onTurnEnded(event: TurnEndedEvent, paseo: ReportBackPaseo): Promise<ReportResult> {
    const seq = noteTurn(event);
    const verdict = { succeeded: false };
    const task = handle(event, paseo, verdict).then(async (result) => {
      if (verdict.succeeded) await archiveIfSucceeded(event, paseo, result, seq);
      return result;
    });
    active.add(task);
    void task.finally(() => active.delete(task));
    return task;
  }

  async function handle(event: TurnEndedEvent, paseo: ReportBackPaseo, verdict: { succeeded: boolean }): Promise<ReportResult> {
    const runId = event.agent.id;
    const signal = lifetime.signal;
    // A stopped run is not a report; a later turn of the same agent may still report.
    if (event.outcome.kind === "canceled") {
      markConcluded(runId);
      return "canceled";
    }
    if (signal.aborted) return "aborted";
    if ((notRuns.get(runId) ?? 0) > Date.now()) return "not-a-run";
    await loaded;
    if (inFlight.has(runId)) return "duplicate";
    const holder = Symbol(runId);
    inFlight.set(runId, holder);
    const leave = () => {
      if (inFlight.get(runId) === holder) inFlight.delete(runId);
    };
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
      const ended = event.outcome.kind === "completed" || event.outcome.kind === "failed";
      const final = ended ? await readFinal(event, run, runSnapshot) : null;
      // Closed or archived by now: the chat still hears the outcome from the event, without a report.
      const closedRun = ended && !final;
      if (closedRun) log(`run ${runId} is closed or archived; its report is not read`);
      const finalText = final?.text ?? "";
      const seenKey = event.turnId ? `${runId}:t:${event.turnId}` : final?.messageId ? `${runId}:m:${final.messageId}` : null;
      if (seenKey) noteSeen(runId, seenKey);
      const question = event.outcome.kind === "completed" ? parseQuestion(stripRunSuccessMarker(finalText)) : null;
      if (question !== null) {
        const handled = await handleQuestion(event, paseo, labels, runSnapshot, question, final?.messageId ?? null, signal, leave);
        if (handled !== null) return handled;
        // Handled as the report from here: hold the run again, unless a later turn of it took over.
        if (inFlight.has(runId) && inFlight.get(runId) !== holder) return "duplicate";
        inFlight.set(runId, holder);
        // Past its redirects: fall through and handle this turn as the run's report.
      }
      // Only the run's first final turn, with a report left next to the line and no question in it.
      verdict.succeeded =
        !concluded.has(runId) &&
        question === null &&
        event.outcome.kind === "completed" &&
        hasRunSuccessMarker(finalText) &&
        !finalText.includes(QUESTION_MARKER) &&
        stripRunSuccessMarker(finalText).trim() !== "";
      if (ended) markConcluded(runId);

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
      if (!closedRun && (mode === "full" || sourceAllowsFullReport(mode, sourceSnapshot.provider, sourceSnapshot.currentModeId))) {
        report = stripRunSuccessMarker(finalText);
      }

      // Claim before waiting so a later turn of the same run cannot report twice. The deadline runs
      // from here, so waiting behind other reports for the same source counts against it.
      claim(runId);
      claimed = true;
      // The claim now guards against a second report; the wait below can take hours.
      leave();
      const deadline = Date.now() + busyWaitMs;
      const delivered = await enqueue(sourceId, async () => {
        const settled = await waitUntilSettled(source, deadline, signal);
        if (typeof settled === "string") return settled;
        if (signal.aborted) throw new AbortedError();
        // The source's mode may have changed while waiting; decide on the snapshot just read.
        const allowed = sourceAllowsFullReport(mode, settled.provider, settled.currentModeId);
        const full = report !== null && allowed;
        const message = closedRun
          ? buildClosedRunNotice({ title: event.agent.title, browserAgentId: runId, outcome, withError: allowed })
          : full
            ? buildReportMessage({ title: event.agent.title, browserAgentId: runId, outcome, report: report! })
            : buildStatusNotice({ title: event.agent.title, browserAgentId: runId, outcome });
        // Every send clears (denies) pending permissions, which is why the source must be settled.
        // Steer: on an idle agent this starts a normal turn. If the owner starts a turn in the
        // moment since the last read, the report is steered into it (most providers, Claude
        // included) or replaces it, and a permission that turn just raised would be denied.
        await source.send(message, { activeTurnBehavior: "steer" });
        return closedRun ? ("sent-closed" as const) : full ? ("sent" as const) : ("sent-status" as const);
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
      log(`reported run ${runId} to agent ${sourceId}${delivered === "sent" ? "" : delivered === "sent-closed" ? " (run closed, status only)" : " (status only)"}`);
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
      leave();
    }
  }

  return {
    onTurnEnded,
    /** Whether the plugin archived this run after it succeeded. */
    async wasArchived(runId: string): Promise<boolean> {
      await archivedLoaded;
      return archived.includes(runId);
    },
    /** Aborts every pending wait, then lets running handlers and queued saves finish. */
    async dispose() {
      lifetime.abort();
      await Promise.allSettled([...active]);
      await writes;
      await archiveWrites;
    },
  };
}
