// Guards the card's timeline tail reads against landing on another run. Pure, so tests load it with
// `node --experimental-strip-types`.

export interface TailRead {
  /** False once cancelled or once the card follows another run (or rebuilt its tracker). */
  readonly current: boolean;
  cancel(): void;
  /** The read settled: it no longer needs cancelling. */
  done(): void;
}

/**
 * Hands out read guards bound to the owner (the run tracker) a read started for. A read whose owner
 * was replaced, or that `cancelAll` (an effect cleanup) cancelled, must drop its result.
 */
export function createTailReads<Owner>(owner: () => Owner) {
  const open = new Set<{ cancelled: boolean }>();
  return {
    begin(): TailRead {
      const startedFor = owner();
      const token = { cancelled: false };
      open.add(token);
      return {
        get current() {
          return !token.cancelled && owner() === startedFor;
        },
        cancel() {
          token.cancelled = true;
          open.delete(token);
        },
        done() {
          open.delete(token);
        },
      };
    },
    cancelAll(): void {
      for (const token of open) token.cancelled = true;
      open.clear();
    },
    pending: () => open.size,
  };
}
