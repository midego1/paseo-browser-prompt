import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Text, View } from "react-native";
import type { RunState } from "../shared/agent-prompt";
import { runStatsView, runTiming, type UsageLike } from "../shared/run-stats";

/** Whether the owner asked for less motion (prefers-reduced-motion on the web). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => {
        if (alive) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      subscription?.remove?.();
    };
  }, []);
  return reduced;
}

/** Now, ticking once a second only while `live`; the interval is cleared when it ends or unmounts. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function Spinner({ size, color, spinning }: { size: number; color: string; spinning: boolean }) {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) {
      rotation.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, rotation]);
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name="LoaderCircle" size={size} color={color} />
    </Animated.View>
  );
}

/**
 * "⟳ Running · 2m 14s · 701k in · 4.6k out": the run's time from the agent's own timestamps and,
 * once a turn has completed, its tokens. Only this row re-renders each second, and only while the
 * run is going.
 */
export function RunStatsRow({
  state,
  createdAt,
  updatedAt,
  lastEntryAt,
  usage,
  theme,
  compact,
}: {
  state: RunState | "asking";
  createdAt: string | null;
  updatedAt: string | null;
  lastEntryAt: string | null;
  usage: UsageLike | null;
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const timing = runTiming({ state, createdAt, updatedAt, lastEntryAt });
  const now = useNow(timing?.endMs === null);
  const reducedMotion = useReducedMotion();
  const view = runStatsView({ state, timing, nowMs: now, usage });
  if (!view) return null;
  const size = compact ? 12 : 13;
  return (
    <View
      accessible
      accessibilityLabel={view.accessibilityLabel}
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      {view.spinning ? (
        <Spinner size={size} color={theme.colors.accent} spinning={!reducedMotion} />
      ) : (
        <Icon name="Timer" size={size} color={theme.colors.foregroundMuted} />
      )}
      <Text style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums"] }} numberOfLines={1}>
        {view.text}
      </Text>
    </View>
  );
}
