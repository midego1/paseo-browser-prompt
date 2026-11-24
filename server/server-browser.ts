import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import {
  CONTAINER_AGENT_LABEL,
  CONTAINER_LABEL,
  CREATED_LABEL,
  createTicketStore,
  INSTANCE_LABEL,
  safeInstanceId,
  SECCOMP_PROFILE_SHA256,
  STARTING_WINDOW_MS,
  SWEEP_MIN_AGE_MS,
  hostAddressesToBlock,
  LAUNCHER_PID_LABEL,
  MAX_SERVER_BROWSER_RUNS,
  safeAgentId,
  SERVER_BROWSER_MCP_NAME,
  serverBrowserImageTag,
  serverBrowserMcpServer,
  serverBrowserPlan,
  sessionNames,
  SESSION_LABEL,
  SERVER_RUN_MARKER,
  serverRunRecorded,
  shouldAttachServerBrowser,
  shouldAttachSignedIn,
  type ServerBrowserState,
  type StdioServer,
} from "../shared/server-browser.ts";
import { isSignedInRun, SIGNED_IN_RUN_MARKER } from "../shared/signed-in.ts";
import { addLifecycleHook, type HookServer } from "./hooks.ts";
import type { SettingsReader } from "./report-back-hook.ts";
import { SERVER_BROWSER_FILES, SERVER_BROWSER_RUNTIME_FILES } from "./server-browser-files.ts";
import { stateDir } from "./state-dir.ts";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not run at all (`ENOENT`) or ran too long. */
  failure?: "missing" | "timeout" | "error";
}
export type Runner = (command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs a command without a shell; never throws. */
export const execRunner: Runner = (command, args, { timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const failure = err.code === "ENOENT" ? "missing" : err.killed ? "timeout" : undefined;
      resolve({
        code: typeof err.code === "number" ? err.code : null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(failure ? { failure } : typeof err.code === "number" ? {} : { failure: "error" as const }),
      });
    });
  });

/** sha256 over the build context, file names sorted: the image tag changes with any file. */
export function contextHash(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`);
  return hash.digest("hex");
}

/** The image this plugin version runs, from its embedded build context. */
export function currentImageTag(files: Readonly<Record<string, string>> = SERVER_BROWSER_FILES): string {
  return serverBrowserImageTag(contextHash(files));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The node binary for the session launcher: this process's own when it is node, else node on PATH
 * or in the usual places. Null when there is none.
 */
export async function findNode(
  env: NodeJS.ProcessEnv,
  execPath = process.execPath,
  executable: (path: string) => Promise<boolean> = isExecutable,
): Promise<string | null> {
  if (/^node(js)?(\.exe)?$/i.test(basename(execPath)) && (await executable(execPath))) return execPath;
  const candidates = [...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "node")), "/usr/bin/node", "/usr/local/bin/node"];
  for (const candidate of candidates) if (candidate.startsWith("/") && (await executable(candidate))) return candidate;
  return null;
}

/** Whether a host process is still running (signal 0); a process we may not signal counts as alive. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The docker CLI: on PATH, else the usual install places. Null when there is none. */
export async function findDocker(env: NodeJS.ProcessEnv, executable: (path: string) => Promise<boolean> = isExecutable): Promise<string | null> {
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "docker")),
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    join(env.HOME ?? "", "bin", "docker"),
  ];
  for (const candidate of candidates) if (candidate.startsWith("/") && (await executable(candidate))) return candidate;
  return null;
}

/**
 * Where docker talks to: DOCKER_HOST when set, else this user's rootless socket when it exists, else
 * null (the docker CLI's own context decides). Passed to the MCP server, whose process does not
 * necessarily inherit the daemon's environment.
 */
export async function resolveDockerHost(
  env: NodeJS.ProcessEnv,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
  fileExists: (path: string) => Promise<boolean> = exists,
): Promise<string | null> {
  if (env.DOCKER_HOST?.trim()) return env.DOCKER_HOST.trim();
  const dirs = [env.XDG_RUNTIME_DIR, uid !== null ? `/run/user/${uid}` : undefined].filter((dir): dir is string => !!dir);
  for (const dir of dirs) {
    const socket = join(dir, "docker.sock");
    if (await fileExists(socket)) return `unix://${socket}`;
  }
  return null;
}

