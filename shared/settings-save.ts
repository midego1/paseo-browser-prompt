// Pure helpers for saving host settings from a card. No React or SDK imports, so tests can load it
// with `node --experimental-strip-types`.

/** A settings handle as the SDK's `useSettings` gives it, reduced to what a retried save needs. */
export interface RetrySettings<Values> {
  status: string;
  values?: Values;
  revision?: string;
  save(values: Values, revision: string): Promise<boolean>;
  reload(): Promise<void>;
}

/**
 * The newest settings any mounted card rendered. Every card reads the same host settings document,
 * so a retried save of a card that was unmounted meanwhile (its own handle no longer re-renders)
 * still finds the newest revision here while another card or the settings page is mounted.
 */
export function createSettingsMirror<Values>() {
  let latest: RetrySettings<Values> | null = null;
  return {
    /** Called on every render with the hook's current state. */
    publish(state: RetrySettings<Values>): void {
      latest = state;
    },
    /** The newest published state, else `fallback` (the caller's own handle). */
    latest(fallback: RetrySettings<Values>): RetrySettings<Values> {
      return latest ?? fallback;
    },
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Saves `update(values)` against the newest settings; a save that loses a revision race (or finds
 * the settings not ready) reloads and tries again, up to `attempts` times. True once a save stuck.
 */
export async function saveWithRetries<Values>(
  latest: () => RetrySettings<Values>,
  update: (values: Values) => Values,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? wait;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = latest();
    if (current.status === "ready" && current.values !== undefined && current.revision !== undefined) {
      if (await current.save(update(current.values), current.revision)) return true;
    }
    await current.reload();
    await sleep(100 * (attempt + 1));
  }
  return false;
}

/** The done list with this block's mark set or removed; the old `runKey` form is always removed. */
export function withDoneMark(done: readonly string[], doneMark: string, runKey: string, on: boolean, max: number): string[] {
  const without = done.filter((mark) => mark !== doneMark && mark !== runKey);
  return on ? [...without, doneMark].slice(-max) : without;
}
