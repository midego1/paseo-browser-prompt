import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { agentTitle, DEFAULT_AGENT_SETTINGS, opensAgentOnStart, resolveAgentConfig, usesClassifierMode } from "../shared/agent-prompt";
import { MOST_RECENT_FALLBACK } from "../shared/report-back";
import { blockFingerprint, migrateDoneMark, ownsRun, repeatView, runItemMarker, withinMessage } from "../shared/repeats";
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
import { OwnerPromptBox, useOwnerPrompts } from "./owner-prompt";
import { RUN_LABELS, runVisual, useRunState } from "./run-status";
import { SCREENSHOT_BLOCKED_HINT } from "../shared/screenshot";
import { ScreenshotStrip } from "./screenshot-thumb";
import { StepProgressRow, useStepProgress } from "./step-progress";
import { countSteps } from "../shared/steps";
import { useUpdateOnUse } from "./update";
import { flashFirst, useFirstOf, useFlashTarget } from "./chat-index";

const DESKTOP_HINT = "Your Paseo desktop app must be open: the agent drives the browser tabs there.";


export const cardSchema = z.object({
  cardId: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  text: z.string(),
  messageId: z.string().optional(),
  sameAs: z.number().int().nonnegative().optional(),
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
  const { cardId, title, text, index, messageId, sameAs } = item.data;
  // Runs stay keyed by this card's own id: the server checks a run's card label against this entry.
  const runKey = `${agentId}:${cardId}`;
  // Done marks are per content key in this chat, so every repeat of a block shares its first's mark.
  // Before 0.9.0 a mark was the run key; a card that finds its old mark moves it (see below).
  const fingerprint = useMemo(() => blockFingerprint(title, text), [title, text]);
  const key = fingerprint.key;
  const doneMark = `${agentId}:${key}`;
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

  const persistedDone =
    settings.status === "ready" ? settings.values.done.includes(doneMark) || settings.values.done.includes(runKey) : false;
  const done = localDone ?? persistedDone;
  const stash = useRpc(stashPrompt);
  const startMode = settings.status === "ready" ? settings.values.startMode : DEFAULT_MODES.startMode;
  const mobileStartMode =
    settings.status === "ready" ? settings.values.mobileStartMode : DEFAULT_MODES.mobileStartMode;

  const runRecord = settings.status === "ready" ? (settings.values.runs.find(([entry]) => entry === runKey) ?? null) : null;
  const storedRun = runRecord?.[1] ?? null;
  const runAgentId = localRun ?? storedRun;
  // Started in this card session: an idle snapshot before its first turn means "starting".
  const {
    state: observedState,
    status: runStatus,
    updatedAt: runUpdatedAt,
  } = useRunState(runAgentId, localRun !== null && localRun === runAgentId);
  const totalSteps = useMemo(() => countSteps(text), [text]);
  const showSteps =
    settings.status === "ready" ? settings.values.showStepProgress : DEFAULT_AGENT_SETTINGS.showStepProgress;
  const showScreenshot =
    settings.status === "ready" ? settings.values.showLiveScreenshot : DEFAULT_AGENT_SETTINGS.showLiveScreenshot;
  const thumbnailMode =
    settings.status === "ready" ? settings.values.thumbnailMode : DEFAULT_AGENT_SETTINGS.thumbnailMode;
  const {
    progress: stepProgress,
    asking,
    screenshot,
    screenshots,
    screenshotStep,
    screenshotsBlocked,
    permissionPending,
    permissionEvents,
  } = useStepProgress(runAgentId, totalSteps, observedState, runStatus, showSteps, showScreenshot);
  // The run's pending question or permission, answered here only by the owner's click. Paseo does
  // not mark a running agent that waits for a permission, so the card reads the run's snapshot when
  // it opens a running run and whenever the live stream shows a request or its resolution.
  const ownerCard = useMemo(() => ({ sourceAgentId: agentId, cardId }), [agentId, cardId]);
  const active = observedState === "running" || observedState === "needs-input";
  const ownerVersion = `${runStatus}:${permissionEvents}:${observedState === "needs-input" ? runUpdatedAt : ""}`;
  const owner = useOwnerPrompts(runAgentId, active, ownerVersion, ownerCard, permissionPending);
  const runState = active && (permissionPending || owner.pending > 0) ? "needs-input" : observedState;
  // An idle run whose latest turn is a question waits for the chat; it is not done yet.
  const shownState = asking && runState === "done" ? "asking" : runState;
  const confirmLaunch =
    settings.status === "ready" ? settings.values.confirmAgentLaunch : DEFAULT_AGENT_SETTINGS.confirmAgentLaunch;
  /** The next run uses Claude Auto mode (classifier-reviewed, the default); the confirmation says so. */
  const launchesInAutoMode = useMemo(() => {
    try {
      return usesClassifierMode(resolveAgentConfig(settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS));
    } catch {
      return false;
    }
  }, [settings]);

  // Merge repeated blocks: a later block with the same content as an earlier one in this chat shows
  // as one line pointing up, unless it has a run of its own (recorded before merging existed).
  const merge = settings.status === "ready" ? settings.values.mergeRepeats : true;
  const first = withinMessage(useFirstOf(paseo, agentId, fingerprint, messageId, index, merge), merge ? sameAs : undefined, messageId);
  // Identical blocks share a run key: only a run started from this very block keeps a repeat's card.
  const ownRun = localRun !== null || ownsRun(runRecord, messageId, index);
  const view = repeatView({ merge, first, done, ownRun });
  const isFirst = first.state !== "repeat";
  const flashing = useFlashTarget(doneMark, view === "full" && isFirst);

  // Moves a done mark from before 0.9.0 (the run key) to this block's content key.
  const savedRevision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (settings.status !== "ready") return;
    const next = migrateDoneMark(settings.values.done, runKey, doneMark);
    if (next) void settings.save({ ...settings.values, done: next.slice(-MAX_DONE) }, settings.revision);
  }, [savedRevision, runKey, doneMark]);

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
        borderColor: flashing ? theme.colors.accent : done ? theme.colors.statusSuccess : theme.colors.border,
        borderWidth: flashing ? 2 : 1,
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
  }, [theme, layout.compact, done, flashing]);

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
    const without = settings.values.done.filter((mark) => mark !== doneMark && mark !== runKey);
    const list = next ? [...without, doneMark].slice(-MAX_DONE) : without;
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
    // Position 2 stays the fallback marker the server reads; the block's own marker comes after it.
    const marker = runItemMarker(messageId, index);
    const entry: [string, string, ...string[]] = [
      runKey,
      startedAgentId,
      ...(fallback ? [MOST_RECENT_FALLBACK] : []),
      ...(marker ? [marker] : []),
    ];
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = latestSettings.current;
      if (current.status === "ready") {
        const without = current.values.runs.filter(([entry]) => entry !== runKey);
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
      // Background by default: the card shows the run's status and its Open link.
      const open = opensAgentOnStart(values);
      const notice = open ? `Paseo agent started${where}.` : `Paseo agent started in the background${where}. The card shows its status.`;
      toast.show(layout.compact ? `${notice} ${DESKTOP_HINT}` : notice, { variant: "success", durationMs: 5000 });
      if (open) openRunScreen(started.agentId, agentTitle(title, displayTitle), true);
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

  const runVisuals = shownState === "asking" ? { icon: "CircleAlert", color: theme.colors.statusWarning } : runVisual(runState, theme);

  /** A repeat: show the first card. Paseo has no plugin API to scroll the chat to another item. */
  function showFirst() {
    const scrolled = scrollToFirst(anchorId(agentId, key));
    flashFirst(doneMark);
    if (!scrolled) toast.show("Scroll up to the first card", { durationMs: 3000 });
  }

  if (view !== "full") {
    return <RepeatLine done={view === "done"} title={displayTitle} theme={theme} onPress={showFirst} />;
  }

  return (
    <View style={styles.card} nativeID={isFirst ? anchorId(agentId, key) : undefined}>
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
          <Text style={styles.doneText}>{done ? "Undo done" : "Mark done"}</Text>
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
          <Text
            style={[
              styles.runText,
              runState === "done" || runState === "failed" ? { color: runVisuals.color } : null,
              runState === "needs-input" ? { color: theme.colors.statusWarning, fontWeight: "700" as const } : null,
            ]}
          >
            {shownState === "asking" ? "Waiting for the chat's answer" : RUN_LABELS[runState]}
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
      {runAgentId && showSteps ? (
        <StepProgressRow progress={stepProgress} total={totalSteps} state={shownState} theme={theme} compact={layout.compact} />
      ) : null}
      {runAgentId && runState === "needs-input" ? (
        <OwnerPromptBox
          prompts={owner.prompts}
          verified={owner.verified}
          theme={theme}
          onAnswer={async (requestId, response) => {
            try {
              await owner.answer(requestId, response);
            } catch (error) {
              toast.error(`Could not send your answer: ${error instanceof Error ? error.message : String(error)}`);
            }
          }}
          onOpen={() => {
            if (!openRunScreen(runAgentId, agentTitle(title, displayTitle), true)) toast.error("Cannot open the agent from here.");
          }}
        />
      ) : null}
      {runAgentId && showScreenshot ? (
        <ScreenshotStrip
          shots={screenshots}
          latestStep={screenshotStep}
          mode={thumbnailMode}
          theme={theme}
          onOpen={() => {
            if (!openRunScreen(runAgentId, agentTitle(title, displayTitle), true)) toast.error("Cannot open the agent from here.");
          }}
        />
      ) : null}
      {runAgentId && showScreenshot && screenshotsBlocked && !screenshot ? (
        <Text style={styles.hint}>{SCREENSHOT_BLOCKED_HINT}</Text>
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
            <Text style={styles.hint}>
              It runs in Claude Auto mode: a model classifier reviews its tool calls. It uses only the Paseo browser
              tabs and is told to ask you, as a question, before secrets or anything destructive.
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

/** The DOM id of a block's first card (react-native-web turns `nativeID` into `id`). */
function anchorId(agentId: string, key: string): string {
  return `browser-prompt-first-${agentId}-${key}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Scrolls the chat to a block's first card where that is possible: in the web and desktop app, when
 * the card is rendered. False on phones (no DOM) and when the list has not rendered the card.
 */
function scrollToFirst(id: string): boolean {
  const doc = (globalThis as { document?: { getElementById(id: string): { scrollIntoView(options?: object): void } | null } })
    .document;
  if (Platform.OS !== "web" || !doc) return false;
  const element = doc.getElementById(id);
  if (!element) return false;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/** A repeated block: one line that points to the first card ("Already done" when that one is done). */
function RepeatLine({
  done,
  title,
  theme,
  onPress,
}: {
  done: boolean;
  title: string;
  theme: PluginTimelineItemProps["theme"];
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={done ? `Already done: ${title}` : `Same step as above: ${title}`}
      accessibilityHint="Shows the first card with these steps"
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        maxWidth: "100%",
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: done ? theme.colors.statusSuccess : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: done ? theme.colors.statusSuccess : theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {done ? "✓ Already done" : "↑ Same step as above"}
      </Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>
        · {title}
      </Text>
    </Pressable>
  );
}
