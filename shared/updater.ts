// Self-update core: decides when to check, which ref the install follows, and whether to update.
// Pure and dependency-free (the daemon-side effects are injected), so the unit tests can load it
// directly with `node --experimental-strip-types`.

export const PLUGIN_ID = "browser-prompt";
/** At most one remote check per 30 minutes unless forced ("Check now"). */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const LS_REMOTE_TIMEOUT_MS = 10_000;
/** An update lock older than this is treated as stale (the updater died). */
export const LOCK_STALE_MS = 10 * 60 * 1000;

export type InstallKind = "git" | "local" | "other";

export interface InstallInfo {
  kind: InstallKind;
  /** Git remote URL (git installs only). */
  remote?: string;
  /** Installed commit (git installs only). */
  revision?: string;
}

/** Reads this plugin's entry from `paseo plugin ls --json`. */
export function parseInstallInfo(lsJson: unknown, pluginId = PLUGIN_ID): InstallInfo {
  const list = Array.isArray(lsJson)
    ? lsJson
    : lsJson && typeof lsJson === "object" && Array.isArray((lsJson as { plugins?: unknown }).plugins)
      ? (lsJson as { plugins: unknown[] }).plugins
      : [];
  const entry = list.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === pluginId) as
    | Record<string, unknown>
    | undefined;
  if (!entry) return { kind: "other" };
  const installation = (entry.installation ?? {}) as {
    identity?: { kind?: unknown; remote?: unknown };
    currentRevision?: unknown;
  };
  const kind = installation.identity?.kind ?? entry.source;
  if (kind === "git") {
    const remote = installation.identity?.remote ?? entry.remote;
    const revision = installation.currentRevision ?? entry.commit;
    if (typeof remote === "string" && typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision)) {
      return { kind: "git", remote, revision };
    }
    return { kind: "other" };
  }
  // npm and registry packages update through their own channels; everything else is a directory.
  if (kind === "npm" || kind === "registry") return { kind: "other" };
  return { kind: "local" };
}

export interface RemoteRefs {
  /** Ref the remote HEAD points to, e.g. refs/heads/main. */
  defaultBranch: string | null;
  /** refs/heads/<name> -> commit. */
  heads: Map<string, string>;
}

/** Parses `git ls-remote --symref <url> HEAD 'refs/heads/*'`. */
export function parseLsRemote(output: string): RemoteRefs {
  let defaultBranch: string | null = null;
  const heads = new Map<string, string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const symref = /^ref:\s+(\S+)\s+HEAD$/.exec(line);
    if (symref) {
      defaultBranch = symref[1]!;
      continue;
    }
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref && /^[0-9a-f]{40}$/.test(sha) && ref.startsWith("refs/heads/")) heads.set(ref, sha);
  }
  return { defaultBranch, heads };
}

export function normalizeRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("refs/") ? trimmed : `refs/heads/${trimmed}`;
}

/**
 * The branch this install follows. Paseo records only the installed commit, not the ref the
 * install or the last `paseo plugin update --ref` used, so it is inferred:
 * 1. an explicit override from settings;
 * 2. a branch whose tip is the installed commit (the previously tracked one first, then the
 *    remote's default branch, then the first by name);
 * 3. the previously tracked branch if it still exists (it moved on since the install);
 * 4. the remote's default branch.
 */
export function inferTrackedRef(
  refs: RemoteRefs,
  installedRevision: string,
  previous: string | null,
  override = "",
): string | null {
  const forced = normalizeRef(override);
  if (forced) return forced;
  const atInstalled = [...refs.heads.entries()].filter(([, sha]) => sha === installedRevision).map(([ref]) => ref);
  if (atInstalled.length > 0) {
    if (previous && atInstalled.includes(previous)) return previous;
    if (refs.defaultBranch && atInstalled.includes(refs.defaultBranch)) return refs.defaultBranch;
    return [...atInstalled].sort()[0]!;
  }
  if (previous && refs.heads.has(previous)) return previous;
  return refs.defaultBranch;
}

