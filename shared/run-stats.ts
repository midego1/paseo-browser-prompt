// Run time and tokens of a "Run with Paseo agent" run, for the small stats line on the card. Pure,
// so the derivation (start, end, live or not, clock skew) and the formats are tested without React.
//
// Sources, all from the daemon so the line survives a reload:
// - start: the run agent's createdAt (the card creates the agent when the run starts); the time is
//   since the run started, including any time it waited for the owner or the chat,
// - end of a run that has ended: the timestamp of its latest timeline entry. Without one (the read
//   failed or has not answered yet) the line shows the state without a time, never a guess,
// - tokens: the agent snapshot's lastUsage, which the daemon fills when a turn completes, so they
//   are the last turn's (for a one-turn run, the run's). The daemon keeps it in memory only, so a
//   run from before a daemon restart shows no tokens.

type RunStateLike = "starting" | "running" | "needs-input" | "asking" | "done" | "failed" | "stopped" | "unknown";

/** The fields of the daemon's AgentUsage the card reads; never the cost. */
export interface UsageLike {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/** Token counts as the provider reports them; null where it reports none. Never summed. */
export interface TokenCounts {
  input: number | null;
  cached: number | null;
  output: number | null;
}

export interface RunTiming {
  startMs: number;
  /** Whether the run has ended; a going run counts up to now. */
  ended: boolean;
  /** End of an ended run; null when its end is not known (then no time is shown). */
  endMs: number | null;
}

export interface RunStatsView {
  /** The run is working right now (starting or running): the card spins its icon. */
  spinning: boolean;
  /** The time still counts up, so the line re-renders once a second. */
  live: boolean;
  /** "Running · 2m 14s", "Took 3m 02s", or the bare state when an ended run's end is unknown. */
  timeText: string;
  timeLabel: string;
  /** "last turn: 36 in · 701k cached · 4.6k out", or null when the run reports no tokens. */
  tokenText: string | null;
  tokenLabel: string | null;
}

/** Counts above this are a provider's bug, not tokens; they read as missing. */
const MAX_TOKENS = 1e12;

const LIVE_STATES = new Set<RunStateLike>(["starting", "running", "needs-input"]);
const ENDED_STATES = new Set<RunStateLike>(["done", "failed", "stopped", "asking"]);

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS ? value : null;
}

