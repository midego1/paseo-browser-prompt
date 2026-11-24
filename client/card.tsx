import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { z } from "zod";
import { agentTitle, CHROME_RUN_MARKER, chromeAvailable, DEFAULT_AGENT_SETTINGS, opensAgentOnStart, runBrowserOf, describeLaunch, type BrowserAgent } from "../shared/agent-prompt";
import { SERVER_BROWSER_STATE_MESSAGES, SERVER_RUN_MARKER, serverRunLabels } from "../shared/server-browser";
import { prepareServerBrowserRun, serverBrowserStatus } from "../shared/server-browser-rpc";
import { SIGNED_IN_RUN_MARKER, SIGNED_IN_STATE_MESSAGES, signedInRunLabels } from "../shared/signed-in";
import { prepareSignedInRun, signedInStatus, signedInViewerLink } from "../shared/signed-in-rpc";
import { MOST_RECENT_FALLBACK } from "../shared/report-back";
import {
  addRunRecord,
  blockFingerprint,
  canStartRun,
  cardRun,
  migrateDoneMark,
  repeatView,
  runIsRecorded,
  runKeyMarker,
  sharedRunRecord,
  withinMessage,
} from "../shared/repeats";
import { acquireWithin, endedRun, finishWithRetry } from "../shared/run-lock";
import { acquireRunLock, finishRunLock } from "../shared/run-lock-rpc";
import { cardSettings, MAX_DONE, MAX_RUNS, preferences } from "../shared/settings";
import { createSettingsMirror, saveWithRetries, withDoneMark, type RetrySettings } from "../shared/settings-save";
import { stashPrompt } from "../shared/trampoline";
import { CLAUDE_COLOR, CLAUDE_ICON, OPENAI_COLOR, OPENAI_ICON } from "../shared/brand-icons";
import {
  cardLayout,
  cardPhase,
  cardTints,
  chatGptTarget,
  markRunStopped,
  mixColor,
  ownerStopState,
  runStoppedByOwner,
  stopRefusal,
  defaultRunWay,
  DEFAULT_CARD_CHOICES,
  RUN_WAY_A11Y,
  RUN_WAY_TITLES,
  runMenuItems,
  sentNote,
  STOP_CONFIRM_MS,
  type RunWay,
  type SendTo,
} from "../shared/card-layout";
import { archivedAfterSuccess } from "../shared/archive-rpc";
import {
  copyForClaude,
  copyPrompt,
  DEFAULT_MODES,
  effectiveMode,
  recordSeenPrompt,
  rememberChatGptTarget,
  rememberModes,
  startInChatGpt,
  startInClaudeDesktop,
  type ActionResult,
} from "./launch";
import { openPluginSettings, openRunScreen, resolveLaunch, startBrowserAgent, stopRunAgent, type ResolvedLaunch } from "./agent-run";
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
const SERVER_HINT = "Runs in a browser on the Paseo server: no desktop app needed, but not signed in to your accounts.";
const SIGNED_IN_HINT =
  "Runs in your signed-in browser on the Paseo server: no desktop app needed. Use Take over to watch it, or to log in or enter a 2FA code from any device (in a new tab: the agent cannot see tabs you open).";
/** Under the Take over button while a signed-in run waits for the owner. */
const SIGNED_IN_TAKEOVER_HELP =
  "Tap the mouse icon to take control and log in in a new tab (+); release control when done (tap the mouse icon again or close the viewer), and the run goes on.";
const HINTS: Record<BrowserAgent, string> = { paseo: DESKTOP_HINT, chrome: CHROME_HINT, server: SERVER_HINT, "signed-in": SIGNED_IN_HINT };
const BROWSER_NAMES: Record<BrowserAgent, string> = {
  paseo: "in Paseo browser",
  chrome: "in Chrome",
  server: "in server browser",
  "signed-in": "in signed-in server browser",
};
/** How long the card waits for the Server browser status or ticket. */
const SERVER_BROWSER_RPC_TIMEOUT_MS = 20_000;
/** The signed-in browser may have to start first (up to about a minute and a half). */
const SIGNED_IN_RPC_TIMEOUT_MS = 150_000;

/** Rejects when the RPC does not answer in time. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The Paseo server did not answer in time.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type PreferenceValues = z.output<(typeof preferences)["schema"]>;
/** The newest settings any card rendered, for saves retried after their own card unmounted. */
const settingsMirror = createSettingsMirror<PreferenceValues>();


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

type Theme = PluginTimelineItemProps["theme"];

/**
 * The card's styles for a theme and layout (see design/card-streamline/NOTES.md in the design
 * branch): spacing 4·8·12·16, buttons 40 high in the chat column and at least 44 on a phone,
 * quiet row 32 (44 on a phone). Only flex rows, borders and radii: no CSS-only effects.
 */
