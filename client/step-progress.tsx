import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { liveSubscription, readRunTail, type RunState } from "../shared/agent-prompt";
import { createRunTracker, type RunTracker, type RunView } from "../shared/run-tracker";
import { observeSkew, type UsageLike } from "../shared/run-stats";
import { stepProgressView } from "../shared/step-view";
import type { StepProgress } from "../shared/steps";

const EMPTY: RunView = {
  progress: null,
  asking: false,
  screenshot: null,
  screenshots: [],
  screenshotStep: null,
  screenshotsBlocked: false,
  permissionPending: false,
  permissionEvents: 0,
};

/**
 * Read along with the timeline: when the run's latest entry happened and its last turn's token usage
 * (both only from a read while the run is not live, cleared when it goes live again), and the client
 * clock's estimated lead over the daemon's from live stream timestamps.
 */
export interface RunMeta {
  lastEntryAt: string | null;
  usage: UsageLike | null;
  skewMs: number | null;
}

const NO_META: RunMeta = { lastEntryAt: null, usage: null, skewMs: null };

/** A smaller skew estimate re-renders the card only when it improves by at least this much. */
const SKEW_STEP_MS = 200;

const usageKey = (usage: UsageLike | null) =>
  usage ? `${usage.inputTokens}:${usage.cachedInputTokens}:${usage.outputTokens}` : "";

const screenshotsKey = (view: RunView) => view.screenshots.map((shot) => `${shot.step}:${shot.source}`).join("|");

function sameView(a: RunView, b: RunView): boolean {
  return (
    a.asking === b.asking &&
    a.screenshot === b.screenshot &&
    a.screenshotStep === b.screenshotStep &&
    screenshotsKey(a) === screenshotsKey(b) &&
    a.screenshotsBlocked === b.screenshotsBlocked &&
    a.permissionPending === b.permissionPending &&
    a.permissionEvents === b.permissionEvents &&
    a.progress?.step === b.progress?.step &&
    a.progress?.text === b.progress?.text &&
    (a.progress === null) === (b.progress === null)
  );
}

/**
 * The run's latest `[browser-prompt step N/M]` marker, and whether its latest turn is a question
 * still waiting for the chat. `useAgent` (the status source) has no message text, so markers come
 * from the run's timeline, without polling:
 * - one tail read when the card shows the run (also for finished runs, to tell a waiting question
 *   from a report; redone if a dependency change cancels it),
 * - the live timeline stream only while the agent's own status is running or initializing,
 * - one more tail read when a live run settles, since its idle status can arrive before the stream's
 *   turn_completed.
 * No read for a stopped run: reading a closed agent's timeline makes the daemon load it again, idle,
 * and the card would show it as done. Every read goes through `readRunTail`, which checks the status
 * first, also for a run the app's cache does not know yet.
 */