/** Self-update fetches only over HTTPS: no ssh, git://, http:// or local-path remotes. */
export function isHttpsRemote(remote: string): boolean {
  return /^https:\/\/[^\s/]+\/\S+$/i.test(remote.trim());
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function branchName(ref: string | null | undefined): string {
  return ref ? ref.replace(/^refs\/heads\//, "") : "";
}

/** Removes credentials from URLs and caps length, for logs and the settings screen. */
export function sanitizeError(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function isThrottled(lastCheckAt: number, now: number, force: boolean): boolean {
  return !force && lastCheckAt > 0 && now - lastCheckAt < CHECK_INTERVAL_MS;
}

export interface UpdateState {
  /** The owner enabled auto-update (after being told which repository supplies the updates). */
  autoUpdate: boolean;
  /** The Git remote the owner consented to; consent counts only while the install uses this remote. */
  consentRemote: string;
  trackRefOverride: string;
  lastCheckAt: number;
  /** "up-to-date" | "updating" | "update-available" | "not-fast-forward" | "local" | "failed: ..." */
  lastResult: string;
  installedRevision: string;
  latestRevision: string;
  trackedRef: string;
}

export const DEFAULT_UPDATE_STATE: UpdateState = {
  autoUpdate: false,
  consentRemote: "",
  trackRefOverride: "",
  lastCheckAt: 0,
  lastResult: "",
  installedRevision: "",
  latestRevision: "",
  trackedRef: "",
};

export type CheckStatus =
  /** Automatic check skipped: auto-update is not enabled for the install's remote. No network. */
  | "not-consented"
  /** "Update now" refused: the remote or the newest commit is not the one the owner was shown. */
  | "changed"
  | "throttled"
  | "local"
  | "unsupported"
  | "up-to-date"
  | "update-available"
  | "not-fast-forward"
  | "updating"
  | "busy"
  | "failed";

export interface CheckResult {
  status: CheckStatus;
  /** True when this call started the detached updater. */
  applied: boolean;
  message: string;
  installedRevision: string;
  latestRevision: string;
  trackedRef: string;
  lastCheckAt: number;
}

export interface UpdaterDeps {
  now(): number;
  listInstall(): Promise<InstallInfo>;
  /** Raw `git ls-remote --symref <remote> HEAD refs/heads/*` output; rejects on timeout. */
  lsRemote(remote: string): Promise<string>;
  /**
   * True when `latest` is a descendant of `installed` on `trackedRef` of `remote` (a fast-forward).
   * Rejects when the history cannot be fetched.
   */
  isFastForward(remote: string, trackedRef: string, installed: string, latest: string): Promise<boolean>;
  /** Takes the cross-process update lock; false when another update holds it. */
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  /** Starts the detached `paseo plugin update` for this commit; the child releases the lock. */
  spawnUpdate(revision: string): Promise<void>;
  loadState(): Promise<UpdateState>;
  saveState(patch: Partial<UpdateState>): Promise<void>;
  log(message: string): void;
}

/**
 * Auto-update counts only when the owner enabled it for exactly this remote. A changed install
 * remote voids it.
 */
export function hasConsent(state: Pick<UpdateState, "autoUpdate" | "consentRemote">, remote: string | undefined): boolean {
  return state.autoUpdate === true && !!remote && state.consentRemote === remote;
}

/** What the owner was shown when they pressed "Update now": install only this. */
export interface ManualUpdate {
  remote: string;
  revision: string;
}

export interface CheckOptions {
  /** "Check now": skip the 30-minute limit. A check reads the remote but installs only with consent. */
  force?: boolean;
  /** "Update now": install this commit from this remote, if it is still the newest fast-forward. */
  install?: ManualUpdate;
}

/**
 * One updater per plugin process. Concurrent checks share the in-flight one.
 *
 * Nothing is downloaded or installed without the owner: an automatic check (a card shown or used)
 * returns at once, without reading the install or the network, unless auto-update is enabled, and
 * contacts the remote only when that consent was given for the install's current remote. "Check
 * now" and "Update now" are the owner's own clicks; "Update now" installs only the commit and remote
 * the owner was shown.
 */
export function createUpdater(deps: UpdaterDeps) {
  let inFlight: Promise<CheckResult> | null = null;
  let memoryLastCheckAt = 0;
  let updating = false;

  async function run(options: CheckOptions): Promise<CheckResult> {
    const manual = options.install ?? null;
    const force = options.force === true || manual !== null;
    // Unreadable state reads as "no consent".
    const state = await deps.loadState().catch(() => DEFAULT_UPDATE_STATE);
    const now = deps.now();
    const lastCheckAt = Math.max(memoryLastCheckAt, state.lastCheckAt);
    const base = {
      installedRevision: state.installedRevision,
      latestRevision: state.latestRevision,
      trackedRef: state.trackedRef,
      lastCheckAt,
    };
    if (!force && state.autoUpdate !== true) {
      return { ...base, status: "not-consented", applied: false, message: "Auto-update is off." };
    }
    if (updating) return { ...base, status: "busy", applied: false, message: "An update is already running." };
    if (isThrottled(lastCheckAt, now, force)) {
      return { ...base, status: "throttled", applied: false, message: "Checked recently." };
    }
    memoryLastCheckAt = now;

    let install: InstallInfo;
    try {
      install = await deps.listInstall();
    } catch (error) {
      return fail(base, now, `could not read the install: ${errorText(error)}`);
    }
    if (install.kind === "local") {
      const message = "Local install, no auto-update.";
      await deps.saveState({ lastCheckAt: now, lastResult: "local", installedRevision: "", latestRevision: "", trackedRef: "" });
      return { ...base, status: "local", applied: false, message, installedRevision: "", lastCheckAt: now };
    }
    if (install.kind !== "git" || !install.remote || !install.revision) {
      await deps.saveState({ lastCheckAt: now, lastResult: "unsupported" });
      return { ...base, status: "unsupported", applied: false, message: "Only Git installs update themselves.", lastCheckAt: now };
    }

    if (!isHttpsRemote(install.remote)) {
      await deps.saveState({ lastCheckAt: now, lastResult: "unsupported" });
      return {
        ...base,
        status: "unsupported",
        applied: false,
        message: "Only installs from an https:// Git remote update themselves.",
        lastCheckAt: now,
      };
    }

    const consent = hasConsent(state, install.remote);
    if (!force && !consent) {
      // Enabled for another remote (the install moved): ask again, and do not contact either one.
      return {
        ...base,
        installedRevision: install.revision,
        status: "not-consented",
        applied: false,
        message: "Auto-update was enabled for another repository; enable it again for this one.",
      };
    }
    if (manual && manual.remote !== install.remote) {
      return { ...base, installedRevision: install.revision, status: "changed", applied: false, message: "The plugin now installs from another repository; check again." };
    }

    let refs: RemoteRefs;
    try {
      refs = parseLsRemote(await deps.lsRemote(install.remote));
    } catch (error) {
      return fail({ ...base, installedRevision: install.revision }, now, `git ls-remote failed: ${errorText(error)}`);
    }
    // The remembered branch only describes this install if the updater saw it (as installed or as the
    // commit it updated to). After a manual `paseo plugin update --ref <x>` it is stale.
    const knownInstall = install.revision === state.installedRevision || install.revision === state.latestRevision;
    const previous = knownInstall && state.trackedRef ? state.trackedRef : null;
    const trackedRef = inferTrackedRef(refs, install.revision, previous, state.trackRefOverride);
    const latest = trackedRef ? refs.heads.get(trackedRef) : undefined;
    if (!trackedRef || !latest) {
      return fail({ ...base, installedRevision: install.revision }, now, `branch ${branchName(trackedRef) || "?"} not found on the remote`);
    }
    const result = {
      installedRevision: install.revision,
      latestRevision: latest,
      trackedRef,
      lastCheckAt: now,
    };
    if (latest === install.revision) {
      await deps.saveState({ ...result, lastResult: "up-to-date" });
      return { ...result, status: "up-to-date", applied: false, message: `Up to date on ${branchName(trackedRef)}.` };
    }
    let fastForward: boolean;
    try {
      fastForward = await deps.isFastForward(install.remote, trackedRef, install.revision, latest);
    } catch (error) {
      return fail(result, now, `could not read the history of ${branchName(trackedRef)}: ${errorText(error)}`);
    }
    if (!fastForward) {
      // Rewritten history or another branch: never move the install sideways or backwards on its own.
      await deps.saveState({ ...result, lastResult: "not-fast-forward" });
      return {
        ...result,
        status: "not-fast-forward",
        applied: false,
        message: `${branchName(trackedRef)} is not a fast-forward of the installed commit; update manually.`,
      };
    }
    if (manual && manual.revision !== latest) {
      await deps.saveState({ ...result, lastResult: "update-available" });
      return { ...result, status: "changed", applied: false, message: `A newer commit (${shortSha(latest)}) appeared; check it and update again.` };
    }
    if (!manual && !consent) {
      await deps.saveState({ ...result, lastResult: "update-available" });
      return {
        ...result,
        status: "update-available",
        applied: false,
        message: `Update available on ${branchName(trackedRef)}: ${shortSha(latest)}.`,
      };
    }
    if (!(await deps.acquireLock())) {
      return { ...result, status: "busy", applied: false, message: "An update is already running." };
    }
    updating = true;
    let started = false;
    try {
      try {
        await deps.spawnUpdate(latest);
        started = true;
      } catch (error) {
        await deps.releaseLock().catch(() => undefined);
        return fail(result, now, `could not start the update: ${errorText(error)}`);
      }
      deps.log(`updating ${shortSha(install.revision)} -> ${shortSha(latest)} on ${branchName(trackedRef)}`);
      // The update is already running; a state-file failure must not turn this into an error.
      await deps.saveState({ ...result, lastResult: "updating" }).catch((error) => {
        deps.log(`could not record the update: ${sanitizeError(errorText(error))}`);
      });
      return {
        ...result,
        status: "updating",
        applied: true,
        message: `Updating to ${shortSha(latest)} on ${branchName(trackedRef)}.`,
      };
    } finally {
      // Only a started update keeps later checks busy (the plugin reloads when it finishes).
      if (!started) updating = false;
    }
  }

  async function fail(base: Omit<CheckResult, "status" | "applied" | "message">, now: number, reason: string): Promise<CheckResult> {
    const message = `last check failed: ${sanitizeError(reason)}`;
    deps.log(message);
    await deps.saveState({ lastCheckAt: now, lastResult: `failed: ${sanitizeError(reason)}` }).catch(() => undefined);
    return { ...base, lastCheckAt: now, status: "failed", applied: false, message };
  }

  return {
    check(options: CheckOptions = {}): Promise<CheckResult> {
      if (inFlight) return inFlight;
      inFlight = run(options).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Update settings from before version 2 (0.10.0) had auto-update on by default, without the owner
 * being told which repository supplies the updates. Whatever was stored, it starts off and asks.
 */
export function migrateUpdateSettings(values: unknown, fromVersion: number): unknown {
  const old = (values ?? {}) as { trackRefOverride?: unknown };
  if (fromVersion < 2) {
    return {
      autoUpdate: false,
      consentRemote: "",
      ...(typeof old.trackRefOverride === "string" ? { trackRefOverride: old.trackRefOverride } : {}),
    };
  }
  return values;
}