function cardStyles(theme: Theme, compact: boolean, touch: boolean) {
  const tints = cardTints(theme.colors);
  // A touch screen (a phone, or an iPad in the wide layout) never gets a target under 44.
  const h = compact || touch ? 44 : 40;
  const radius = 8;
  const button = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    minHeight: h,
    paddingHorizontal: 14,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  };
  return {
    h,
    tints,
    card: {
      borderColor: theme.colors.border,
      borderWidth: 1,
      backgroundColor: theme.colors.surface1,
      borderRadius: 10,
      padding: compact ? 12 : 16,
      gap: 12,
    },
    cardDone: { borderColor: tints.successLine },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 24 },
    title: { flex: 1, color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 15 },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    gear: { width: 28, height: 28, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: radius, marginRight: -4 },
    promptBox: {
      backgroundColor: theme.colors.surface0,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: radius,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    prompt: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 13, lineHeight: 20 },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8 },
    primary: { ...button, backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const, fontSize: 14 },
    secondary: button,
    secondaryText: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
    dangerText: { color: theme.colors.statusDanger, fontSize: 14, fontWeight: "500" as const },
    ghost: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      minHeight: compact || touch ? 44 : 32,
      paddingHorizontal: 8,
      borderRadius: radius,
      ...(compact ? { flexGrow: 1 } : null),
    },
    ghostText: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
    quiet: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 4,
      marginVertical: compact ? -8 : -4,
      marginLeft: compact ? 0 : -8,
    },
    statusRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, columnGap: 8, rowGap: 4 },
    statusText: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    where: { color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 },
    link: { color: tints.accentText, fontSize: 13, fontWeight: "600" as const },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    note: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    noteText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    runRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    runBlock: compact ? { gap: 12 } : { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 16 },
    runMain: { flex: compact ? undefined : 1, minWidth: 0, gap: 8 },
    shotBeside: { width: 192 },
    ask: {
      borderWidth: 1,
      borderColor: tints.warningLine,
      backgroundColor: tints.warningTint,
      borderRadius: radius,
      padding: 12,
      gap: 10,
    },
    askHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    askHeadText: { color: theme.colors.statusWarning, fontWeight: "700" as const, fontSize: 14, flexShrink: 1 },
    sendCaption: { color: theme.colors.foregroundMuted, fontSize: 13, paddingLeft: 4 },
    modalText: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
    modalActions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, justifyContent: "flex-end" as const },
    menuItem: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      minHeight: compact || touch ? 60 : 52,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: radius,
    },
    menuIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    menuTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    menuDetail: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    tag: {
      borderWidth: 1,
      borderColor: tints.accentText,
      borderRadius: 99,
      paddingHorizontal: 8,
      paddingVertical: 1,
    },
    tagText: { color: tints.accentText, fontSize: 11, fontWeight: "600" as const },
    separator: { height: 1, backgroundColor: theme.colors.border, marginVertical: 6, marginHorizontal: 4 },
  };
}

