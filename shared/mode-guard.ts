// Keeps a browser run in the permission mode the card asked for. Import-free apart from other pure
// shared modules, so tests can load it with `node --experimental-strip-types`.
import { defaultModeFor, runModeAllowed } from "./agent-prompt.ts";

/** The slice of an SDK agent handle the guard uses. `setMode` is used only if the SDK offers it. */
export interface ModeGuardAgent {
  refresh(): Promise<{ agent: { currentModeId?: string | null } } | null>;
  archive(): Promise<unknown>;
  setMode?: (modeId: string) => Promise<unknown>;
}

export type ModeCheck =
  | { ok: true; actualMode: string | null; corrected: boolean }
  | { ok: false; actualMode: string; stopped: boolean; message: string };

export interface ModeGuardOptions {
  /** Reads while the new agent has not reported a mode yet. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readMode(agent: ModeGuardAgent): Promise<string | null> {
  const mode = (await agent.refresh())?.agent.currentModeId;
  return typeof mode === "string" && mode.trim() ? mode.trim() : null;
}

/**
 * Checks the run's actual permission mode. Ask-first and classifier modes (Claude `default`, `plan`,
 * `auto`) are all fine, so drift between them is ignored. A refused mode (bypass, accept-edits, ...)
 * is set back when the SDK can (the 0.11 to 0.14 plugin SDK cannot), else the run is stopped by
 * archiving it. A mode that never becomes readable is reported as unverified, not as a violation.
 */
export async function enforceRunMode(
  agent: ModeGuardAgent,
  provider: string,
  options: ModeGuardOptions & { restoreMode?: string } = {},
): Promise<ModeCheck> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const sleep = options.sleep ?? defaultSleep;
  let actual: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    actual = await readMode(agent);
    if (actual) break;
    if (attempt < attempts - 1) await sleep(options.delayMs ?? 500);
  }
  if (!actual || runModeAllowed(provider, actual)) return { ok: true, actualMode: actual, corrected: false };

  const restore = options.restoreMode && runModeAllowed(provider, options.restoreMode) ? options.restoreMode : defaultModeFor(provider);
  if (typeof agent.setMode === "function" && restore) {
    try {
      await agent.setMode(restore);
      const after = await readMode(agent);
      if (after && runModeAllowed(provider, after)) return { ok: true, actualMode: after, corrected: true };
    } catch {
      // fall through to stopping the run
    }
  }
  try {
    await agent.archive();
    return {
      ok: false,
      actualMode: actual,
      stopped: true,
      message: `The Paseo agent switched to mode "${actual}", which browser runs may not use, so it was stopped (archived).`,
    };
  } catch {
    return {
      ok: false,
      actualMode: actual,
      stopped: false,
      message: `The Paseo agent switched to mode "${actual}", which browser runs may not use, and could not be stopped. Stop it in Paseo now.`,
    };
  }
}
