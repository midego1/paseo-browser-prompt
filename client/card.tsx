import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { agentTitle, DEFAULT_AGENT_SETTINGS, resolveAgentConfig, usesClassifierMode } from "../shared/agent-prompt";
import { MOST_RECENT_FALLBACK } from "../shared/report-back";
import { MAX_DONE, MAX_RUNS, preferences } from "../shared/settings";
import { stashPrompt } from "../shared/trampoline";
import {
  copyPrompt,
  DEFAULT_MODES,
  effectiveMode,
  recordSeenPrompt,
  rememberModes,
  startInChatGpt,
  type ActionResult,
} from "./launch";
import { openRunScreen, startBrowserAgent } from "./agent-run";
import { MessageMarkdown } from "./markdown";
import { RUN_LABELS, runVisual, useRunState } from "./run-status";
import { useUpdateOnUse } from "./update";

const DESKTOP_HINT = "Your Paseo desktop app must be open: the agent drives the browser tabs there.";

export const cardSchema = z.object({
  cardId: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  text: z.string(),
});

export const markdownSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

export function MarkdownSegment({ item, theme }: PluginTimelineItemProps<z.output<typeof markdownSchema>>) {
  return <MessageMarkdown text={item.data.text} theme={theme} />;
}

export function BrowserPromptCard({
  item,
  agentId,
  timestamp,
  theme,
  layout,
}: PluginTimelineItemProps<z.output<typeof cardSchema>>) {
  const { cardId, title, text, index } = item.data;
  const doneKey = `${agentId}:${cardId}`;
  const settings = useSettings(preferences);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const toast = useToast();
  const [localDone, setLocalDone] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [localRun, setLocalRun] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const paseo = usePaseo();
  const sourceWorkspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const updates = useUpdateOnUse();

  const persistedDone = settings.status === "ready" ? settings.values.done.includes(doneKey) : false;
  const done = localDone ?? persistedDone;
  const stash = useRpc(stashPrompt);
  const startMode = settings.status === "ready" ? settings.values.startMode : DEFAULT_MODES.startMode;
  const mobileStartMode =
    settings.status === "ready" ? settings.values.mobileStartMode : DEFAULT_MODES.mobileStartMode;

  const storedRun =
    settings.status === "ready" ? (settings.values.runs.find(([key]) => key === doneKey)?.[1] ?? null) : null;
  const runAgentId = localRun ?? storedRun;
  const runState = useRunState(runAgentId);
  const confirmLaunch =
    settings.status === "ready" ? settings.values.confirmAgentLaunch : DEFAULT_AGENT_SETTINGS.confirmAgentLaunch;
  /** The next run would use Claude Auto mode (classifier-reviewed); the confirmation says so. */
  const launchesInAutoMode = useMemo(() => {
    try {
      return usesClassifierMode(resolveAgentConfig(settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS));
    } catch {
      return false;
    }
  }, [settings]);

  useEffect(() => {
    updates.onFirstRender();
  }, [updates.onFirstRender]);

  useEffect(() => {
    recordSeenPrompt({ agentId, title, text, at: timestamp.getTime() * 100 + index });
  }, [agentId, title, text, timestamp, index]);

  useEffect(() => {
    if (settings.status === "ready") rememberModes({ startMode, mobileStartMode });
  }, [settings.status, startMode, mobileStartMode]);

  const styles = useMemo(() => {
    const pad = layout.compact ? 10 : 14;
    return {
      card: {
        borderWidth: 1,
        borderColor: done ? theme.colors.statusSuccess : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: pad,
        gap: layout.compact ? 8 : 10,
        opacity: done ? 0.75 : 1,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { flex: 1, color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 15 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      promptBox: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: layout.compact ? 8 : 10,
      },
      prompt: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 13, lineHeight: 19 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      primary: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const, fontSize: 13 },
      secondary: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      secondaryText: { color: theme.colors.foreground, fontSize: 13 },
      doneText: { color: done ? theme.colors.statusSuccess : theme.colors.foreground, fontSize: 13 },
      runRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
      runText: { color: theme.colors.foreground, fontSize: 13 },
      link: { color: theme.colors.accent ?? theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      modalText: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      modalActions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, justifyContent: "flex-end" as const },
    };
  }, [theme, layout.compact, done]);

  function report(result: ActionResult) {
    if (result.ok) toast.show(result.message, { variant: "success", durationMs: 3500 });
    else toast.error(result.message);
  }

  async function run(action: () => Promise<ActionResult>) {
    if (busy) return;
    updates.onUse();
    setBusy(true);
    try {
      report(await action());
    } finally {
      setBusy(false);
    }
  }

  async function toggleDone() {
    const next = !done;
    setLocalDone(next);
    if (settings.status !== "ready") return; // stays in memory for this session
    const without = settings.values.done.filter((key) => key !== doneKey);
    const list = next ? [...without, doneKey].slice(-MAX_DONE) : without;
    const saved = await settings.save({ ...settings.values, done: list }, settings.revision);
    if (saved) setLocalDone(null);
  }

  const displayTitle = title || `Browser prompt ${index + 1}`;

  /**
   * Records the run in host settings. The server reports a run back only when it finds this entry,
   * so a save that loses a revision race is retried against the newest settings.
   */
  async function rememberRun(startedAgentId: string, fallback: boolean) {
    setLocalRun(startedAgentId);
    const entry: [string, string, ...string[]] = fallback
      ? [doneKey, startedAgentId, MOST_RECENT_FALLBACK]
      : [doneKey, startedAgentId];
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = latestSettings.current;
      if (current.status === "ready") {
        const without = current.values.runs.filter(([key]) => key !== doneKey);
        const runs = [...without, entry].slice(-MAX_RUNS);
        if (await current.save({ ...current.values, runs }, current.revision)) return;
      }
      await current.reload();
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    toast.error("Could not record the agent on this card; it will not report back to this chat.");
  }

  async function launchAgent() {
    setConfirmOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const values = settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS;
      const started = await startBrowserAgent(paseo, {
        sourceAgentId: agentId,
        cardId,
        cachedWorkspaceId: sourceWorkspaceId,
        cardTitle: title,
        displayTitle,
        steps: text,
        settings: values,
      });
      await rememberRun(started.agentId, started.workspaceSource === "most-recent");
      if (!started.modeCheck.ok) {
        // The run left its permission mode and was stopped (or could not be): keep it on the card.
        setRunError(started.modeCheck.message);
        toast.error(started.modeCheck.message);
        return;
      }
      setRunError(null);
      const where = started.workspaceSource === "most-recent" ? " in your most recent workspace" : "";
      toast.show(
        layout.compact ? `Paseo agent started${where}. ${DESKTOP_HINT}` : `Paseo agent started${where}.`,
        { variant: "success", durationMs: 5000 },
      );
      openRunScreen(started.agentId, agentTitle(title, displayTitle), true);
    } catch (error) {
      const message = `Could not start a Paseo agent: ${error instanceof Error ? error.message : String(error)}`;
      setRunError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function onRunPress() {
    if (busy) return;
    updates.onUse();
    if (confirmLaunch) setConfirmOpen(true);
    else void launchAgent();
  }

  const runVisuals = runVisual(runState, theme);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name={done ? "CircleCheck" : "Globe"} size={16} color={done ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
        <Text style={styles.title} selectable numberOfLines={2}>
          {displayTitle}
        </Text>
        <Text style={styles.label}>{done ? "Done" : "Browser prompt"}</Text>
      </View>
      <View style={styles.promptBox}>
        <Text selectable style={styles.prompt}>
          {text}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Start ${displayTitle} in ChatGPT`}
          disabled={busy}
          onPress={() => void run(() => startInChatGpt(title, text, effectiveMode({ startMode, mobileStartMode }), (prompt) => stash({ prompt })))}
          style={styles.primary}
        >
          <Icon name="Play" size={14} color={theme.colors.accentForeground} />
          <Text style={styles.primaryText}>Start in ChatGPT</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy ${displayTitle}`}
          disabled={busy}
          onPress={() => void run(() => copyPrompt(title, text))}
          style={styles.secondary}
        >
          <Icon name="Copy" size={14} color={theme.colors.foreground} />
          <Text style={styles.secondaryText}>Copy</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={done ? `Mark ${displayTitle} not done` : `Mark ${displayTitle} done`}
          accessibilityState={{ checked: done }}
          onPress={() => void toggleDone()}
          style={styles.secondary}
        >
          <Icon name={done ? "Undo2" : "Check"} size={14} color={done ? theme.colors.statusSuccess : theme.colors.foreground} />
          <Text style={styles.doneText}>{done ? "Undo done" : "Done ✓"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Run ${displayTitle} with a Paseo agent`}
          disabled={busy}
          onPress={onRunPress}
          style={styles.secondary}
        >
          <Icon name="Bot" size={14} color={theme.colors.foreground} />
          <Text style={styles.secondaryText}>{runAgentId ? "Run again with Paseo agent" : "Run with Paseo agent"}</Text>
        </Pressable>
      </View>
      {runAgentId ? (
        <View style={styles.runRow}>
          <Icon name={runVisuals.icon} size={14} color={runVisuals.color} />
          <Text style={[styles.runText, runState === "done" || runState === "failed" ? { color: runVisuals.color } : null]}>
            {RUN_LABELS[runState]}
          </Text>
          <Text style={styles.hint}>·</Text>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open the Paseo agent for ${displayTitle}`}
            onPress={() => {
              if (!openRunScreen(runAgentId, agentTitle(title, displayTitle), true)) toast.error("Cannot open the agent from here.");
            }}
          >
            <Text style={styles.link}>Open</Text>
          </Pressable>
        </View>
      ) : null}
      {runError ? (
        <View style={styles.runRow}>
          <Icon name="CircleX" size={14} color={theme.colors.statusDanger} />
          <Text style={[styles.hint, { color: theme.colors.statusDanger, flexShrink: 1 }]}>{runError}</Text>
        </View>
      ) : null}
      {runAgentId && layout.compact ? <Text style={styles.hint}>{DESKTOP_HINT}</Text> : null}
      <Modal
        title="Run with Paseo agent"
        icon={<Icon name="Bot" size={18} color={theme.colors.foreground} />}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      >
        <Modal.Content>
          <Text style={styles.modalText}>Start a Paseo agent to do these steps in your browser?</Text>
          {launchesInAutoMode ? (
            <Text style={[styles.hint, { color: theme.colors.statusWarning }]}>
              It runs in Claude Auto mode: a model classifier, not you, approves its tool calls. It uses only the Paseo
              browser tabs and is told to ask you, as a question, before secrets or anything destructive.
            </Text>
          ) : (
            <Text style={styles.hint}>
              It uses only the Paseo browser tabs, asks before every new tool, and stops to ask you before secrets or
              anything destructive.
            </Text>
          )}
          {layout.compact ? <Text style={styles.hint}>{DESKTOP_HINT}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable accessibilityRole="button" onPress={() => setConfirmOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start the Paseo agent"
              onPress={() => void launchAgent()}
              style={styles.primary}
            >
              <Icon name="Bot" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.primaryText}>Start agent</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
