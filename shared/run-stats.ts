// Run time and tokens of a "Run with Paseo agent" run, for the small stats line on the card. Pure,
// so the derivation (start, end, live or not) and the formats are tested without React.
//
// Sources, all from the daemon so the line survives a reload:
// - start: the run agent's createdAt (the card creates the agent when the run starts),
// - end of a run that has ended: the timestamp of its latest timeline entry, else its updatedAt
//   (which later changes such as archiving also move),
// - tokens: the agent snapshot's lastUsage, which the daemon fills when a turn completes (for a
//   one-turn run that is the run's total; after a follow-up turn it is that turn's). The daemon keeps
//   it in memory only, so a run from before a daemon restart shows no tokens.

type RunStateLike = "starting" | "running" | "needs-input" | "asking" | "done" | "failed" | "stopped" | "unknown";

/** The fields of the daemon's AgentUsage the card reads; never the cost. */
export interface UsageLike {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface TokenCounts {
  /** Input tokens including cached input. */
  input: number;
  cached: number;
  output: number;
}

export interface RunTiming {
  startMs: number;
  /** Null while the run is going: the elapsed time counts up to now. */
  endMs: number | null;
}

export interface RunStatsView {
  /** The run is working right now (starting or running): the card spins its icon. */
  spinning: boolean;
  /** The time still counts up, so the line re-renders once a second. */
  live: boolean;
  text: string;
  accessibilityLabel: string;
}

const LIVE_STATES = new Set<RunStateLike>(["starting", "running", "needs-input"]);
const ENDED_STATES = new Set<RunStateLike>(["done", "failed", "stopped", "asking"]);

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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

/** Input (with cached input) and output tokens, or null when the usage has no token counts yet. */
export function tokenCounts(usage: UsageLike | null | undefined): TokenCounts | null {
  if (!usage) return null;
  const input = count(usage.inputTokens);
  const cached = count(usage.cachedInputTokens);
  const output = count(usage.outputTokens);
  if (input === null && output === null) return null;
  const counts = { input: (input ?? 0) + (cached ?? 0), cached: cached ?? 0, output: output ?? 0 };
  return counts.input + counts.output > 0 ? counts : null;
}

/**
 * Start and end of the run from the agent's data. A going run (starting, running, waiting for the
 * owner) has no end yet; a run that ended stops at its latest timeline entry, else its updatedAt.
 * Null when the state is unknown or the start is missing.
 */
export function runTiming(input: {
  state: RunStateLike;
  createdAt: string | null | undefined;
  updatedAt: string | null | undefined;
  lastEntryAt?: string | null;
}): RunTiming | null {
  const startMs = parseTime(input.createdAt);
  if (startMs === null) return null;
  if (LIVE_STATES.has(input.state)) return { startMs, endMs: null };
  if (!ENDED_STATES.has(input.state)) return null;
  const entry = parseTime(input.lastEntryAt);
  const updated = parseTime(input.updatedAt);
  const end = entry !== null && entry >= startMs ? entry : updated;
  return { startMs, endMs: end !== null && end >= startMs ? end : startMs };
}

/** The elapsed run time at `nowMs`: up to now while going, start to end once it ended. */
export function elapsedMs(timing: RunTiming, nowMs: number): number {
  return Math.max(0, (timing.endMs ?? nowMs) - timing.startMs);
}

const STATE_WORD: Record<RunStateLike, string> = {
  starting: "Starting",
  running: "Running",
  "needs-input": "Waiting for you",
  // The run row above already says it waits for the chat's answer; its own turn has ended.
  asking: "Ran",
  done: "Took",
  failed: "Failed after",
  stopped: "Stopped after",
  unknown: "",
};

/**
 * "Running · 2m 14s · 701k in · 4.6k out", "Took 3m 02s · …". Null when there is no timing (no
 * run, unknown state, or no start time); tokens are left out when the run reports none.
 */
export function runStatsView(input: {
  state: RunStateLike;
  timing: RunTiming | null;
  nowMs: number;
  usage?: UsageLike | null;
}): RunStatsView | null {
  if (!input.timing || input.state === "unknown") return null;
  const live = input.timing.endMs === null;
  const duration = formatDuration(elapsedMs(input.timing, input.nowMs));
  const word = STATE_WORD[input.state];
  const time = live ? `${word} · ${duration}` : `${word} ${duration}`;
  const tokens = tokenCounts(input.usage);
  const tokenText = tokens ? `${formatTokens(tokens.input)} in · ${formatTokens(tokens.output)} out` : null;
  const tokenLabel = tokens
    ? `${tokens.input} input tokens${tokens.cached ? ` (${tokens.cached} cached)` : ""}, ${tokens.output} output tokens`
    : null;
  return {
    spinning: input.state === "starting" || input.state === "running",
    live,
    text: tokenText ? `${time} · ${tokenText}` : time,
    accessibilityLabel: `${live ? `${word}, ${duration} so far` : `${word} ${duration}`}${tokenLabel ? `, ${tokenLabel}` : ""}`,
  };
}
