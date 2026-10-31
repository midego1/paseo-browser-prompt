import { execFile, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { stateDir } from "./state-dir";
import type { updateSettings } from "../shared/update";
import {
  createUpdater,
  DEFAULT_UPDATE_STATE,
  LOCK_STALE_MS,
  LS_REMOTE_TIMEOUT_MS,
  parseInstallInfo,
  PLUGIN_ID,
  type UpdateState,
} from "../shared/updater";

export { stateDir };

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GIT_NO_LAZY_FETCH: "1" };

/** Git may only talk HTTPS for self-update, whatever the user's Git config allows. */
const GIT_HTTPS_ONLY = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"];

class ExitError extends Error {
  readonly code: number | string | undefined;
  constructor(message: string, code: number | string | undefined) {
    super(message);
    this.code = code;
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...GIT_ENV },
      },
      (error, stdout) => {
        if (error) {
          const timedOut = (error as { killed?: boolean }).killed;
          reject(
            new ExitError(
              timedOut ? `${command} timed out after ${timeoutMs / 1000}s` : `${command} exited with ${error.code ?? "an error"}`,
              error.code ?? undefined,
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

const gitBinary = () => (existsSync("/usr/bin/git") ? "/usr/bin/git" : "git");

/**
 * Commit-only (no trees or blobs) bare mirror of the install's remote under the state directory,
 * used to check that an update is a fast-forward. Re-created when the remote changes.
 */
export async function isFastForward(remote: string, trackedRef: string, installed: string, latest: string): Promise<boolean> {
  if (![installed, latest].every((sha) => /^[0-9a-f]{40}$/.test(sha))) throw new Error("invalid revision");
  if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(trackedRef)) throw new Error("invalid branch");
  const git = gitBinary();
  const dir = join(stateDir(), "history.git");
  let current = "";
  try {
    current = (await run(git, ["-C", dir, "config", "--get", "remote.origin.url"], 5_000)).trim();
  } catch {
    // no mirror yet
  }
  if (current !== remote) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(stateDir(), { recursive: true });
    await run(git, [...GIT_HTTPS_ONLY, "clone", "--quiet", "--bare", "--filter=tree:0", "--", remote, dir], 60_000);
  }
  await run(git, [...GIT_HTTPS_ONLY, "-C", dir, "fetch", "--quiet", "--no-tags", "origin", `+${trackedRef}:${trackedRef}`], 60_000);
  try {
    await run(git, ["-C", dir, "merge-base", "--is-ancestor", installed, latest], 10_000);
    return true;
  } catch (error) {
    // 1: not an ancestor; 128: the installed commit is not in the branch's history at all.
    if (error instanceof ExitError && (error.code === 1 || error.code === 128)) return false;
    throw error;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The plugin subprocess may not inherit the login PATH, so look in the usual install places too. */
export async function findPaseoBinary(): Promise<string> {
  const candidates = [
    process.env.PASEO_BIN,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "paseo")),
    join(homedir(), ".npm-global", "bin", "paseo"),
    join(homedir(), ".local", "bin", "paseo"),
    "/usr/local/bin/paseo",
    "/opt/homebrew/bin/paseo",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  throw new Error("paseo CLI not found");
}

const lockPath = () => join(stateDir(), "update.lock");

async function acquireLock(): Promise<boolean> {
  await mkdir(stateDir(), { recursive: true });
  const path = lockPath();
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false;
    await rm(path, { force: true }); // stale: the updater died without cleaning up
  } catch {
    // no lock
  }
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `paseo plugin update <id> --ref <commit> --yes` in its own session (setsid via
 * `detached`), with output in update.log, and lets it outlive this subprocess: the update reloads
 * the plugin, which stops this process. The shell wrapper removes the lock when the CLI exits.
 * Arguments go in as positional parameters, never interpolated into the script.
 */
async function spawnUpdate(revision: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("invalid revision");
  const paseo = await findPaseoBinary();
  await mkdir(stateDir(), { recursive: true });
  const log = await open(join(stateDir(), "update.log"), "a");
  try {
    await log.write(`\n[${new Date().toISOString()}] paseo plugin update ${PLUGIN_ID} --ref ${revision} --yes\n`);
    const script = '"$1" plugin update "$2" --ref "$3" --yes; status=$?; rm -f "$4"; echo "exit $status"; exit $status';
    const child = spawn("/bin/sh", ["-c", script, "browser-prompt-updater", paseo, PLUGIN_ID, revision, lockPath()], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, ...GIT_ENV },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

const statePath = () => join(stateDir(), "state.json");

type CheckState = Omit<UpdateState, "autoUpdate" | "trackRefOverride">;

export async function readCheckState(): Promise<CheckState> {
  const { autoUpdate: _a, trackRefOverride: _t, ...defaults } = DEFAULT_UPDATE_STATE;
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<CheckState>;
    return {
      lastCheckAt: typeof parsed.lastCheckAt === "number" ? parsed.lastCheckAt : 0,
      lastResult: typeof parsed.lastResult === "string" ? parsed.lastResult : "",
      installedRevision: typeof parsed.installedRevision === "string" ? parsed.installedRevision : "",
      latestRevision: typeof parsed.latestRevision === "string" ? parsed.latestRevision : "",
      trackedRef: typeof parsed.trackedRef === "string" ? parsed.trackedRef : "",
    };
  } catch {
    return defaults;
  }
}

async function writeCheckState(patch: Partial<UpdateState>): Promise<void> {
  const { autoUpdate: _a, trackRefOverride: _t, ...rest } = patch;
  const next = { ...(await readCheckState()), ...rest };
  await mkdir(stateDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, statePath());
}

export function createServerUpdater(settings: PluginSettings<(typeof updateSettings)["schema"]>) {
  async function loadState(): Promise<UpdateState> {
    const current = await settings.read();
    const prefs = current.status === "ready" ? current.values : DEFAULT_UPDATE_STATE;
    return {
      ...(await readCheckState()),
      autoUpdate: prefs.autoUpdate,
      trackRefOverride: prefs.trackRefOverride,
    };
  }
  return createUpdater({
    now: () => Date.now(),
    async listInstall() {
      const paseo = await findPaseoBinary();
      const out = await run(paseo, ["plugin", "ls", "--json"], 15_000);
      return parseInstallInfo(JSON.parse(out));
    },
    lsRemote: async (remote) =>
      run(gitBinary(), [...GIT_HTTPS_ONLY, "ls-remote", "--symref", "--", remote, "HEAD", "refs/heads/*"], LS_REMOTE_TIMEOUT_MS),
    isFastForward,
    acquireLock,
    releaseLock: async () => {
      await rm(lockPath(), { force: true });
    },
    spawnUpdate,
    loadState,
    saveState: writeCheckState,
    log: (message) => console.log(`[browser-prompt] update: ${message}`),
  });
}

/** Check state for the settings screen, with the live installed revision when it can be read. */
export async function currentUpdateStatus(): Promise<CheckState> {
  const state = await readCheckState();
  try {
    const paseo = await findPaseoBinary();
    const install = parseInstallInfo(JSON.parse(await run(paseo, ["plugin", "ls", "--json"], 15_000)));
    if (install.kind === "local") return { ...state, installedRevision: "", lastResult: state.lastResult || "local" };
    if (install.revision && install.revision !== state.installedRevision) {
      const updated = state.lastResult === "updating" && install.revision === state.latestRevision;
      return { ...state, installedRevision: install.revision, lastResult: updated ? "updated" : state.lastResult };
    }
  } catch {
    // keep the stored state
  }
  return state;
}