export function useStepProgress(
  agentId: string | null,
  total: number,
  state: RunState,
  status: string | null,
  showSteps: boolean,
  showScreenshots = false,
): RunView & { meta: RunMeta } {
  const paseo = usePaseo();
  const tracker = useRef<RunTracker | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const wasLive = useRef(false);
  const [view, setView] = useState<RunView>(EMPTY);
  const [meta, setMeta] = useState<RunMeta>(NO_META);
  const live = !!agentId && liveSubscription(status);
  const liveNow = useRef(live);
  liveNow.current = live;
  const statusNow = useRef(status);
  statusNow.current = status;
  const stopped = state === "stopped";

  const publish = () => {
    const next = tracker.current?.view() ?? EMPTY;
    setView((current) => (sameView(current, next) ? current : next));
  };

  const readTail = (id: string) => {
    let cancelled = false;
    let settled = false;
    void readRunTail(paseo.agents.ref(id), 40, () => statusNow.current, () => cancelled)
      .then(
        (page) => {
          settled = true;
          if (!page || cancelled || !tracker.current) return;
          tracker.current.history(page.entries.map(({ item }) => item));
          publish();
          // A live run's latest entry is not its end, and its usage is the previous turn's.
          if (liveNow.current) return;
          const lastEntryAt = page.entries.at(-1)?.timestamp ?? null;
          const usage = page.agent?.lastUsage ?? null;
          setMeta((current) =>
            current.lastEntryAt === lastEntryAt && usageKey(current.usage) === usageKey(usage)
              ? current
              : { ...current, lastEntryAt, usage },
          );
        },
        () => {
          settled = true;
        },
      );
    return {
      cancel() {
        cancelled = true;
      },
      get settled() {
        return settled;
      },
    };
  };

  useEffect(() => {
    tracker.current = agentId ? createRunTracker(total, showSteps, showScreenshots) : null;
    fetchedFor.current = null;
    wasLive.current = false;
    setView(EMPTY);
    setMeta(NO_META);
  }, [agentId, total, showSteps, showScreenshots]);

  // One read when the card shows the run. A read cancelled by a dependency change is redone, and so
  // is one skipped for a stopped run that something else (the owner opening it) loaded again.
  useEffect(() => {
    if (!agentId || stopped) {
      fetchedFor.current = null;
      return;
    }
    if (fetchedFor.current === agentId) return;
    fetchedFor.current = agentId;
    const read = readTail(agentId);
    return () => {
      read.cancel();
      if (!read.settled) fetchedFor.current = null;
    };
  }, [agentId, stopped, total, showSteps, showScreenshots, paseo]);

  // Live -> settled: one final read decides between waiting for the chat and done. A run that went
  // from live to closed is neither, and reading it would load it again.
  useEffect(() => {
    const settledNow = wasLive.current && !live;
    wasLive.current = live;
    if (live) {
      tracker.current?.resumed();
      publish();
      setMeta((current) => (current.lastEntryAt || current.usage ? { ...current, lastEntryAt: null, usage: null } : current));
      return;
    }
    if (!settledNow || !agentId || stopped) return;
    const read = readTail(agentId);
    return () => read.cancel();
  }, [live, agentId, stopped, paseo]);

  // The live stream, only while the agent is running or initializing.
  useEffect(() => {
    if (!live || !agentId) return;
    const subscription = paseo.agents.ref(agentId).timeline.subscribe((message) => {
      const event = message.event as { type: string; item?: { type: string; text?: unknown; messageId?: unknown } };
      if (event.type === "replacement" || event.type === "subscription_restored") {
        readTail(agentId);
        return;
      }
      tracker.current?.event(event);
      publish();
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      if (typeof timestamp === "string") {
        setMeta((current) => {
          const next = observeSkew(current.skewMs, Date.now(), timestamp);
          return next !== null && (current.skewMs === null || next <= current.skewMs - SKEW_STEP_MS)
            ? { ...current, skewMs: next }
            : current;
        });
      }
    });
    void subscription.ready?.catch(() => undefined);
    return () => subscription();
  }, [agentId, live, total, showSteps, showScreenshots, paseo]);

  return agentId ? { ...view, meta } : { ...EMPTY, meta: NO_META };
}

/** "Step N of M · text" and a thin progress bar, colored by the run's state. */
export function StepProgressRow({
  progress,
  total,
  state,
  theme,
  compact,
}: {
  progress: StepProgress | null;
  total: number;
  state: RunState | "asking";
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const view = stepProgressView(progress, total, state);
  if (!view) return null;
  const color =
    view.tone === "success"
      ? theme.colors.statusSuccess
      : view.tone === "danger"
        ? theme.colors.statusDanger
        : view.tone === "warning"
          ? theme.colors.statusWarning
          : theme.colors.accent;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={view.label}
      accessibilityValue={{ min: 0, max: total, now: view.step }}
      style={{ gap: 4 }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 }} numberOfLines={1}>
        {view.label}
      </Text>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View style={{ height: 4, width: `${Math.round(view.fraction * 100)}%`, backgroundColor: color }} />
      </View>
    </View>
  );
}
