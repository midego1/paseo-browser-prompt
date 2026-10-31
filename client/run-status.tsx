import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { runStateFrom, type RunState } from "../shared/agent-prompt";

/**
 * Observes a started agent through the app's agent cache (no extra subscription).
 * Only for timeline renderers, panels and button content; not for screens (see run-screen.tsx).
 */
export function useRunState(agentId: string | null): RunState {
  const snapshot = useAgent(agentId ?? "", (agent) => ({
    status: agent.status,
    attentionReason: agent.attentionReason,
  }));
  const [seenRunning, setSeenRunning] = useState(false);
  useEffect(() => {
    setSeenRunning(false);
  }, [agentId]);
  useEffect(() => {
    if (snapshot?.status === "running") setSeenRunning(true);
  }, [snapshot?.status]);
  if (!agentId) return "unknown";
  return runStateFrom(snapshot, seenRunning);
}

export const RUN_LABELS: Record<RunState, string> = {
  starting: "Starting Paseo agent",
  running: "Running in Paseo agent",
  "needs-input": "Paseo agent needs your approval",
  done: "Paseo agent finished",
  failed: "Paseo agent failed",
  stopped: "Paseo agent stopped",
  unknown: "Started in Paseo agent",
};

export function runVisual(state: RunState, theme: PluginHostProps["theme"]): { icon: string; color: string } {
  switch (state) {
    case "done":
      return { icon: "CircleCheck", color: theme.colors.statusSuccess };
    case "failed":
      return { icon: "CircleX", color: theme.colors.statusDanger };
    case "needs-input":
      return { icon: "CircleAlert", color: theme.colors.statusWarning };
    case "stopped":
      return { icon: "CircleStop", color: theme.colors.foregroundMuted };
    default:
      return { icon: "Bot", color: theme.colors.foregroundMuted };
  }
}