type CardStyles = ReturnType<typeof cardStyles>;

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
  settingsMirror.publish(settings as RetrySettings<PreferenceValues>);
  const newestSettings = () => settingsMirror.latest(latestSettings.current as RetrySettings<PreferenceValues>);
  const toast = useToast();
  const [localDone, setLocalDone] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // A run this card started or was handed by the run lock, until its record arrives (see cardRun).
  const [localRun, setLocalRun] = useState<string | null>(null);
  // The run the owner stopped with this card's Stop in this session (also recorded on the run, see stopRun).
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  // The run this card started in this session: before its first turn an idle snapshot means "starting".
  const [startedHere, setStartedHere] = useState<string | null>(null);
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
  const serverStatus = useRpc(serverBrowserStatus);
  const prepareServerRun = useRpc(prepareServerBrowserRun);
  const signedInState = useRpc(signedInStatus);
  const prepareSignedIn = useRpc(prepareSignedInRun);
  const viewerLink = useRpc(signedInViewerLink);
  const [openingViewer, setOpeningViewer] = useState(false);
  const unlockRun = useRpc(finishRunLock);
  const startMode = settings.status === "ready" ? settings.values.startMode : DEFAULT_MODES.startMode;
  const mobileStartMode =
    settings.status === "ready" ? settings.values.mobileStartMode : DEFAULT_MODES.mobileStartMode;
  // Today's usual way: until the owner picks in the card settings, it decides Run's browser and
  // where Send to ChatGPT goes (shared/card-layout.ts), so nothing changes on the update.
  const usualWay = effectiveMode({ startMode, mobileStartMode });
  const showChrome = chromeAvailable(settings.status === "ready" ? settings.values : DEFAULT_AGENT_SETTINGS);
  const cardPrefs = useSettings(cardSettings);
  const choices = cardPrefs.status === "ready" ? cardPrefs.values : DEFAULT_CARD_CHOICES;
  const runWay = defaultRunWay(choices, usualWay, showChrome);
  const gptTarget = chatGptTarget(choices, usualWay, mobile);
  const claudeTarget = choices.claude;

  // Copies of a block in this chat share its run: the newest one started from this card's id or for
  // the same content.
  const storedRuns = settings.status === "ready" ? settings.values.runs : null;
  const runRecord = storedRuns ? sharedRunRecord(storedRuns, agentId, runKey, key) : null;
  const storedRun = runRecord?.[1] ?? null;
  const runAgentId = cardRun(localRun, storedRun, storedRuns ?? []);
  // Once recorded, the shared record decides: a newer run started from another copy shows here.
  const localRecorded = !!localRun && !!storedRuns && runIsRecorded(storedRuns, localRun);
  useEffect(() => {
    if (localRecorded) setLocalRun(null);
  }, [localRecorded]);
  const {
    state: followedState,
    status: runStatus,
    createdAt: runCreatedAt,
    updatedAt: runUpdatedAt,
  } = useRunState(runAgentId, startedHere !== null && startedHere === runAgentId);
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
  // A stopped (archived) run can look idle, so "done", or vanish from the cache: it shows as stopped.
  const observedState = ownerStopState(archivedRun === runAgentId && mayBeArchived ? "done" : followedState, {
    here: !!runAgentId && stoppedRun === runAgentId,
    recorded: runStoppedByOwner(storedRuns ?? [], runAgentId),
  });
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
  // The launch the confirmation describes (browser, provider and mode): resolved once, then started
  // with exactly that config.
  const [pendingLaunch, setPendingLaunch] = useState<ResolvedLaunch | null>(null);
  const launchError = pendingLaunch && "error" in pendingLaunch ? pendingLaunch.error : null;
  const pendingBrowser: BrowserAgent = pendingLaunch?.browser ?? "paseo";
  // The modal describes the next run; a started run's hint names the browser it was started in.
  const [startedBrowser, setStartedBrowser] = useState<{ agentId: string; browser: BrowserAgent } | null>(null);
  const runBrowser: BrowserAgent =
    runBrowserOf(settings.status === "ready" ? settings.values.runs : [], runAgentId) ??
    (startedBrowser?.agentId === runAgentId ? startedBrowser.browser : "paseo");

  // A later copy of a block in this chat is a full card with a hint (its buttons share the first's
  // done mark and run), and with "Collapse repeated blocks that are done" a done copy is one line
  // until the owner taps Show. Which block is first comes from the chat's index (client/chat-index).
  // With collapsing off the index only matters while the shared run is going (the run guard below),
  // so the chat is read then and not for every card.
  const collapse = settings.status === "ready" ? settings.values.mergeRepeats : true;
  const sharedRunGoing = !!runAgentId && !canStartRun({ repeat: true, runState: shownState });
  const first = withinMessage(useFirstOf(paseo, agentId, fingerprint, messageId, index, collapse || sharedRunGoing), sameAs, messageId);
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

  useEffect(() => {
    if (cardPrefs.status === "ready") rememberChatGptTarget(gptTarget);
  }, [cardPrefs.status, gptTarget]);

  const styles = useMemo(() => cardStyles(theme, layout.compact, mobile), [theme, layout.compact, mobile]);

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

  /** Saves the done mark; a save that loses a revision race is retried against the newest settings. */
  async function toggleDone() {
    const next = !done;
    setLocalDone(next);
    if (settings.status !== "ready") return; // stays in memory for this session
    const saved = await saveWithRetries(
      newestSettings,
      (values) => ({ ...values, done: withDoneMark(values.done, doneMark, runKey, next, MAX_DONE) }),
    );
    // Saved: the stored mark shows. Not saved: the card shows the stored state again and says so.
    setLocalDone(null);
    if (!saved) toast.error(next ? "Could not save the done mark; try again." : "Could not remove the done mark; try again.");
  }

  const displayTitle = title || `Browser prompt ${index + 1}`;

  /**
   * Records the run in host settings. The server checks a run's mode and reports it back only when it
   * finds this entry, so an earlier run of this card keeps its own, and a save that loses a revision
   * race is retried against the newest settings (any mounted card's, also after this one unmounted).
   */
  async function rememberRun(startedAgentId: string, fallback: boolean, browser: BrowserAgent) {
    setLocalRun(startedAgentId);
    // A new run: the note about an earlier Send no longer applies.
    setSentTo(null);
    setStartedHere(startedAgentId);
    setStartedBrowser({ agentId: startedAgentId, browser });
    // Position 2 stays the fallback marker the server reads; the content marker comes after it.
    const entry: [string, string, ...string[]] = [
      runKey,
      startedAgentId,
      ...(fallback ? [MOST_RECENT_FALLBACK] : []),
      runKeyMarker(key),
      ...(browser === "chrome"
        ? [CHROME_RUN_MARKER]
        : browser === "server"
          ? [SERVER_RUN_MARKER]
          : browser === "signed-in"
            ? [SIGNED_IN_RUN_MARKER]
            : []),
    ];
    const saved = await saveWithRetries(newestSettings, (values) => ({ ...values, runs: addRunRecord(values.runs, entry, MAX_RUNS) }));
    if (!saved) toast.error("Could not record the agent on this card; it will not report back to this chat.");
  }

  /**
   * The daemon's in-flight lock for this block's run: null when this card may start it. When another
   * copy is starting or just started the run, this card shows that run (or waits for its record).
   * A run this card shows that has ended does not hold it. A daemon that cannot be asked (error or
   * no answer within RUN_LOCK_RPC_TIMEOUT_MS) does not block the start; the shared run record still
   * applies, and a grant that arrives after the timeout is handed back at once.
   */
  async function takeRunLock(): Promise<{ token: string | null } | null> {
    const lockInput = { sourceAgentId: agentId, ...fingerprint, endedRunId: endedRun(runAgentId, shownState) ?? undefined };
    const result = await acquireWithin(() => lockRun(lockInput), RUN_LOCK_RPC_TIMEOUT_MS, (token) => finishLock(token));
    if ("unavailable" in result) {
      console.warn(`[browser-prompt] run lock unavailable, starting without it: ${result.unavailable}`);
      return { token: null };
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

  /** Hands the lock back (tried once more on failure), so the block is not held for RUN_LOCK_TTL_MS. */
  function finishLock(token: string | null, startedAgentId?: string) {
    if (!token) return;
    void finishWithRetry(() => unlockRun({ sourceAgentId: agentId, ...fingerprint, token, agentId: startedAgentId })).then((ok) => {
      if (!ok) console.warn("[browser-prompt] could not hand back the run lock");
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
      // A Server browser run needs a ready image and a one-time ticket for this chat and card: the
      // server attaches the browser to the run's first session only with it.
      let extraLabels: Record<string, string> | undefined;
      if (browser === "server") {
        const prepared = await within(prepareServerRun({ sourceAgentId: agentId, cardId }), SERVER_BROWSER_RPC_TIMEOUT_MS);
        if (!prepared.ok) {
          const detail = prepared.detail ? ` (${prepared.detail})` : "";
          toast.error(`${SERVER_BROWSER_STATE_MESSAGES[prepared.state]}${detail}`);
          return;
        }
        extraLabels = serverRunLabels(prepared.ticket);
      }
      // A signed-in run: the browser starts if needed, and only one run at a time may hold it.
      if (browser === "signed-in") {
        const prepared = await within(prepareSignedIn({ sourceAgentId: agentId, cardId }), SIGNED_IN_RPC_TIMEOUT_MS);
        if (!prepared.ok) {
          const detail = prepared.detail ? ` (${prepared.detail})` : "";
          toast.error(`${SIGNED_IN_STATE_MESSAGES[prepared.state]}${detail}`);
          return;
        }
        extraLabels = signedInRunLabels(prepared.ticket);
      }
      const started = await startBrowserAgent(paseo, {
        sourceAgentId: agentId,
        cardId,
        cachedWorkspaceId: sourceWorkspaceId,
        cardTitle: title,
        displayTitle,
        steps: text,
        settings: values,
        launch,
        extraLabels,
        // Recorded as soon as it exists, before its mode check: the server's guard and report back
        // then cover it even when that check is slow or cannot read its mode.
        onCreated: async (createdId, workspaceSource) => {
          // The lock now names the run, so a copy pressed before the record arrives shows this run.
          finishLock(lockToken, createdId);
          lockToken = null;
          await rememberRun(createdId, workspaceSource === "most-recent", browser);
        },
      });
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
      const withBrowser = browser === "server" ? " with the server browser" : browser === "signed-in" ? " with your signed-in server browser" : "";
      toast.show(`Paseo agent started${where}${withBrowser}.`, { variant: "success", durationMs: 3000 });
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
      if (browser === "server") {
        // No run without Docker and the image. The card never downloads or builds it: that is the
        // owner's explicit choice in the plugin settings (it downloads about 2.6 GB).
        let reason: string | null = null;
        try {
          const status = await within(serverStatus({}), SERVER_BROWSER_RPC_TIMEOUT_MS);
          if (status.state !== "ready") reason = `${SERVER_BROWSER_STATE_MESSAGES[status.state]}${status.detail ? ` (${status.detail})` : ""}`;
        } catch (error) {
          reason = `Could not check the Server browser: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (reason) {
          if (seq === pressSeq.current) toast.error(reason);
          return;
        }
      }
      if (browser === "signed-in") {
        // Never downloads or builds: that is the owner's explicit choice in the plugin settings.
        let reason: string | null = null;
        try {
          const status = await within(signedInState({}), SERVER_BROWSER_RPC_TIMEOUT_MS);
          if (status.state !== "ready" && status.state !== "running" && status.state !== "failed") {
            reason = `${SIGNED_IN_STATE_MESSAGES[status.state]}${status.detail ? ` (${status.detail})` : ""}`;
          } else if (status.busy) reason = SIGNED_IN_STATE_MESSAGES.busy;
        } catch (error) {
          reason = `Could not check the signed-in browser: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (reason) {
          if (seq === pressSeq.current) toast.error(reason);
          return;
        }
      }
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

  /** Opens the owner's viewer of the signed-in browser (a one-time link from the daemon, never shown in chat). */
  async function takeOver() {
    if (openingViewer) return;
    setOpeningViewer(true);
    try {
      const link = await within(viewerLink({ purpose: "takeover", portrait: mobile }), SIGNED_IN_RPC_TIMEOUT_MS);
      if (!link.ok) {
        toast.error(`${SIGNED_IN_STATE_MESSAGES[link.state]}${link.detail ? ` (${link.detail})` : ""}`);
        return;
      }
      await openExternalUrl(link.url);
    } catch (error) {
      toast.error(`Could not open the signed-in browser: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpeningViewer(false);
    }
  }

  // Run once in…: the sheet (a bottom sheet on a phone) with every browser. A row runs once.
  const [menuOpen, setMenuOpen] = useState(false);
  // The folded done card's Show steps.
  const [stepsOpen, setStepsOpen] = useState(false);
  // The last Send that worked, for the note that it does not report back.
  const [sentTo, setSentTo] = useState<SendTo | null>(null);
  // Stop asks for a second press within STOP_CONFIRM_MS.
  const [stopArmed, setStopArmed] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), STOP_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed]);
  useEffect(() => {
    setStopArmed(false);
  }, [runAgentId]);

  /** Runs once in `way`; the default way is never changed here ("Change the default…" opens the settings). */
  function runOnceIn(way: RunWay) {
    setMenuOpen(false);
    void onRunPress(way);
  }

  /** Send to ChatGPT or Claude, where the card settings say (a hand-off: it does not report back). */
  function sendTo(to: SendTo) {
    void run(async () => {
      const result =
        to === "chatgpt"
          ? await startInChatGpt(title, text, gptTarget, (prompt) => stash({ prompt }))
          : claudeTarget === "copy-only"
            ? await copyForClaude(title, text)
            : await startInClaudeDesktop(title, text, (prompt) => stash({ prompt, target: "claude" }));
      if (result.ok) setSentTo(to);
      return result;
    });
  }

  /**
   * Stop: the run is archived, the stop the plugin already uses for a run in a refused mode. It works
   * for every browser (the Server browser's containers go with it); its history stays in Paseo.
   */
  async function stopRun() {
    if (!runAgentId || stopping) return;
    const refusal = stopRefusal({ runId: runAgentId, sourceAgentId: agentId, runs: storedRuns ?? [] });
    if (refusal) {
      setStopArmed(false);
      toast.error(refusal);
      return;
    }
    if (!stopArmed) {
      setStopArmed(true);
      return;
    }
    setStopArmed(false);
    setStopping(true);
    const stopped = runAgentId;
    try {
      await stopRunAgent(paseo, { runId: stopped, sourceAgentId: agentId, runs: newestSettings().values?.runs ?? storedRuns ?? [] });
      setStoppedRun(stopped);
      setSentTo(null);
      // Recorded on the run, so the card shows it stopped after a reload and on other devices.
      // The card keeps showing it stopped in this session; if the mark is not saved, say so.
      const unsaved = (reason?: unknown) => {
        console.warn(`[browser-prompt] could not record the stop of run ${stopped} on the card${reason === undefined ? "" : ` (${reason instanceof Error ? reason.message : String(reason)})`}`);
        toast.show("Run stopped, but the card could not save that. After a reload it may show the run as still going.", { durationMs: 5000 });
      };
      saveWithRetries(newestSettings, (values) => ({ ...values, runs: markRunStopped(values.runs, stopped) }))
        .then((saved) => {
          if (!saved) unsaved();
        }, unsaved)
        .catch((error: unknown) => console.warn(`[browser-prompt] could not show the notice that the stop of run ${stopped} was not saved (${String(error)})`));
      toast.show("Run stopped. The agent is archived; its history stays in Paseo.", { durationMs: 3500 });
    } catch (error) {
      toast.error(`Could not stop the run: ${error instanceof Error ? error.message : String(error)}. Stop it in Paseo.`);
    } finally {
      setStopping(false);
    }
  }

  const runVisuals = shownState === "asking" ? { icon: "CircleAlert", color: theme.colors.statusWarning } : runVisual(runState, theme);
  const phase = cardPhase({ runState: runAgentId ? shownState : null, done });
  const shape = cardLayout({ phase, mobile, compact: layout.compact, expanded: stepsOpen });
  const runDisabled = busy || resolving || runBlocked;
  const blockedHint = runBlocked ? "A run of these steps is still going; its status shows below" : undefined;
  const openAgent = () => {
    if (!runAgentId || !openRunScreen(runAgentId, agentTitle(title, displayTitle), true)) toast.error("Cannot open the agent from here.");
  };
  const openSettingsScreen = () => {
    try {
      if (!openPluginSettings()) toast.error("Cannot open the settings from here.");
    } catch {
      toast.error("Cannot open the settings from here.");
    }
  };
  // A signed-in run's Watch is the owner's viewer (the same link as Take over); any other run's is its agent view.
  const watchesViewer = runBrowser === "signed-in";
  const statusLabel =
    shownState === "asking"
      ? "Waiting for the chat's answer"
      : stoppedRun === runAgentId && (runState === "unknown" || runState === "stopped")
        ? RUN_LABELS.stopped
        : RUN_LABELS[runState];
  const headIcon =
    phase === "needs-you"
      ? { name: "CircleAlert", color: theme.colors.statusWarning }
      : phase === "done"
        ? { name: "CircleCheck", color: theme.colors.statusSuccess }
        : { name: "Globe", color: theme.colors.foregroundMuted };
  const latestBeside = !layout.compact && thumbnailMode === "latest";
  const screenshots_ =
    runAgentId && showScreenshot ? (
      <>
        <ScreenshotStrip shots={screenshots} latestStep={screenshotStep} mode={thumbnailMode} theme={theme} onOpen={openAgent} />
        {screenshotsBlocked && !screenshot ? <Text style={styles.hint}>{SCREENSHOT_BLOCKED_HINT}</Text> : null}
      </>
    ) : null;

  if (view === "collapsed") {
    return <CollapsedDone title={displayTitle} theme={theme} compact={layout.compact} onShow={() => setExpanded(true)} touch={mobile} />;
  }

  return (
    <View style={[styles.card, phase === "done" ? styles.cardDone : null]}>
      <View style={styles.header}>
        <Icon name={headIcon.name} size={18} color={headIcon.color} />
        <Text style={styles.title} selectable numberOfLines={2}>
          {displayTitle}
        </Text>
        {layout.compact ? null : <Text style={styles.label}>Browser prompt</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Browser prompt settings"
          hitSlop={8}
          onPress={openSettingsScreen}
          style={styles.gear}
        >
          <Icon name="Settings" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {view === "repeat" ? (
        <View style={styles.runRow}>
          <Text style={styles.hint}>Also shown earlier in this chat</Text>
          {expanded && done ? (
            <>
              <Text style={styles.hint}>·</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Collapse ${displayTitle}`} hitSlop={8} onPress={() => setExpanded(false)}>
                <Text style={styles.link}>Hide</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
      {phase === "done" ? (
        // Done: a summary line, and the steps and Send buttons fold away until Show steps.
        <View style={{ gap: 2 }}>
          <View style={styles.statusRow}>
            <Text style={[styles.statusText, { color: theme.colors.statusSuccess }]}>{runState === "done" ? "Done" : "Marked done"}</Text>
            <Text style={styles.where} numberOfLines={1}>
              {runAgentId && runState === "done" ? `· ${RUN_WAY_TITLES[runBrowser]}` : "· by you"}
            </Text>
            {runAgentId ? (
              <Pressable accessibilityRole="link" accessibilityLabel={`Open the Paseo agent for ${displayTitle}`} hitSlop={8} onPress={openAgent}>
                <Text style={styles.link}>Open</Text>
              </Pressable>
            ) : null}
          </View>
          {runAgentId && runState === "done" ? (
            <Text style={styles.hint}>{totalSteps === 1 ? "1 step finished." : `${totalSteps} steps finished.`}</Text>
          ) : null}
        </View>
      ) : null}
      {shape.showSteps ? (
        <View style={styles.promptBox}>
          <Text selectable style={styles.prompt}>
            {text}
          </Text>
        </View>
      ) : null}
      {runAgentId && phase !== "new" && phase !== "done" ? (
        // The run's state area: status, step progress, time, then Watch and Stop above the screenshot,
        // so the buttons do not move when it loads. A run that ended shows the same lines over Run again.
        <View style={styles.runBlock}>
          <View style={styles.runMain}>
            {phase === "needs-you" ? null : (
              <View style={styles.statusRow} accessibilityRole="text">
                <Icon name={runVisuals.icon} size={14} color={runVisuals.color} />
                <Text style={[styles.statusText, runState === "failed" ? { color: runVisuals.color } : null]}>{statusLabel}</Text>
                <Text style={styles.where} numberOfLines={1}>
                  · {BROWSER_NAMES[runBrowser]}
                </Text>
                {watchesViewer || phase === "ended" ? (
                  <Pressable accessibilityRole="link" accessibilityLabel={`Open the Paseo agent for ${displayTitle}`} hitSlop={8} onPress={openAgent}>
                    <Text style={styles.link}>Open</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
            {phase === "needs-you" ? (
              <View style={styles.ask}>
                <View style={styles.askHead}>
                  <Icon name="CircleAlert" size={16} color={theme.colors.statusWarning} />
                  <Text style={styles.askHeadText}>{shownState === "asking" ? "Waiting for the chat's answer" : "The agent needs you"}</Text>
                  <Text style={styles.where} numberOfLines={1}>
                    · {BROWSER_NAMES[runBrowser]}
                  </Text>
                  {watchesViewer ? (
                    <Pressable accessibilityRole="link" accessibilityLabel={`Open the Paseo agent for ${displayTitle}`} hitSlop={8} onPress={openAgent}>
                      <Text style={styles.link}>Open</Text>
                    </Pressable>
                  ) : null}
                </View>
                {runBrowser === "signed-in" && (runState === "needs-input" || shownState === "asking") ? (
                  // The agent waits for the owner (a login, a 2FA code): Take over is the main action here,
                  // a full-width filled button at the top of the panel.
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Take over the signed-in browser for ${displayTitle}`}
                      accessibilityHint="Opens the signed-in browser on the Paseo server, where you can log in or enter a code in a new tab"
                      disabled={openingViewer}
                      accessibilityState={{ disabled: openingViewer }}
                      onPress={() => void takeOver()}
                      style={[styles.primary, { minHeight: styles.h + 4, alignSelf: "stretch", opacity: openingViewer ? 0.5 : 1 }]}
                    >
                      <Icon name="MousePointer2" size={16} color={theme.colors.accentForeground} />
                      <Text style={[styles.primaryText, { fontSize: 15 }]}>{openingViewer ? "Opening…" : "Take over the browser"}</Text>
                    </Pressable>
                    <Text style={styles.hint}>{SIGNED_IN_TAKEOVER_HELP}</Text>
                  </>
                ) : null}
                {runState === "needs-input" ? (
                  <OwnerPromptBox
                    prompts={owner.prompts}
                    verified={owner.verified}
                    theme={theme}
                    onAnswer={async (prompt, response) => {
                      try {
                        await owner.answer(prompt, response);
                      } catch (error) {
                        toast.error(`Could not send your answer: ${error instanceof Error ? error.message : String(error)}`);
                      }
                    }}
                    onOpen={openAgent}
                  />
                ) : null}
                {watchStop()}
              </View>
            ) : null}
            {showSteps ? (
              <StepProgressRow progress={stepProgress} total={totalSteps} state={shownState} theme={theme} compact={layout.compact} accentText={styles.tints.accentText} />
            ) : null}
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
            {phase === "running" ? watchStop() : null}
          </View>
          {latestBeside && screenshots_ ? <View style={styles.shotBeside}>{screenshots_}</View> : null}
        </View>
      ) : null}
      {runAgentId && phase === "done" && stepsOpen ? (
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
      {!latestBeside && phase !== "new" && (phase !== "done" || stepsOpen) ? screenshots_ : null}
      {latestBeside && phase === "done" && stepsOpen ? screenshots_ : null}
      {shape.showRun ? (
        <View style={styles.actions}>
          <SplitRun
            styles={styles}
            theme={theme}
            compact={layout.compact}
            primary={shape.runPrimary}
            label={shape.runLabel}
            way={RUN_WAY_TITLES[runWay]}
            a11y={`${shape.runLabel} ${displayTitle} with a Paseo agent ${RUN_WAY_A11Y[runWay]}`}
            hint={blockedHint}
            disabled={runDisabled}
            onRun={() => void onRunPress(runWay)}
            onMenu={() => setMenuOpen(true)}
          />
          {shape.showSendChatGpt && shape.sendOwnRow ? <Text style={styles.sendCaption}>Send to</Text> : null}
          {shape.showSendChatGpt ? (
            <SendButton
              styles={styles}
              compact={shape.sendOwnRow}
              name="ChatGPT"
              icon={OPENAI_ICON}
              color={OPENAI_COLOR}
              a11y={gptTarget === "app" ? `Start ${displayTitle} in the ChatGPT desktop app` : gptTarget === "web-agent" ? `Start ${displayTitle} in ChatGPT on the web` : `Copy ${displayTitle} for ChatGPT`}
              disabled={busy}
              onPress={() => sendTo("chatgpt")}
            />
          ) : null}
          {shape.showSendClaude ? (
            <SendButton
              styles={styles}
              compact={shape.sendOwnRow}
              name="Claude"
              icon={CLAUDE_ICON}
              color={CLAUDE_COLOR}
              a11y={claudeTarget === "claude-desktop" ? `Start ${displayTitle} in the Claude desktop app` : `Copy ${displayTitle} for Claude`}
              disabled={busy}
              onPress={() => sendTo("claude")}
            />
          ) : null}
        </View>
      ) : null}
      {sentTo && shape.showSendChatGpt && !done ? (
        <View style={styles.note} accessibilityLiveRegion="polite">
          <Icon name="Check" size={14} color={theme.colors.statusSuccess} />
          <Text style={styles.noteText}>{sentNote(sentTo)}</Text>
        </View>
      ) : null}
      {runError ? (
        <View style={styles.runRow}>
          <Icon name="CircleX" size={14} color={theme.colors.statusDanger} />
          <Text style={[styles.hint, { color: theme.colors.statusDanger, flexShrink: 1 }]}>{runError}</Text>
        </View>
      ) : null}
      {runAgentId && layout.compact && (phase === "running" || phase === "needs-you") ? <Text style={styles.hint}>{HINTS[runBrowser]}</Text> : null}
      <View style={styles.quiet}>
        {shape.showFoldToggle ? (
          <Btn
            kind="ghost"
            styles={styles}
            icon={stepsOpen ? "ChevronUp" : "ChevronDown"}
            iconColor={theme.colors.foregroundMuted}
            label={stepsOpen ? "Hide steps" : "Show steps"}
            a11y={stepsOpen ? `Hide the steps of ${displayTitle}` : `Show the steps of ${displayTitle}`}
            expanded={stepsOpen}
            onPress={() => setStepsOpen((open) => !open)}
          />
        ) : null}
        <Btn
          kind="ghost"
          styles={styles}
          icon="Copy"
          iconColor={theme.colors.foregroundMuted}
          label="Copy steps"
          a11y={`Copy ${displayTitle}`}
          disabled={busy}
          onPress={() => void run(() => copyPrompt(title, text))}
        />
        <Btn
          kind="ghost"
          styles={styles}
          icon={done ? "Undo2" : "Check"}
          iconColor={theme.colors.foregroundMuted}
          label={done ? "Not done" : "Mark done"}
          a11y={done ? `Mark ${displayTitle} not done` : `Mark ${displayTitle} done`}
          checked={done}
          onPress={() => void toggleDone()}
        />
      </View>
      <Modal
        title="Run once in…"
        icon={<Icon name="Play" size={18} color={theme.colors.foreground} />}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        <Modal.Content contentContainerStyle={{ padding: 8, gap: 0 }}>
          {runMenuItems(runWay, showChrome).map((item) => (
            <Pressable
              key={item.way}
              accessibilityRole="menuitem"
              accessibilityLabel={`Run ${displayTitle} once ${RUN_WAY_A11Y[item.way]}`}
              accessibilityHint={blockedHint ?? (item.isDefault ? "The default way" : "Runs once; the default stays")}
              accessibilityState={{ disabled: runDisabled }}
              disabled={runDisabled}
              onPress={() => runOnceIn(item.way)}
              style={({ pressed }) => [styles.menuItem, pressed ? { backgroundColor: theme.colors.surface2 } : null, runDisabled ? { opacity: 0.5 } : null]}
            >
              <View style={styles.menuIcon}>
                <Icon name={RUN_WAY_ICONS[item.way]} size={16} color={theme.colors.foregroundMuted} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <Text style={styles.menuTitle}>{item.title}</Text>
                <Text style={styles.menuDetail}>{item.detail}</Text>
              </View>
              {item.isDefault ? (
                <View style={styles.tag}>
                  <Text style={styles.tagText}>Default</Text>
                </View>
              ) : null}
            </Pressable>
          ))}
          <View style={styles.separator} />
          <Pressable
            accessibilityRole="menuitem"
            accessibilityLabel="Change the default way to run"
            accessibilityHint="Opens the Browser prompts settings"
            onPress={() => {
              setMenuOpen(false);
              openSettingsScreen();
            }}
            style={({ pressed }) => [styles.menuItem, { minHeight: layout.compact || mobile ? 48 : 40 }, pressed ? { backgroundColor: theme.colors.surface2 } : null]}
          >
            <View style={[styles.menuIcon, { backgroundColor: "transparent" }]}>
              <Icon name="Settings" size={16} color={theme.colors.foregroundMuted} />
            </View>
            <Text style={[styles.ghostText, { flex: 1 }]}>Change the default…</Text>
          </Pressable>
        </Modal.Content>
      </Modal>
      <Modal
        title="Run with Paseo agent"
        icon={<Icon name="Bot" size={18} color={theme.colors.foreground} />}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      >
        <Modal.Content>
          <Text style={styles.modalText}>
            {pendingBrowser === "server"
              ? "Start a Paseo agent to do these steps in a browser on the Paseo server? It is not signed in to your accounts."
              : pendingBrowser === "signed-in"
                ? "Start a Paseo agent to do these steps in your signed-in browser on the Paseo server? It works with the sites you logged in to there."
                : "Start a Paseo agent to do these steps in your browser?"}
          </Text>
          {active ? <Text style={[styles.hint, { color: theme.colors.statusWarning }]}>A run of these steps is still going. This starts a second one.</Text> : null}
          {launchError ? (
            <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>{launchError}</Text>
          ) : pendingLaunch && "config" in pendingLaunch ? (
            <Text style={styles.hint}>{describeLaunch(pendingLaunch.config, pendingLaunch.browser)}</Text>
          ) : null}
          {layout.compact || pendingBrowser === "server" || pendingBrowser === "signed-in" ? <Text style={styles.hint}>{HINTS[pendingBrowser]}</Text> : null}
          <View style={styles.modalActions}>
            <Btn kind="secondary" styles={styles} label="Cancel" a11y="Cancel" onPress={() => setConfirmOpen(false)} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start the Paseo agent"
              disabled={!!launchError}
              onPress={() => void launchAgent(pendingLaunch)}
              style={[styles.primary, launchError ? { opacity: 0.5 } : null]}
            >
              <Icon name="Bot" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.primaryText}>Start agent</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );

  /** Watch and Stop for a run that is going (Stop asks for a second press). */
  function watchStop() {
    return (
      <View style={[styles.actions, { marginTop: 4 }]}>
        <Btn
          kind="secondary"
          styles={styles}
          icon={watchesViewer ? "Monitor" : "Eye"}
          iconColor={theme.colors.foreground}
          label={watchesViewer && openingViewer ? "Opening…" : "Watch"}
          a11y={watchesViewer ? `Watch or take over the signed-in browser for ${displayTitle}` : `Open the Paseo agent for ${displayTitle}`}
          hint={watchesViewer ? "Opens the signed-in browser on the Paseo server, where you can watch, log in or enter a code" : undefined}
          disabled={watchesViewer && openingViewer}
          grow={layout.compact ? 2 : undefined}
          onPress={() => (watchesViewer ? void takeOver() : openAgent())}
        />
        <Btn
          kind="danger"
          styles={styles}
          icon="Square"
          iconColor={theme.colors.statusDanger}
          label={stopping ? "Stopping…" : stopArmed ? "Press again to stop" : "Stop"}
          a11y={stopArmed ? `Confirm: stop the run of ${displayTitle}` : `Stop the run of ${displayTitle}`}
          hint="Archives the Paseo agent; its history stays in Paseo"
          disabled={stopping}
          grow={layout.compact ? 1 : undefined}
          onPress={() => void stopRun()}
        />
      </View>
    );
  }
}

const RUN_WAY_ICONS: Record<RunWay, string> = {
  "signed-in": "KeyRound",
  server: "Server",
  paseo: "AppWindow",
  chrome: "Globe",
};

/** One button of the card: filled (primary), bordered (secondary, danger) or quiet (ghost). */
function Btn({
  kind,
  styles,
  label,
  a11y,
  hint,
  icon,
  iconColor,
  disabled = false,
  checked,
  expanded,
  grow,
  onPress,
}: {
  kind: "primary" | "secondary" | "danger" | "ghost";
  styles: CardStyles;
  label: string;
  a11y: string;
  hint?: string;
  icon?: string;
  iconColor?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  grow?: number;
  onPress: () => void;
}) {
  const box = kind === "primary" ? styles.primary : kind === "ghost" ? styles.ghost : styles.secondary;
  const textStyle = kind === "primary" ? styles.primaryText : kind === "danger" ? styles.dangerText : kind === "ghost" ? styles.ghostText : styles.secondaryText;
  const state: PressableProps["accessibilityState"] = { disabled, ...(checked === undefined ? null : { checked }), ...(expanded === undefined ? null : { expanded }) };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={hint}
      accessibilityState={state}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }): StyleProp<ViewStyle> => [box, grow ? { flexGrow: grow, flexBasis: 0 } : null, pressed ? { opacity: 0.82 } : null, disabled ? { opacity: 0.5 } : null]}
    >
      {icon ? <Icon name={icon} size={15} color={iconColor} /> : null}
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Run as a split button: the main part runs the default way and names it, the chevron opens "Run
 * once in…". The divider is the chevron's left border; the chevron is as wide as the button is high.
 */
function SplitRun({
  styles,
  theme,
  compact,
  primary,
  label,
  way,
  a11y,
  hint,
  disabled,
  onRun,
  onMenu,
}: {
  styles: CardStyles;
  theme: Theme;
  compact: boolean;
  primary: boolean;
  label: string;
  way: string;
  a11y: string;
  hint?: string;
  disabled: boolean;
  onRun: () => void;
  onMenu: () => void;
}) {
  const box = primary ? styles.primary : styles.secondary;
  const fg = primary ? theme.colors.accentForeground : theme.colors.foreground;
  const sub = primary ? theme.colors.accentForeground : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        flexDirection: "row",
        borderRadius: 8,
        overflow: "hidden",
        minHeight: styles.h,
        ...(compact ? { flexBasis: "100%", flexGrow: 1 } : { minWidth: 236 }),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityHint={hint}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onRun}
        style={({ pressed }) => [
          box,
          { flex: 1, justifyContent: "flex-start", gap: 10, paddingLeft: 12, paddingRight: 14, borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRightWidth: 0 },
          pressed ? { opacity: 0.82 } : null,
        ]}
      >
        <Icon name="Play" size={16} color={fg} />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text style={[primary ? styles.primaryText : styles.secondaryText, { fontWeight: "700" }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={{ color: sub, fontSize: 12, opacity: primary ? 0.9 : 1 }} numberOfLines={1}>
            {way}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Run once in another browser"
        accessibilityHint="Opens Run once in…; the default stays"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onMenu}
        style={({ pressed }) => [
          box,
          {
            width: styles.h,
            paddingHorizontal: 0,
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeftWidth: 1,
            borderLeftColor: primary ? mixColor(theme.colors.accentForeground, theme.colors.accent, 0.32) : theme.colors.border,
          },
          pressed ? { opacity: 0.82 } : null,
        ]}
      >
        <Icon name="ChevronDown" size={16} color={fg} />
      </Pressable>
    </View>
  );
}

/** Send to ChatGPT or Claude: secondary, with the brand mark. On a phone only the name shows. */
function SendButton({
  styles,
  compact,
  name,
  icon,
  color,
  a11y,
  disabled,
  onPress,
}: {
  styles: CardStyles;
  compact: boolean;
  name: string;
  icon: { svg: string };
  color: string;
  a11y: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondary,
        compact ? { flexGrow: 1, flexShrink: 1, flexBasis: 96, paddingHorizontal: 10 } : null,
        pressed ? { opacity: 0.82 } : null,
        disabled ? { opacity: 0.5 } : null,
      ]}
    >
      <Icon icon={icon} size={16} color={color} />
      <Text style={styles.secondaryText} numberOfLines={1}>
        {compact ? name : `Send to ${name}`}
      </Text>
    </Pressable>
  );
}

/** A later copy of a block that is done: one line, and Show expands the full card right here. */
function CollapsedDone({ title, theme, compact, onShow, touch }: { title: string; theme: Theme; compact: boolean; onShow: () => void; touch: boolean }) {
  const tints = cardTints(theme.colors);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: compact ? "stretch" : "flex-start",
        maxWidth: "100%",
        gap: 8,
        minHeight: compact || touch ? 46 : 36,
        paddingLeft: 12,
        paddingRight: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tints.successLine,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="CircleCheck" size={16} color={theme.colors.statusSuccess} />
      <Text style={{ color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" }}>Already done</Text>
      <Text numberOfLines={1} style={{ flex: compact ? 1 : undefined, flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show ${title}`}
        accessibilityHint="Shows the card here"
        hitSlop={8}
        onPress={onShow}
        style={{ alignSelf: "stretch", justifyContent: "center", paddingHorizontal: 12 }}
      >
        <Text style={{ color: tints.accentText, fontSize: 13, fontWeight: "600" }}>Show</Text>
      </Pressable>
    </View>
  );
}