/** "45s", "2m 04s", "1h 02m"; negative or invalid durations read as 0s. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** "936", "4.6k", "18.4k", "701k", "1.2M". */
export function formatTokens(n: number): string {
  const value = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (value < 1000) return String(value);
  const scaled = (amount: number, unit: string) => {
    const digits = amount < 100 ? 1 : 0;
    const text = amount.toFixed(digits);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}${unit}`;
  };
  if (value < 999_500) return scaled(value / 1000, "k");
  return scaled(value / 1_000_000, "M");
}

/**
 * Input, cached input and output tokens as reported, or null when the usage has no non-zero count.
 * They are never added up: Claude reports cached input apart from input, Codex-style providers as a
 * part of it, and the card cannot tell which.
 */
export function tokenCounts(usage: UsageLike | null | undefined): TokenCounts | null {
  if (!usage) return null;
  const counts = { input: count(usage.inputTokens), cached: count(usage.cachedInputTokens), output: count(usage.outputTokens) };
  if (counts.input === null && counts.output === null) return null;
  if (!counts.input && !counts.cached && !counts.output) return null;
  return counts;
}

/**
 * Start and end of the run from the agent's data. A going run (starting, running, waiting for the
 * owner) has no end yet; a run that ended stops at its latest timeline entry, or has no known end.
 * Null when the state is unknown or the start is missing.
 */
export function runTiming(input: {
  state: RunStateLike;
  createdAt: string | null | undefined;
  lastEntryAt?: string | null;
}): RunTiming | null {
  const startMs = parseTime(input.createdAt);
  if (startMs === null) return null;
  if (LIVE_STATES.has(input.state)) return { startMs, ended: false, endMs: null };
  if (!ENDED_STATES.has(input.state)) return null;
  const entry = parseTime(input.lastEntryAt);
  return { startMs, ended: true, endMs: entry !== null && entry >= startMs ? entry : null };
}

/**
 * The client clock's lead over the daemon's, from a daemon timestamp seen at `clientNowMs`. Each
 * observation is the skew plus the time the timestamp took to arrive, so the smallest one is the
 * best estimate; only timestamps that are fresh when seen (live stream events, an updatedAt that
 * just changed) should be passed. Null observations keep the current estimate.
 */
export function observeSkew(current: number | null, clientNowMs: number, daemonTimestamp: string | null | undefined): number | null {
  const daemonMs = parseTime(daemonTimestamp);
  if (daemonMs === null || !Number.isFinite(clientNowMs)) return current;
  const observed = clientNowMs - daemonMs;
  return current === null ? observed : Math.min(current, observed);
}

/**
 * The elapsed run time at `nowMs` (client clock): for a going run up to now, corrected by the
 * client's estimated lead `skewMs` and never below 0; for an ended run start to end, or null when
 * its end is unknown.
 */
export function elapsedMs(timing: RunTiming, nowMs: number, skewMs: number | null = null): number | null {
  if (timing.ended) return timing.endMs === null ? null : Math.max(0, timing.endMs - timing.startMs);
  return Math.max(0, nowMs - (skewMs ?? 0) - timing.startMs);
}

const LIVE_WORD: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  "needs-input": "Waiting for you",
};

const ENDED_WORD: Record<string, { timed: string; bare: string }> = {
  done: { timed: "Took", bare: "Done" },
  failed: { timed: "Failed after", bare: "Failed" },
  stopped: { timed: "Stopped after", bare: "Stopped" },
  // The run row above already says it waits for the chat's answer; its own turn has ended.
  asking: { timed: "Ran", bare: "Waiting for the chat" },
};

/**
 * "Running · 2m 14s", "Took 3m 02s" and "last turn: 36 in · 701k cached · 4.6k out". Null when
 * there is no timing (no run, unknown state, or no start time); tokens are null when the run
 * reports none.
 */
export function runStatsView(input: {
  state: RunStateLike;
  timing: RunTiming | null;
  nowMs: number;
  skewMs?: number | null;
  usage?: UsageLike | null;
}): RunStatsView | null {
  if (!input.timing || input.state === "unknown") return null;
  const elapsed = elapsedMs(input.timing, input.nowMs, input.skewMs ?? null);
  const duration = elapsed === null ? null : formatDuration(elapsed);
  let timeText: string;
  let timeLabel: string;
  if (!input.timing.ended) {
    const word = LIVE_WORD[input.state] ?? "Running";
    timeText = `${word} · ${duration}`;
    timeLabel = `${word}, ${duration} since the run started`;
  } else {
    const words = ENDED_WORD[input.state] ?? ENDED_WORD.done;
    timeText = duration === null ? words.bare : `${words.timed} ${duration}`;
    timeLabel = timeText;
  }
  const tokens = tokenCounts(input.usage);
  const parts: string[] = [];
  const labels: string[] = [];
  if (tokens) {
    if (tokens.input !== null) {
      parts.push(`${formatTokens(tokens.input)} in`);
      labels.push(`${tokens.input} input`);
    }
    if (tokens.cached) {
      parts.push(`${formatTokens(tokens.cached)} cached`);
      labels.push(`${tokens.cached} cached input`);
    }
    if (tokens.output !== null) {
      parts.push(`${formatTokens(tokens.output)} out`);
      labels.push(`${tokens.output} output`);
    }
  }
  return {
    spinning: input.state === "starting" || input.state === "running",
    live: !input.timing.ended,
    timeText,
    timeLabel,
    tokenText: parts.length ? `last turn: ${parts.join(" · ")}` : null,
    tokenLabel: labels.length ? `Last turn's tokens: ${labels.join(", ")}` : null,
  };
}
