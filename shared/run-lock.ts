// In-flight run lock, kept by the daemon for all of the owner's apps. Copies of a block share one run
// (see `sharedRunRecord` in shared/repeats.ts), but the run record reaches the other copies only
// after the start and the settings save (about a second). Without "Confirm before starting", two
// copies pressed in that window would both start a run; the lock lets only the first one start.
// Pure, so tests load it with `node --experimental-strip-types`.
import type { BlockFingerprint } from "./block-key.ts";

/** A start that never reports back (app closed, network gone) frees the lock after this. */
export const RUN_LOCK_TTL_MS = 60_000;
/** After a start the lock names the run until the run record has reached every copy. */
export const RUN_LOCK_HOLD_MS = 10_000;
/** Locks kept at most; expired ones go first, then the oldest. */
const MAX_LOCKS = 500;

/** One lock per chat and block content, as the shared run: the source agent and the full fingerprint. */
export function runLockKey(sourceAgentId: string, fingerprint: BlockFingerprint): string {
  return `${sourceAgentId}:${fingerprint.key}:${fingerprint.length}:${fingerprint.check}`;
}

export type AcquireResult =
  /** This copy may start the run; pass the token back when it started or failed. */
  | { ok: true; token: string }
  /** Another copy is starting the run (`agentId` null) or just started it (its agent id). */
  | { ok: false; agentId: string | null };

interface Lock {
  token: string;
  expiresAt: number;
  agentId: string | null;
}

export function createRunLocks(options: { now?: () => number; token?: () => string } = {}) {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const nextToken = options.token ?? (() => `${now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const locks = new Map<string, Lock>();

  function live(key: string): Lock | null {
    const lock = locks.get(key);
    if (!lock) return null;
    if (lock.expiresAt > now()) return lock;
    locks.delete(key);
    return null;
  }

  function prune(): void {
    const at = now();
    for (const [key, lock] of locks) if (lock.expiresAt <= at) locks.delete(key);
    // Maps keep insertion order: drop the oldest beyond the cap.
    for (const key of locks.keys()) {
      if (locks.size < MAX_LOCKS) break;
      locks.delete(key);
    }
  }

  return {
    acquire(key: string): AcquireResult {
      const held = live(key);
      if (held) return { ok: false, agentId: held.agentId };
      prune();
      const token = nextToken();
      locks.set(key, { token, expiresAt: now() + RUN_LOCK_TTL_MS, agentId: null });
      return { ok: true, token };
    },
    /** The run started: the lock names it for a short while, so a late copy shows it. */
    started(key: string, token: string, agentId: string): boolean {
      const held = live(key);
      if (!held || held.token !== token) return false;
      locks.set(key, { token, expiresAt: now() + RUN_LOCK_HOLD_MS, agentId });
      return true;
    },
    /** The start failed: another copy may start at once. */
    release(key: string, token: string): boolean {
      const held = live(key);
      if (!held || held.token !== token) return false;
      locks.delete(key);
      return true;
    },
    size(): number {
      return locks.size;
    },
  };
}

export type RunLocks = ReturnType<typeof createRunLocks>;