export interface ServerBrowserStatus {
  state: ServerBrowserState;
  image: string;
  /** Docker runs rootless (null: unknown). */
  rootless: boolean | null;
  /** Short reason for a failed build or an unreachable Docker; never secrets. */
  detail: string;
}

/** Keeps the end of a command's error output, on one line, without anything that looks like a credential. */
export function shortError(text: string, max = 300): string {
  const line = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\s+/g, " ")
    .replace(/(token|password|secret|authorization)[=:]\s*\S+/gi, "$1=…")
    .trim();
  return line.length > max ? `…${line.slice(-max)}` : line;
}

export interface ServerBrowserOptions {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  files?: Readonly<Record<string, string>>;
  /** Where the build context is written before `docker build`. */
  buildRoot?: string;
  log?: (message: string) => void;
  random?: () => string;
  now?: () => number;
  /** How long a status probe is reused. */
  cacheMs?: number;
  interfaces?: () => Record<string, readonly { address: string }[] | undefined>;
  findDocker?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  findNode?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  dockerHost?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Host-side files (launcher, seccomp profile) and where they are written. */
  runtimeFiles?: Readonly<Record<string, string>>;
  runtimeRoot?: string;
  /** Whether a launcher pid still runs (tests replace it). */
  alive?: (pid: number) => boolean;
  /** At most this many runs with a browser at once. */
  maxRuns?: number;
  /** This plugin instance's id (tests); by default read from, or created in, the state directory. */
  instanceId?: string;
  instanceFile?: string;
}

/**
 * This plugin instance's id: `<host name>-<uuid>`, created once and kept in `file`, so every
 * resource it starts can be told apart from another daemon's on the same Docker.
 */
