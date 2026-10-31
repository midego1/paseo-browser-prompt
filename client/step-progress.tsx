import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { liveSubscription, type RunState } from "../shared/agent-prompt";
import { createRunTracker, type RunTracker, type RunView } from "../shared/run-tracker";
import { stepProgressView } from "../shared/step-view";
import type { StepProgress } from "../shared/steps";

const EMPTY: RunView = {
  progress: null,
  asking: false,
  screenshot: null,
  screenshots: [],
  screenshotStep: null,
  screenshotsBlocked: false,
};

const screenshotsKey = (view: RunView) => view.screenshots.map((shot) => `${shot.step}:${shot.source}`).join("|");

function sameView(a: RunView, b: RunView): boolean {
  return (
    a.asking === b.asking &&
    a.screenshot === b.screenshot &&
    a.screenshotStep === b.screenshotStep &&
    screenshotsKey(a) === screenshotsKey(b) &&
    a.screenshotsBlocked === b.screenshotsBlocked &&
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
 *   from a report; skipped for stopped runs, redone if a dependency change cancels it),
 * - the live timeline stream only while the agent's own status is running or initializing,
 * - one more tail read when a live run settles, since its idle status can arrive before the stream's
 *   turn_completed.
 */
export function useStepProgress(
  agentId: string | null,
  total: number,
  state: RunState,
  status: string | null,
  showSteps: boolean,
  showScreenshots = false,
): RunView {
  const paseo = usePaseo();
  const tracker = useRef<RunTracker | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const wasLive = useRef(false);
  const [view, setView] = useState<RunView>(EMPTY);
  const live = !!agentId && liveSubscription(status);
  const stopped = state === "stopped";

  const publish = () => {
    const next = tracker.current?.view() ?? EMPTY;
    setView((current) => (sameView(current, next) ? current : next));
  };

  const readTail = (id: string) => {
    let cancelled = false;
    let settled = false;
    void paseo.agents
      .ref(id)
      .timeline.refetch({ direction: "tail", limit: 40 })
      .then(
        (page) => {
          settled = true;
          if (cancelled || !tracker.current) return;
          tracker.current.history(page.entries.map(({ item }) => item));
          publish();
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
  }, [agentId, total, showSteps, showScreenshots]);

  // One read when the card shows the run. A read cancelled by a dependency change is redone.
  useEffect(() => {
    if (!agentId || stopped || fetchedFor.current === agentId) return;
    fetchedFor.current = agentId;
    const read = readTail(agentId);
    return () => {
      read.cancel();
      if (!read.settled) fetchedFor.current = null;
    };
  }, [agentId, stopped, total, showSteps, showScreenshots, paseo]);

  // Live -> settled: one final read decides between waiting for the chat and done.
  useEffect(() => {
    const settledNow = wasLive.current && !live;
    wasLive.current = live;
    if (live) {
      tracker.current?.resumed();
      publish();
      return;
    }
    if (!settledNow || !agentId) return;
    const read = readTail(agentId);
    return () => read.cancel();
  }, [live, agentId, paseo]);

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
    });
    void subscription.ready?.catch(() => undefined);
    return () => subscription();
  }, [agentId, live, total, showSteps, showScreenshots, paseo]);

  return agentId ? view : EMPTY;
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
