import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { RunState } from "../shared/agent-prompt";
import { finalAssistantText } from "../shared/report-back";
import { latestStep, type StepProgress } from "../shared/steps";
import { parseQuestion } from "../shared/talk";
import { stepProgressView } from "../shared/step-view";

/** Assistant text kept from the live stream to find the latest marker. */
const STREAM_BUFFER = 4000;
const LIVE_STATES: readonly RunState[] = ["starting", "running", "needs-input", "unknown"];

export interface RunProgress {
  progress: StepProgress | null;
  /** The run's latest turn ended with a question for the chat: it waits for the answer. */
  asking: boolean;
}

/**
 * The run's latest `[browser-prompt step N/M]` marker, and whether its latest turn ended with a
 * question for the chat. No polling: one tail read of the run's timeline per run (skipped once it is
 * done), then the live timeline stream only while the run is active. `useAgent` gives status but
 * no text, so this is the cheapest source of the markers.
 */
export function useStepProgress(agentId: string | null, total: number, state: RunState, enabled: boolean): RunProgress {
  const paseo = usePaseo();
  const [progress, setProgress] = useState<StepProgress | null>(null);
  const [asking, setAsking] = useState(false);
  const fetchedFor = useRef<string | null>(null);
  const live = !!agentId && LIVE_STATES.includes(state);
  // Read once per run, also when done: the latest turn may be a question waiting for the chat.
  const wantsHistory = !!agentId && state !== "stopped";

  useEffect(() => {
    setProgress(null);
    setAsking(false);
    fetchedFor.current = null;
  }, [agentId]);

  useEffect(() => {
    if (state === "running" || state === "starting") setAsking(false);
  }, [state]);

  useEffect(() => {
    if (!wantsHistory || !agentId || fetchedFor.current === agentId) return;
    fetchedFor.current = agentId;
    let cancelled = false;
    void paseo.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 40 })
      .then(
        (page) => {
          if (cancelled) return;
          const items = page.entries.map(({ item }) => item);
          setAsking(parseQuestion(finalAssistantText(items)) !== null);
          if (!enabled) return;
          const text = items
            .map((item) => (item.type === "assistant_message" ? item.text : ""))
            .filter(Boolean)
            .join("\n");
          const found = latestStep(text, total);
          if (found) setProgress(found);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [agentId, wantsHistory, enabled, total, paseo]);

  useEffect(() => {
    if (!live || !agentId) return;
    let buffer = "";
    let turnText = "";
    const append = (text: string, chunk: string) => {
      // A marker that starts a new message must start a line in the buffer too.
      const separator = text && !text.endsWith("\n") && chunk.trimStart().startsWith("[browser-prompt ") ? "\n" : "";
      return (text + separator + chunk).slice(-STREAM_BUFFER);
    };
    const unsubscribe = paseo.agents.ref(agentId).timeline.subscribe((message) => {
      const event = message.event;
      if (event.type === "turn_started") {
        turnText = "";
        setAsking(false);
        return;
      }
      if (event.type === "turn_completed") {
        setAsking(parseQuestion(turnText) !== null);
        return;
      }
      if (event.type !== "timeline" || event.item.type !== "assistant_message") return;
      const chunk = event.item.text;
      turnText = append(turnText, chunk);
      if (!enabled) return;
      buffer = append(buffer, chunk);
      const found = latestStep(buffer, total);
      if (found) setProgress(found);
    });
    return () => unsubscribe();
  }, [agentId, live, enabled, total, paseo]);

  return { progress: enabled && agentId ? progress : null, asking: !!agentId && asking };
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
