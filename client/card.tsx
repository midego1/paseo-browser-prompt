import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { agentTitle, CHROME_RUN_MARKER, chromeAvailable, DEFAULT_AGENT_SETTINGS, opensAgentOnStart, resolveAgentConfig, runStartedInChrome, describeLaunch, type BrowserAgent } from "../shared/agent-prompt";
import { MOST_RECENT_FALLBACK } from "../shared/report-back";
import {
  blockFingerprint,
  canStartRun,
  migrateDoneMark,
  repeatView,
  runKeyMarker,
  sharedRunRecord,
  withinMessage,
} from "../shared/repeats";
import { endedRun } from "../shared/run-lock";
import { acquireRunLock, finishRunLock } from "../shared/run-lock-rpc";
import { MAX_DONE, MAX_RUNS, preferences } from "../shared/settings";
import { stashPrompt } from "../shared/trampoline";
import { CLAUDE_COLOR, CLAUDE_ICON, OPENAI_COLOR, OPENAI_ICON, PASEO_ICON } from "../shared/brand-icons";
import { archivedAfterSuccess } from "../shared/archive-rpc";
import {
  copyPrompt,
  DEFAULT_MODES,
  effectiveMode,
  recordSeenPrompt,
  rememberModes,
  startInChatGpt,
  startInClaudeDesktop,
  type ActionResult,
} from "./launch";
import { openPluginSettings, openRunScreen, resolveLaunch, startBrowserAgent, type ResolvedLaunch } from "./agent-run";
import { MessageMarkdown } from "./markdown";
import { OwnerPromptBox, useOwnerPrompts } from "./owner-prompt";
import { RUN_LABELS, runVisual, useRunState } from "./run-status";
import { SCREENSHOT_BLOCKED_HINT } from "../shared/screenshot";
import { ScreenshotStrip } from "./screenshot-thumb";
import { RunStatsRow } from "./run-stats-row";
import { StepProgressRow, useStepProgress } from "./step-progress";
import { countSteps } from "../shared/steps";
import { useUpdateOnUse } from "./update";
import { useFirstOf } from "./chat-index";

/** How long the card waits for the daemon's run lock before starting without it. */
const RUN_LOCK_RPC_TIMEOUT_MS = 5_000;

