import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";
import type { PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import {
  CONTAINER_AGENT_LABEL,
  CONTAINER_LABEL,
  containerName,
  createTicketStore,
  hostAddressesToBlock,
  safeAgentId,
  SERVER_BROWSER_MCP_NAME,
  serverBrowserDockerArgs,
  serverBrowserImageTag,
  serverBrowserMcpServer,
  serverRunRecorded,
  shouldAttachServerBrowser,
  type ServerBrowserState,
  type StdioServer,
} from "../shared/server-browser.ts";
import { addLifecycleHook, type HookServer } from "./hooks.ts";
import type { SettingsReader } from "./report-back-hook.ts";
import { SERVER_BROWSER_FILES } from "./server-browser-files.ts";
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
  dockerHost?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
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
    /** Fresh check, starts a build when the image is missing, and issues a ticket only when ready. */
    async prepare(target: { sourceId: string; cardId: string }) {
      cached = null;
      const current = await status({ build: true });
      if (current.state !== "ready") return { ok: false as const, state: current.state, detail: current.detail };
      return { ok: true as const, ticket: tickets.issue(target) };
    },
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => tickets.consume(ticket, target),
    /** The MCP server for one session of this run, with its container name, or null without Docker. */
    async mcpServer(agentId: string): Promise<(StdioServer & { containerName: string }) | null> {
      const { path, host } = await dockerCommand();
      if (!path) return null;
      const nonce = random().slice(0, 12);
      const args = serverBrowserDockerArgs({ image, agentId, nonce, blockedIps: hostAddressesToBlock(interfaces()) });
      return Object.defineProperty(serverBrowserMcpServer(path, args, host), "containerName", { value: containerName(agentId, nonce), enumerable: false }) as StdioServer & {
        containerName: string;
      };
    },
    /**
     * Removes this run's containers, except the one named `except` (a backstop: they end with the
     * session's stdio, but a killed docker client leaves its container running).
     */
    async removeContainers(agentId: string, except?: string): Promise<number> {
      const { path, host } = await dockerCommand();
      if (!path) return 0;
      const list = await run(path, ["ps", "-a", "--filter", `label=${CONTAINER_AGENT_LABEL}=${safeAgentId(agentId)}`, "--format", "{{.ID}} {{.Names}}"], {
        timeoutMs: 15_000,
        env: dockerEnv(host),
      });
      const ids = list.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([id, name]) => !!id && /^[0-9a-f]{6,64}$/.test(id) && name !== except)
        .map(([id]) => id!);
      if (ids.length === 0) return 0;
      await run(path, ["rm", "-f", ...ids], { timeoutMs: 30_000, env: dockerEnv(host) });
      return ids.length;
    },
  };
}

export type ServerBrowser = ReturnType<typeof createServerBrowser>;

type OpenHandler = (input: { request: PluginSessionOpenRequest }, context: PluginHookContext) => Promise<PluginSessionOpenRequest | undefined>;
/** The session-open registration the host offers: `addHook("agent.open.before")` or the older `before("agent.session_open")`. */
export type OpenHookServer = HookServer & {
  before?: (name: "agent.session_open", handler: OpenHandler) => () => void;
  addHook?: (name: string, handler: (payload: never, context: PluginHookContext) => Promise<unknown>) => () => void;
};

const MAX_ATTACHED = 1000;

/**
 * Gives Server browser runs their MCP server when their session opens, and only them (see
 * `shouldAttachServerBrowser`). Returns `supported: false` when the host has no session-open hook.
 */
export function registerServerBrowser(
  server: OpenHookServer,
  settings: SettingsReader,
  browser: ServerBrowser,
  options: { log?: (message: string) => void } = {},
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

  const handler: OpenHandler = async ({ request }) => {
    if (!(await shouldAttachServerBrowser(request, deps))) return undefined;
    const mcp = await browser.mcpServer(request.agentId).catch(() => null);
    if (!mcp) {
      log(`run ${request.agentId} is a Server browser run, but docker was not found; no browser attached`);
      return undefined;
    }
    remember(request.agentId);
    log(`attached the Server browser to run ${request.agentId} (${request.reason})`);
    // A run has one live session: containers of its earlier sessions are left over (for example
    // from a provider process that was killed), so they go now. Not awaited: the open must not wait.
    if (request.reason !== "create") {
      void browser.removeContainers(request.agentId, mcp.containerName).then(
        (removed) => removed && log(`removed ${removed} earlier Server browser container(s) of run ${request.agentId}`),
        () => undefined,
      );
    }
    return { ...request, mcpServers: { ...request.mcpServers, [SERVER_BROWSER_MCP_NAME]: mcp } };
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

  const cleanup = async (event: { agent: { id: string } }) => {
    const id = event.agent.id;
    if (!attached.has(id)) return;
    const removed = await browser.removeContainers(id).catch(() => 0);
    if (removed) log(`removed ${removed} Server browser container(s) of run ${id}`);
  };
  try {
    offs.push(addLifecycleHook(server, "agent.closed", cleanup));
    offs.push(addLifecycleHook(server, "agent.archived", cleanup));
  } catch {
    // Older hosts: the containers still end with the session's stdio and their maximum lifetime.
  }

  return {
    supported,
    handler,
    attached: (agentId: string) => attached.has(agentId),
    dispose() {
      for (const off of offs) off();
    },
  };
}