export async function loadInstanceId(file: string, host = hostname(), uuid = randomUUID): Promise<string> {
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (stored) return safeInstanceId(stored);
  } catch {
    // not created yet (or unreadable): make a new one
  }
  const name = host.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "host";
  const id = safeInstanceId(`${name}-${uuid()}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/**
 * The daemon side of the Server browser: finds Docker, builds the pinned image on demand (one build
 * at a time), reports status, issues one-time launch tickets, makes the per-session MCP server
 * config, and removes a run's containers when it is closed or archived.
 */
export function createServerBrowser(options: ServerBrowserOptions = {}) {
  const run = options.run ?? execRunner;
  const env = options.env ?? process.env;
  const files = options.files ?? SERVER_BROWSER_FILES;
  const image = currentImageTag(files);
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const random = options.random ?? (() => randomBytes(16).toString("hex"));
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 3_000;
  const interfaces = options.interfaces ?? (() => networkInterfaces());
  const tickets = createTicketStore({ random, now });
  const runtimeFiles = options.runtimeFiles ?? SERVER_BROWSER_RUNTIME_FILES;
  const runtimeDir = join(options.runtimeRoot ?? join(stateDir(), "server-browser"), `runtime-${contextHash(runtimeFiles).slice(0, 12)}`);
  const alive = options.alive ?? processAlive;
  const maxRuns = options.maxRuns ?? MAX_SERVER_BROWSER_RUNS;
  const instanceFile = options.instanceFile ?? join(stateDir(), "server-browser", "instance-id");
  let instancePromise: Promise<string> | null = null;
  const instance = () => {
    instancePromise ??= (options.instanceId ? Promise.resolve(safeInstanceId(options.instanceId)) : loadInstanceId(instanceFile)).catch((error: unknown) => {
      instancePromise = null;
      throw error;
    });
    return instancePromise;
  };
  /** Runs admitted in mcpServer whose browser container may not exist yet: agent id -> until. */
  const starting = new Map<string, number>();
  /** The latest admission of each run (its sequence number and session name): a close event seen before it is stale. */
  const admissions = new Map<string, Admission>();
  let runtimeReady: Promise<void> | null = null;
  /** Writes the launcher and the seccomp profile once per process (the directory name carries their hash). */
  function writeRuntime(): Promise<void> {
    runtimeReady ??= (async () => {
      const profile = runtimeFiles["seccomp.json"] ?? "";
      if (createHash("sha256").update(profile).digest("hex") !== SECCOMP_PROFILE_SHA256) throw new Error("the seccomp profile is not the pinned one");
      await mkdir(runtimeDir, { recursive: true });
      for (const [name, content] of Object.entries(runtimeFiles)) await writeFile(join(runtimeDir, name), content);
    })().catch((error: unknown) => {
      runtimeReady = null;
      throw error;
    });
    return runtimeReady;
  }

  /**
   * `docker ps`/`docker network ls` rows of `[id, ...labels]` for resources matching every filter.
   * Throws when docker cannot be asked, so counting fails closed; cleanup callers catch it.
   */
  async function listResources(kind: "container" | "network", filters: string[], labels: string[]) {
    const { path, host } = await dockerCommand();
    if (!path) throw new Error("docker not found");
    const format = ["{{.ID}}", ...labels.map((label) => `{{.Label "${label}"}}`)].join("\t");
    const filterArgs = filters.flatMap((filter) => ["--filter", filter]);
    const args = kind === "container" ? ["ps", "-a", ...filterArgs, "--format", format] : ["network", "ls", ...filterArgs, "--format", format];
    const result = await run(path, args, { timeoutMs: 15_000, env: dockerEnv(host) });
    if (result.code !== 0) throw new Error(`docker ${args[0]} failed`);
    return result.stdout
      .split("\n")
      .map((line) => line.split("\t").map((part) => part.trim()))
      .filter(([id]) => !!id && /^[0-9a-f]{6,64}$/.test(id!));
  }

  async function removeIds(containers: string[], networks: string[]): Promise<number> {
    const { path, host } = await dockerCommand();
    if (!path) return 0;
    if (containers.length) await run(path, ["rm", "-f", ...containers], { timeoutMs: 30_000, env: dockerEnv(host) });
    // A network goes once its containers are gone; one still in use fails here and stays.
    for (const network of networks) await run(path, ["network", "rm", network], { timeoutMs: 30_000, env: dockerEnv(host) });
    return containers.length + networks.length;
  }

  /**
   * Runs that hold a browser: those with a browser container now (any instance: they all use this
   * host's resources), plus runs admitted in the last STARTING_WINDOW_MS whose container is not up
   * yet. `except` leaves one run out (the one being admitted). Throws when docker cannot be asked.
   */
  async function runsHoldingABrowser(except?: string): Promise<Set<string>> {
    const rows = await listResources("container", [`label=${CONTAINER_LABEL}=browser`], [CONTAINER_AGENT_LABEL]);
    const runs = new Set(rows.map(([, agent]) => agent!).filter(Boolean));
    const t = now();
    for (const [agent, until] of starting) {
      if (until <= t || runs.has(agent)) starting.delete(agent);
      else runs.add(agent);
    }
    if (except) runs.delete(except);
    return runs;
  }
  async function activeRuns(): Promise<number> {
    return (await runsHoldingABrowser()).size;
  }
  let building: Promise<void> | null = null;
  let buildError: string | null = null;
  let cached: { at: number; status: ServerBrowserStatus } | null = null;
  let docker: { path: string | null; host: string | null } | null = null;

  async function dockerCommand() {
    if (docker?.path) return docker;
    const path = await (options.findDocker ?? findDocker)(env);
    const host = await (options.dockerHost ?? ((e) => resolveDockerHost(e)))(env);
    docker = { path, host };
    return docker;
  }

  function dockerEnv(host: string | null): NodeJS.ProcessEnv {
    return host ? { ...env, DOCKER_HOST: host } : env;
  }

  async function probe(): Promise<ServerBrowserStatus> {
    const { path, host } = await dockerCommand();
    if (!path) return { state: "docker-missing", image, rootless: null, detail: "" };
    const info = await run(path, ["info", "--format", "{{json .SecurityOptions}}"], { timeoutMs: 15_000, env: dockerEnv(host) });
    if (info.failure === "missing") {
      docker = null;
      return { state: "docker-missing", image, rootless: null, detail: "" };
    }
    if (info.code !== 0) return { state: "docker-unavailable", image, rootless: null, detail: shortError(info.stderr || info.stdout) };
    const rootless = /rootless/.test(info.stdout);
    if (building) return { state: "building", image, rootless, detail: "" };
    const inspect = await run(path, ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 15_000, env: dockerEnv(host) });
    if (inspect.code === 0) return { state: "ready", image, rootless, detail: "" };
    if (buildError) return { state: "build-failed", image, rootless, detail: buildError };
    return { state: "no-image", image, rootless, detail: "" };
  }

  async function build(): Promise<void> {
    const { path, host } = await dockerCommand();
    if (!path) throw new Error("docker not found");
    const dir = join(options.buildRoot ?? join(stateDir(), "server-browser"), image.split(":")[1]!);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    log(`building the Server browser image ${image}`);
    const result = await run(path, ["build", "--label", `${CONTAINER_LABEL}=image`, "-t", image, dir], {
      timeoutMs: 30 * 60_000,
      env: dockerEnv(host),
    });
    if (result.code !== 0) throw new Error(shortError(result.stderr || result.stdout || result.failure || "build failed"));
    log(`built the Server browser image ${image}`);
  }

  function startBuild(): void {
    if (building) return;
    buildError = null;
    cached = null;
    building = build()
      .catch((error: unknown) => {
        buildError = error instanceof Error ? error.message : String(error);
        log(`building the Server browser image failed: ${buildError}`);
      })
      .finally(() => {
        building = null;
        cached = null;
      });
  }

  async function status(input: { build?: boolean } = {}): Promise<ServerBrowserStatus> {
    let current = cached && now() - cached.at < cacheMs ? cached.status : await probe();
    if (input.build && (current.state === "no-image" || current.state === "build-failed")) {
      startBuild();
      current = { ...current, state: "building", detail: "" };
    }
    cached = { at: now(), status: current };
    return current;
  }

  return {
    image,
    status,
    /** For the signed-in browser (server/signed-in.ts): the same docker, instance, runtime files and host addresses. */
    docker: dockerCommand,
    dockerEnv,
    instance,
    async runtime() {
      await writeRuntime();
      return { launcher: join(runtimeDir, "launch.mjs"), seccomp: join(runtimeDir, "seccomp.json") };
    },
    node: () => (options.findNode ?? findNode)(env),
    blockedIps: () => hostAddressesToBlock(interfaces()),
    listResources,
    /** Fresh check; issues a ticket only when ready. Never builds: only the settings' Build does. */
    async prepare(target: { sourceId: string; cardId: string }) {
      cached = null;
      const current = await status();
      if (current.state !== "ready") return { ok: false as const, state: current.state, detail: current.detail };
      // Runs with a browser now, runs starting, and runs about to start (tickets not used yet) count.
      let held: number;
      try {
        held = await activeRuns();
      } catch {
        return { ok: false as const, state: "docker-unavailable" as const, detail: "could not count the running Server browsers" };
      }
      if (held + tickets.pending() >= maxRuns) return { ok: false as const, state: "busy" as const, detail: "" };
      return { ok: true as const, ticket: tickets.issue(target) };
    },
    activeRuns,
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => tickets.consume(ticket, target),
    /**
     * The MCP server for one session of this run (`node launch.mjs <plan>`), with the session name;
     * `{ refused }` when the cap is reached or the running browsers cannot be counted (fails closed),
     * for every open reason; null without Docker or node. An admitted run counts toward the cap
     * from here until its browser container shows up.
     */
    async mcpServer(agentId: string): Promise<{ server: StdioServer; session: string } | { refused: "busy" | "unavailable" } | null> {
      const { path, host } = await dockerCommand();
      const node = await (options.findNode ?? findNode)(env);
      if (!path || !node) return null;
      let others: number;
      try {
        others = (await runsHoldingABrowser(agentId)).size;
      } catch {
        return { refused: "unavailable" };
      }
      // Tickets not used yet are runs the card is about to start; this run's own ticket is used by now.
      if (others + tickets.pending() >= maxRuns) return { refused: "busy" };
      await writeRuntime();
      const nonce = random().slice(0, 12);
      const plan = serverBrowserPlan(path, {
        image,
        agentId,
        nonce,
        blockedIps: hostAddressesToBlock(interfaces()),
        seccompProfile: join(runtimeDir, "seccomp.json"),
        instance: await instance(),
      });
      starting.set(agentId, now() + STARTING_WINDOW_MS);
      const session = sessionNames(agentId, nonce).browser;
      rememberAdmission(admissions, agentId, { seq: nextAdmissionSeq(), session });
      return { server: serverBrowserMcpServer(node, join(runtimeDir, "launch.mjs"), plan, host), session };
    },
    /**
     * Frees the slot a run took when it was admitted (its container may never have come up): a run
     * that is stopped or closed right after its start no longer counts toward the cap. `seenAt` is
     * the admission sequence number when the stop or close was seen (`admissionSeq()`): a run
     * admitted after it is a newer session (a refresh or resume) and keeps its slot.
     */
    release(agentId: string, seenAt?: number): void {
      if (admittedAfter(admissions.get(agentId), seenAt)) return;
      starting.delete(agentId);
    },
    /** The run's latest admission (sequence number and session name), for the close hook. */
    admission: (agentId: string): Admission | undefined => admissions.get(agentId),
    /**
     * Removes this run's containers and networks, except those of session `except` (a backstop: a
     * session's launcher removes them when it ends, but a killed launcher leaves them behind).
     */
    async removeContainers(agentId: string, except?: string): Promise<number> {
      const filters = [`label=${CONTAINER_AGENT_LABEL}=${safeAgentId(agentId)}`, `label=${INSTANCE_LABEL}=${await instance()}`];
      const keep = ([, session]: string[]) => !except || session !== except;
      const containers = (await listResources("container", filters, [SESSION_LABEL]).catch(() => [])).filter(keep).map(([id]) => id!);
      const networks = (await listResources("network", filters, [SESSION_LABEL]).catch(() => [])).filter(keep).map(([id]) => id!);
      if (containers.length + networks.length === 0) return 0;
      return removeIds(containers, networks);
    },
    /**
     * Removes this instance's Server browser containers and networks whose launcher process is gone,
     * once they are older than SWEEP_MIN_AGE_MS. Resources of another instance (another daemon on
     * the same Docker), without this instance's label (one a person started by hand), or without a
     * readable creation time are never touched. Run at start and every few minutes.
     */
    async sweep(): Promise<number> {
      const id = await instance();
      const filters = [`label=${CONTAINER_LABEL}`, `label=${INSTANCE_LABEL}=${id}`];
      const t = now();
      // The instance is checked again here, not only in docker's filter.
      const orphan = ([, pid, created, owner]: string[]) => {
        const at = Number(created) * 1000;
        return owner === id && Number.isFinite(at) && at > 0 && t - at >= SWEEP_MIN_AGE_MS && !alive(Number(pid));
      };
      const rows = (kind: "container" | "network") => listResources(kind, filters, [LAUNCHER_PID_LABEL, CREATED_LABEL, INSTANCE_LABEL]).catch(() => []);
      const containers = (await rows("container")).filter(orphan).map(([id]) => id!);
      const networks = (await rows("network")).filter(orphan).map(([id]) => id!);
      if (containers.length + networks.length === 0) return 0;
      return removeIds(containers, networks);
    },
  };
}

export type ServerBrowser = ReturnType<typeof createServerBrowser>;

/**
 * When a run was last admitted a browser, as a sequence number, and the name of that session. One
 * counter for this module and the signed-in browser (a process has one of each), so an admission
 * and a close event are ordered without comparing clocks.
 */
export interface Admission {
  seq: number;
  session: string;
  /** Signed-in: the admission this one replaced while its setup runs (dropped once it is set up). */
  previous?: Admission;
  /** Signed-in: its setup failed (never restored). */
  failed?: boolean;
  /** Signed-in: the starting window this admission set. */
  until?: number;
}

let admissionSeq = 0;
/** The stamp of the latest admission so far: an event seen now is older than every admission after it. */
export const currentAdmissionSeq = (): number => admissionSeq;
/** A new, larger stamp for an admission. */
export const nextAdmissionSeq = (): number => ++admissionSeq;

const MAX_ADMISSIONS = 1000;

/** Notes an admission, newest last, keeping the map bounded. */
export function rememberAdmission(admissions: Map<string, Admission>, agentId: string, admission: Admission): void {
  admissions.delete(agentId);
  admissions.set(agentId, admission);
  if (admissions.size > MAX_ADMISSIONS) admissions.delete(admissions.keys().next().value!);
}

/** Whether a run was admitted after `seenAt` (a stop or close seen earlier is then about an older session). */
export function admittedAfter(admission: Admission | undefined, seenAt: number | undefined): boolean {
  return !!admission && seenAt !== undefined && admission.seq > seenAt;
}

type OpenHandler = (input: { request: PluginSessionOpenRequest }, context: PluginHookContext) => Promise<PluginSessionOpenRequest | undefined>;
/** The session-open registration the host offers: `addHook("agent.open.before")` or the older `before("agent.session_open")`. */
export type OpenHookServer = HookServer & {
  before?: (name: "agent.session_open", handler: OpenHandler) => () => void;
  addHook?: (name: string, handler: (payload: never, context: PluginHookContext) => Promise<unknown>) => () => void;
};

const MAX_ATTACHED = 1000;

type AgentSnapshot = { agent?: { status?: string; archivedAt?: string | null } | null } | null | undefined;

/**
 * Whether the daemon shows the agent as live (neither closed nor archived): a close or archive
 * event about it is then stale, from a session that a refresh or resume replaced. Unknown (no
 * snapshot, or the read fails) is not live, so the cleanup goes on as before.
 */
const LIVE_CHECK_MS = 5000;

async function liveAgain(context: { paseo?: unknown; signal?: AbortSignal } | undefined, agentId: string, timeoutMs = LIVE_CHECK_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const paseo = context?.paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<AgentSnapshot> } } } | undefined;
    const read = paseo?.agents?.ref?.(agentId)?.refresh?.();
    if (!read) return false;
    // A slow or hanging read, or an aborted hook, counts as "not live": the cleanup goes on.
    const gaveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      onAbort = () => resolve(null);
      if (context?.signal?.aborted) resolve(null);
      else context?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const agent = (await Promise.race([read, gaveUp]))?.agent;
    return !!agent && agent.status !== "closed" && !agent.archivedAt;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) context?.signal?.removeEventListener("abort", onAbort);
  }
}

/** What the session-open hook needs from the signed-in browser (server/signed-in.ts). */
export interface SignedInAttach {
  consumeTicket(ticket: string, target: { sourceId: string; cardId: string }): boolean;
  mcpServer(agentId: string): Promise<{ server: StdioServer; session: string } | { refused: "busy" | "unavailable" } | null>;
  /** Frees the browser a run was admitted to before its MCP container came up (it was stopped or closed). */
  release?(agentId: string, seenAt?: number): void;
  /** The run's latest admission, so a close older than it does not remove the new session's containers. */
  admission?(agentId: string): Admission | undefined;
}

/** Whether a card recorded `runId` as a Server browser or signed-in run (any card: the id is the run's). */
export function browserRunRecorded(runs: readonly (readonly string[])[], runId: string): boolean {
  return runs.some((entry) => entry[1] === runId && (entry.slice(2).includes(SERVER_RUN_MARKER) || entry.slice(2).includes(SIGNED_IN_RUN_MARKER)));
}

/**
 * Gives Server browser runs their MCP server when their session opens, and only them (see
 * `shouldAttachServerBrowser`). Returns `supported: false` when the host has no session-open hook.
 */
export function registerServerBrowser(
  server: OpenHookServer,
  settings: SettingsReader,
  browser: ServerBrowser,
  options: { log?: (message: string) => void; sweepEveryMs?: number; signedIn?: SignedInAttach; liveCheckMs?: number } = {},
) {
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const attached = new Set<string>();
  const remember = (agentId: string) => {
    attached.delete(agentId);
    attached.add(agentId);
    if (attached.size > MAX_ATTACHED) attached.delete(attached.values().next().value!);
  };

  const deps = {
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => browser.consumeTicket(ticket, target),
    async isRecorded(query: { sourceId: string; cardId: string; runId: string }) {
      if (attached.has(query.runId)) return true;
      const state = await settings.read().catch(() => null);
      return state?.status === "ready" && serverRunRecorded(state.values.runs, query);
    },
  };

  const signedInDeps = {
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => options.signedIn?.consumeTicket(ticket, target) ?? false,
    async isRecorded(query: { sourceId: string; cardId: string; runId: string }) {
      if (attached.has(query.runId)) return true;
      const state = await settings.read().catch(() => null);
      return state?.status === "ready" && serverRunRecorded(state.values.runs, query, SIGNED_IN_RUN_MARKER);
    },
  };

  const signedInHandler: OpenHandler = async ({ request }) => {
    const signedIn = options.signedIn;
    if (!signedIn || !(await shouldAttachSignedIn(request, signedInDeps))) return undefined;
    const mcp = await signedIn.mcpServer(request.agentId).catch(() => null);
    if (!mcp) {
      log(`run ${request.agentId} is a signed-in run, but docker, node or the signed-in browser is not available; no browser attached`);
      return undefined;
    }
    if ("refused" in mcp) {
      log(`run ${request.agentId}: the signed-in browser is ${mcp.refused === "busy" ? "in use by another run" : "not available"}; none attached (${request.reason})`);
      return undefined;
    }
    remember(request.agentId);
    log(`attached the signed-in browser to run ${request.agentId} (${request.reason})`);
    if (request.reason !== "create") {
      void browser.removeContainers(request.agentId, mcp.session).then(
        (removed) => removed && log(`removed ${removed} earlier signed-in MCP container(s) of run ${request.agentId}`),
        () => undefined,
      );
    }
    return { ...request, mcpServers: { ...request.mcpServers, [SERVER_BROWSER_MCP_NAME]: mcp.server } };
  };

  const handler: OpenHandler = async (input, context) => {
    const { request } = input;
    if (request.purpose !== "history" && isSignedInRun(request.labels)) return signedInHandler(input, context);
    if (!(await shouldAttachServerBrowser(request, deps))) return undefined;
    const mcp = await browser.mcpServer(request.agentId).catch(() => null);
    if (!mcp) {
      log(`run ${request.agentId} is a Server browser run, but docker or node was not found; no browser attached`);
      return undefined;
    }
    if ("refused" in mcp) {
      log(
        mcp.refused === "busy"
          ? `run ${request.agentId}: ${MAX_SERVER_BROWSER_RUNS} Server browser runs already have a browser; none attached (${request.reason})`
          : `run ${request.agentId}: could not count the running Server browsers; none attached (${request.reason})`,
      );
      return undefined;
    }
    remember(request.agentId);
    log(`attached the Server browser to run ${request.agentId} (${request.reason})`);
    // A run has one live session: containers of its earlier sessions are left over (for example
    // from a provider process that was killed), so they go now. Not awaited: the open must not wait.
    if (request.reason !== "create") {
      void browser.removeContainers(request.agentId, mcp.session).then(
        (removed) => removed && log(`removed ${removed} earlier Server browser container(s) of run ${request.agentId}`),
        () => undefined,
      );
    }
    return { ...request, mcpServers: { ...request.mcpServers, [SERVER_BROWSER_MCP_NAME]: mcp.server } };
  };

  const offs: (() => void)[] = [];
  let supported = false;
  try {
    if (typeof server.addHook === "function") {
      offs.push(server.addHook("agent.open.before", handler as unknown as (payload: never, context: PluginHookContext) => Promise<unknown>));
      supported = true;
    } else if (typeof server.before === "function") {
      offs.push(server.before("agent.session_open", handler));
      supported = true;
    }
  } catch (error) {
    log(`this Paseo has no session-open hook; the Server browser is off (${error instanceof Error ? error.message : "error"})`);
  }

  // A run that is stopped (archived, for example by the card's Stop) or closed frees its slot at
  // once, and its containers go. Runs attached in this process, and after a daemon restart runs a
  // card recorded as Server browser or signed-in runs; other agents cause no docker call.
  //
  // The events carry no time or session, so a close of an old session can arrive after a refresh or
  // resume admitted a new one. An event is stale when the agent is live again (not closed, not
  // archived), and whatever was admitted after the event was seen keeps its slot and its session's
  // containers.
  const cleanup = async (event: { agent: { id: string } }, context?: { paseo?: unknown; signal?: AbortSignal }) => {
    const id = event.agent.id;
    const seenAt = currentAdmissionSeq();
    // Only a run this plugin has something for: attached or admitted in this process, or one a card
    // recorded as a Server browser or signed-in run (after a daemon restart). Other agents cause no
    // status read and no docker call.
    const known = attached.has(id) || !!browser.admission(id) || !!options.signedIn?.admission?.(id);
    if (!known) {
      const state = await settings.read().catch(() => null);
      if (state?.status !== "ready" || !browserRunRecorded(state.values.runs, id)) return;
    }
    if (await liveAgain(context, id, options.liveCheckMs)) return;
    browser.release(id, seenAt);
    options.signedIn?.release?.(id, seenAt);
    // A session admitted since keeps its containers; only the older ones go.
    const newer = [browser.admission(id), options.signedIn?.admission?.(id)].filter((a) => admittedAfter(a, seenAt)).sort((a, b) => b!.seq - a!.seq)[0];
    // (A session still being admitted has no name yet: nothing is removed then.)
    if (newer && !newer.session) return;
    const removed = await browser.removeContainers(id, newer?.session).catch(() => 0);
    if (removed) log(`removed ${removed} Server browser container(s) of run ${id}`);
  };
  try {
    offs.push(addLifecycleHook(server, "agent.closed", cleanup));
    offs.push(addLifecycleHook(server, "agent.archived", cleanup));
  } catch {
    // Older hosts: the containers still end with the session's stdio and their maximum lifetime.
  }

  // At start and then every few minutes: remove containers and networks whose launcher is gone
  // (a daemon restart ends every session; a killed launcher leaves its resources behind).
  const sweep = () =>
    void browser.sweep().then(
      (removed) => removed && log(`removed ${removed} leftover Server browser container(s) and network(s)`),
      () => undefined,
    );
  sweep();
  const sweeper = setInterval(sweep, options.sweepEveryMs ?? 10 * 60_000);
  (sweeper as { unref?: () => void }).unref?.();
  offs.push(() => clearInterval(sweeper));

  return {
    supported,
    handler,
    attached: (agentId: string) => attached.has(agentId),
    dispose() {
      for (const off of offs) off();
    },
  };
}