const DESKTOP_HINT = "Your Paseo desktop app must be open: the agent drives the browser tabs there.";
const CHROME_HINT = "Chrome must be open with the Claude extension signed in: the agent works there.";


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
  const mobile = Platform.OS === "ios" || Platform.OS === "android";
  const lockRun = useRpc(acquireRunLock);
  const unlockRun = useRpc(finishRunLock);
  const startMode = settings.status === "ready" ? settings.values.startMode : DEFAULT_MODES.startMode;
  const mobileStartMode =
    settings.status === "ready" ? settings.values.mobileStartMode : DEFAULT_MODES.mobileStartMode;
  // The owner's usual way is highlighted; every way stays one press away.
  const defaultMode = effectiveMode({ startMode, mobileStartMode });
  const showChrome = chromeAvailable(settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS);

  // Copies of a block in this chat share its run: the newest one started from this card's id or for
  // the same content.
  const runRecord = settings.status === "ready" ? sharedRunRecord(settings.values.runs, agentId, runKey, key) : null;
  const storedRun = runRecord?.[1] ?? null;
  const runAgentId = localRun ?? storedRun;
  // Started in this card session: an idle snapshot before its first turn means "starting".
  const {
    state: followedState,
    status: runStatus,
    createdAt: runCreatedAt,
    updatedAt: runUpdatedAt,
  } = useRunState(runAgentId, localRun !== null && localRun === runAgentId);
  // A run the plugin archived after it succeeded is closed or gone from the app's cache: still done.
  const checkArchived = useRpc(archivedAfterSuccess);
  const [archivedRun, setArchivedRun] = useState<string | null>(null);
  const mayBeArchived = !!runAgentId && (followedState === "stopped" || followedState === "unknown");
  useEffect(() => {
    if (!mayBeArchived || !runAgentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (attempt: number) => {
      void checkArchived({ agentId: runAgentId }).then(
        ({ archived }) => {
          if (!cancelled && archived) setArchivedRun(runAgentId);
        },
        () => {
          if (!cancelled && attempt < 3) timer = setTimeout(() => check(attempt + 1), 2000 * attempt);
        },
      );
    };
    check(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mayBeArchived, followedState, runAgentId]);
  const observedState = archivedRun === runAgentId && mayBeArchived ? "done" : followedState;
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
    meta: runMeta,
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
  // The browser of the run the owner just chose; the confirmation describes it.
  // The launch the confirmation describes: resolved once, then started with exactly that config.
  const [pendingLaunch, setPendingLaunch] = useState<ResolvedLaunch | null>(null);
  const launchError = pendingLaunch && "error" in pendingLaunch ? pendingLaunch.error : null;
  const inChrome = pendingLaunch?.browser === "chrome";
  // The modal describes the next run; a started run's hint names the browser it was started in.
  const [startedBrowser, setStartedBrowser] = useState<{ agentId: string; chrome: boolean } | null>(null);
  const runInChrome =
    runStartedInChrome(settings.status === "ready" ? settings.values.runs : [], runAgentId) ??
    (startedBrowser?.agentId === runAgentId && startedBrowser.chrome);

  // A later copy of a block in this chat is a full card with a hint (its buttons share the first's
  // done mark and run), and with "Collapse repeated blocks that are done" a done copy is one line
  // until the owner taps Show. Which block is first comes from the chat's index (client/chat-index).
  const collapse = settings.status === "ready" ? settings.values.mergeRepeats : true;
  const first = withinMessage(useFirstOf(paseo, agentId, fingerprint, messageId, index, true), sameAs, messageId);
  const isRepeat = first.state === "repeat";
  const [expanded, setExpanded] = useState(false);
  const view = repeatView({ collapse, first, done, expanded });

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
        borderColor: done ? theme.colors.statusSuccess : theme.colors.border,
        borderWidth: 1,
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
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, columnGap: 16, rowGap: 8 },
      // One group per service: its mark, then a button per way. Groups wrap as a whole.
      group: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
      groupMark: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, marginRight: 2 },
      groupLabel: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
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
  async function rememberRun(startedAgentId: string, fallback: boolean, chrome: boolean) {
    setLocalRun(startedAgentId);
    setStartedBrowser({ agentId: startedAgentId, chrome });
    // Position 2 stays the fallback marker the server reads; the content marker comes after it.
    const entry: [string, string, ...string[]] = [
      runKey,
      startedAgentId,
      ...(fallback ? [MOST_RECENT_FALLBACK] : []),
      runKeyMarker(key),
      ...(chrome ? [CHROME_RUN_MARKER] : []),
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

  /**
   * The daemon's in-flight lock for this block's run: null when this card may start it. When another
   * copy is starting or just started the run, this card shows that run (or waits for its record).
   * A run this card shows that has ended does not hold it. A daemon that cannot be asked (error or
   * no answer within RUN_LOCK_RPC_TIMEOUT_MS) does not block the start; the shared run record still
   * applies.
   */
  async function takeRunLock(): Promise<{ token: string | null } | null> {
    const lockInput = { sourceAgentId: agentId, ...fingerprint, endedRunId: endedRun(runAgentId, shownState) ?? undefined };
    let result: Awaited<ReturnType<typeof lockRun>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        lockRun(lockInput),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("no answer from the daemon")), RUN_LOCK_RPC_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.warn(`[browser-prompt] run lock unavailable, starting without it: ${error instanceof Error ? error.message : String(error)}`);
      return { token: null };
    } finally {
      clearTimeout(timer);
    }
    if (result.ok) return { token: result.token };
    if (result.agentId) setLocalRun(result.agentId);
    toast.show(
      result.agentId
        ? "A run of these steps was just started; this card shows it."
        : "A run of these steps is already starting; this card shows it once it has started.",
      { durationMs: 4000 },
    );
    return null;
  }

  function finishLock(token: string | null, startedAgentId?: string) {
    if (!token) return;
    void unlockRun({ sourceAgentId: agentId, ...fingerprint, token, agentId: startedAgentId }).catch((error) => {
      console.warn(`[browser-prompt] could not hand back the run lock: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async function launchAgent(launch: ResolvedLaunch | null) {
    setConfirmOpen(false);
    if (!launch || "error" in launch) return;
    const browser = launch.browser;
    if (busy) return;
    setBusy(true);
    let lockToken: string | null = null;
    try {
      const lock = await takeRunLock();
      if (!lock) return;
      lockToken = lock.token;
      const values = launch.settings;
      const started = await startBrowserAgent(paseo, {
        sourceAgentId: agentId,
        cardId,
        cachedWorkspaceId: sourceWorkspaceId,
        cardTitle: title,
        displayTitle,
        steps: text,
        settings: values,
        launch,
      });
      // The lock now names the run, so a copy pressed before the record arrives shows this run.
      finishLock(lockToken, started.agentId);
      lockToken = null;
      await rememberRun(started.agentId, started.workspaceSource === "most-recent", browser === "chrome");
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
      toast.show(`Paseo agent started${where}.`, { variant: "success", durationMs: 3000 });
      if (open) openRunScreen(started.agentId, agentTitle(title, displayTitle), true);
    } catch (error) {
      const message = `Could not start a Paseo agent: ${error instanceof Error ? error.message : String(error)}`;
      setRunError(message);
      toast.error(message);
    } finally {
      // A start that failed frees the lock at once.
      finishLock(lockToken);
      setBusy(false);
    }
  }

  // A copy of a block does not start a second run while the shared one is still going.
  const runBlocked = !canStartRun({ repeat: isRepeat, runState: runAgentId ? shownState : null });

  // Only the latest press counts; the buttons wait while it resolves.
  const pressSeq = useRef(0);
  const [resolving, setResolving] = useState(false);

  async function onRunPress(browser: BrowserAgent) {
    if (busy || resolving || runBlocked) return;
    updates.onUse();
    const seq = ++pressSeq.current;
    setResolving(true);
    let launch: ResolvedLaunch;
    try {
      launch = await resolveLaunch(paseo, settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS, browser);
    } finally {
      if (seq === pressSeq.current) setResolving(false);
    }
    if (seq !== pressSeq.current) return;
    setPendingLaunch(launch);
    if (confirmLaunch) setConfirmOpen(true);
    else if ("error" in launch) toast.error(`Could not start a Paseo agent: ${launch.error}`);
    else void launchAgent(launch);
  }

  const runVisuals = shownState === "asking" ? { icon: "CircleAlert", color: theme.colors.statusWarning } : runVisual(runState, theme);

  if (view === "collapsed") {
    return <CollapsedDone title={displayTitle} theme={theme} onShow={() => setExpanded(true)} />;
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name={done ? "CircleCheck" : "Globe"} size={16} color={done ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
        <Text style={styles.title} selectable numberOfLines={2}>
          {displayTitle}
        </Text>
        <Text style={styles.label}>{done ? "Done" : "Browser prompt"}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Browser prompt settings"
          hitSlop={8}
          onPress={() => {
            try {
              if (!openPluginSettings()) toast.error("Cannot open the settings from here.");
            } catch {
              toast.error("Cannot open the settings from here.");
            }
          }}
        >
          <Icon name="Settings" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {view === "repeat" ? (
        <View style={styles.runRow}>
          <Text style={styles.hint}>Also shown earlier in this chat</Text>
          {expanded && done ? (
            <>
              <Text style={styles.hint}>·</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Collapse ${displayTitle}`} onPress={() => setExpanded(false)}>
                <Text style={styles.link}>Hide</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
      <View style={styles.promptBox}>
        <Text selectable style={styles.prompt}>
          {text}
        </Text>
      </View>
      <View style={styles.actions}>
        <View style={styles.group} accessibilityRole="toolbar" accessibilityLabel="Paseo">
          <View style={styles.groupMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Icon icon={PASEO_ICON} size={16} color={theme.colors.foreground} />
            <Text style={styles.groupLabel}>Paseo</Text>
          </View>
          <WayButton
            label={runAgentId ? "Again: Paseo browser" : "Paseo browser"}
            a11y={`Run ${displayTitle} with a Paseo agent in the Paseo browser`}
            hint={runBlocked ? "A run of these steps is still going; its status shows below" : undefined}
            highlighted={defaultMode === "paseo"}
            disabled={busy || resolving || runBlocked}
            styles={styles}
            onPress={() => void onRunPress("paseo")}
          />
        </View>
        <View style={styles.group} accessibilityRole="toolbar" accessibilityLabel="ChatGPT">
          <View style={styles.groupMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Icon icon={OPENAI_ICON} size={16} color={OPENAI_COLOR} />
            <Text style={styles.groupLabel}>ChatGPT</Text>
          </View>
          {mobile ? null : (
            <WayButton
              label="Desktop"
              a11y={`Start ${displayTitle} in the ChatGPT desktop app`}
              highlighted={defaultMode === "app"}
              disabled={busy}
              styles={styles}
              onPress={() => void run(() => startInChatGpt(title, text, "app", (prompt) => stash({ prompt })))}
            />
          )}
          <WayButton
            label="Web"
            a11y={`Start ${displayTitle} in ChatGPT on the web`}
            highlighted={defaultMode === "web-agent"}
            disabled={busy}
            styles={styles}
            onPress={() => void run(() => startInChatGpt(title, text, "web-agent", (prompt) => stash({ prompt })))}
          />
        </View>
        {mobile && !showChrome ? null : (
          <View style={styles.group} accessibilityRole="toolbar" accessibilityLabel="Claude">
            <View style={styles.groupMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Icon icon={CLAUDE_ICON} size={16} color={CLAUDE_COLOR} />
              <Text style={styles.groupLabel}>Claude</Text>
            </View>
            {mobile ? null : (
              <WayButton
                label="Desktop"
                a11y={`Start ${displayTitle} in the Claude desktop app`}
                highlighted={defaultMode === "claude-desktop"}
                disabled={busy}
                styles={styles}
                onPress={() => void run(() => startInClaudeDesktop(title, text, (prompt) => stash({ prompt, target: "claude" })))}
              />
            )}
            {showChrome ? (
              <WayButton
                label={runAgentId ? "Again: Chrome tab" : "Chrome tab"}
                a11y={`Run ${displayTitle} with a Paseo agent in a tab of your Chrome, through Claude in Chrome`}
                hint={runBlocked ? "A run of these steps is still going; its status shows below" : undefined}
                highlighted={defaultMode === "chrome"}
                disabled={busy || resolving || runBlocked}
                styles={styles}
                onPress={() => void onRunPress("chrome")}
              />
            ) : null}
          </View>
        )}
        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Copy ${displayTitle}`}
            disabled={busy}
            onPress={() =>
              void run(() =>
                defaultMode === "copy-only"
                  ? startInChatGpt(title, text, "copy-only", (prompt) => stash({ prompt }))
                  : copyPrompt(title, text),
              )
            }
            style={defaultMode === "copy-only" ? styles.primary : styles.secondary}
          >
            <Icon name="Copy" size={14} color={defaultMode === "copy-only" ? theme.colors.accentForeground : theme.colors.foreground} />
            <Text style={defaultMode === "copy-only" ? styles.primaryText : styles.secondaryText}>Copy</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={done ? `Mark ${displayTitle} not done` : `Mark ${displayTitle} done`}
            accessibilityState={{ checked: done }}
            onPress={() => void toggleDone()}
            style={styles.secondary}
          >
            <Icon name={done ? "Undo2" : "Check"} size={14} color={done ? theme.colors.statusSuccess : theme.colors.foreground} />
            <Text style={done ? [styles.secondaryText, { color: theme.colors.statusSuccess }] : styles.secondaryText}>
              {done ? "Undo done" : "Mark done"}
            </Text>
          </Pressable>
        </View>
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
          <Text style={styles.hint}>{runInChrome ? "in Chrome" : "in Paseo browser"}</Text>
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
      {runAgentId ? (
        <RunStatsRow
          state={shownState}
          createdAt={runCreatedAt}
          updatedAt={runUpdatedAt}
          lastEntryAt={runMeta.lastEntryAt}
          usage={runMeta.usage}
          streamSkewMs={runMeta.skewMs}
          theme={theme}
          compact={layout.compact}
        />
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
      {runAgentId && layout.compact ? <Text style={styles.hint}>{runInChrome ? CHROME_HINT : DESKTOP_HINT}</Text> : null}
      <Modal
        title="Run with Paseo agent"
        icon={<Icon name="Bot" size={18} color={theme.colors.foreground} />}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      >
        <Modal.Content>
          <Text style={styles.modalText}>Start a Paseo agent to do these steps in your browser?</Text>
          {active ? <Text style={[styles.hint, { color: theme.colors.statusWarning }]}>A run of these steps is still going. This starts a second one.</Text> : null}
          {launchError ? (
            <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>{launchError}</Text>
          ) : pendingLaunch && "config" in pendingLaunch ? (
            <Text style={styles.hint}>{describeLaunch(pendingLaunch.config, pendingLaunch.browser)}</Text>
          ) : null}
          {layout.compact ? <Text style={styles.hint}>{inChrome ? CHROME_HINT : DESKTOP_HINT}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable accessibilityRole="button" onPress={() => setConfirmOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start the Paseo agent"
              disabled={!!launchError}
              onPress={() => void launchAgent(pendingLaunch)}
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

/** One way to run the steps: highlighted when it is the owner's usual way. */
function WayButton({
  label,
  a11y,
  hint,
  highlighted,
  disabled,
  styles,
  onPress,
}: {
  label: string;
  a11y: string;
  hint?: string;
  highlighted: boolean;
  disabled: boolean;
  styles: { primary: object; secondary: object; primaryText: object; secondaryText: object };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[highlighted ? styles.primary : styles.secondary, disabled ? { opacity: 0.5 } : null]}
    >
      <Text style={highlighted ? styles.primaryText : styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

/** A later copy of a block that is done: one line, and Show expands the full card right here. */
function CollapsedDone({ title, theme, onShow }: { title: string; theme: PluginTimelineItemProps["theme"]; onShow: () => void }) {
  return (
    <View
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
        borderColor: theme.colors.statusSuccess,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" }}>✓ Already done</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>
        · {title} ·
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Show ${title}`} accessibilityHint="Shows the card here" onPress={onShow}>
        <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>Show</Text>
      </Pressable>
    </View>
  );
}
