import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Text, View } from "react-native";
import type { RunState } from "../shared/agent-prompt";
import { observeSkew, runStatsView, runTiming, type UsageLike } from "../shared/run-stats";

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

/**
 * The client clock's estimated lead over the daemon's: the stream's estimate, improved by every
 * updatedAt that changes while the row is shown (a changed value is fresh; the first one may be old).
 */
function useSkew(updatedAt: string | null, streamSkewMs: number | null): number | null {
  const seen = useRef<string | null>(updatedAt);
  const [skew, setSkew] = useState<number | null>(null);
  useEffect(() => {
    if (!updatedAt || updatedAt === seen.current) return;
    seen.current = updatedAt;
    setSkew((current) => observeSkew(current, Date.now(), updatedAt));
  }, [updatedAt]);
  if (skew === null) return streamSkewMs;
  return streamSkewMs === null ? skew : Math.min(skew, streamSkewMs);
}

/** The run's icon: spins while the run works, unless the owner asked for reduced motion. */
function Spinner({ size, color }: { size: number; color: string }) {
  const reducedMotion = useReducedMotion();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion) {
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
  }, [reducedMotion, rotation]);
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name="LoaderCircle" size={size} color={color} />
    </Animated.View>
  );
}

/**
 * "⟳ Running · 2m 14s", then "Took 3m 02s · last turn: 36 in · 701k cached · 4.6k out": the run's
 * time from the agent's own timestamps and, once a turn has completed, that turn's tokens. Only
 * this row re-renders each second, and only while the run is going.
 */
export function RunStatsRow({
  state,
  createdAt,
  updatedAt,
  lastEntryAt,
  usage,
  streamSkewMs,
  theme,
  compact,
}: {
  state: RunState | "asking";
  createdAt: string | null;
  updatedAt: string | null;
  lastEntryAt: string | null;
  usage: UsageLike | null;
  streamSkewMs: number | null;
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const timing = runTiming({ state, createdAt, lastEntryAt });
  const now = useNow(!!timing && !timing.ended);
  const skewMs = useSkew(updatedAt, streamSkewMs);
  const view = runStatsView({ state, timing, nowMs: now, skewMs, usage });
  if (!view) return null;
  const size = compact ? 12 : 13;
  const text = { color: theme.colors.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {view.spinning ? (
        <Spinner size={size} color={theme.colors.accent} />
      ) : (
        <Icon name="Timer" size={size} color={theme.colors.foregroundMuted} />
      )}
      <Text accessibilityRole="timer" accessibilityLabel={view.timeLabel} style={text} numberOfLines={1}>
        {view.timeText}
      </Text>
      {view.tokenText ? (
        <Text accessibilityLabel={view.tokenLabel ?? undefined} style={[text, { flexShrink: 1 }]} numberOfLines={1}>
          · {view.tokenText}
        </Text>
      ) : null}
    </View>
  );
}
