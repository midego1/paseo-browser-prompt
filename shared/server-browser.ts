// Pure logic for the Server browser: a run agent gets its own headless Chromium in a throwaway,
// locked-down Docker container on the daemon host, through Playwright MCP over stdio. The browser
// container sits alone on an internal network; a proxy sidecar is its only way out. Labels and
// run markers, the docker arguments and the launcher plan, the MCP server config, the gate that decides which agent
// sessions get the server, one-time launch tickets, and status texts. Imports only other pure
// shared modules, so `node --experimental-strip-types` can load it in tests.
import { SERVER_BROWSER_MCP_NAME, SERVER_RUN_MARKER_TEXT } from "./agent-prompt.ts";
import { reportTarget, runKey } from "./report-back.ts";

export { SERVER_BROWSER_MCP_NAME };

/** Label on a run agent naming the browser it was started for; only `server` is read. */
export const BROWSER_LABEL = "browser-prompt-browser";
export const SERVER_BROWSER_LABEL_VALUE = "server";
/** One-time ticket from `serverBrowser.prepare`, checked when the run's session first opens. */
export const TICKET_LABEL = "browser-prompt-ticket";
/** Marker in the card's `runs` record for a Server browser run. */
export const SERVER_RUN_MARKER = SERVER_RUN_MARKER_TEXT;

/** Pinned versions: Playwright 1.65.1 (Chromium revision 1255), Playwright MCP 0.0.84 on top of it. */
export const PLAYWRIGHT_VERSION = "1.65.1";
export const PLAYWRIGHT_MCP_VERSION = "0.0.84";
export const BASE_IMAGE =
  "mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579";
export const IMAGE_REPOSITORY = "browser-prompt-server-browser";

/** `browser-prompt-server-browser:pw<playwright>-mcp<mcp>-<12 hex of the build context hash>`, never `latest`. */
export function serverBrowserImageTag(contextHash: string): string {
  const hash = contextHash.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  if (hash.length < 12) throw new Error("The image tag needs a build context hash.");
  return `${IMAGE_REPOSITORY}:pw${PLAYWRIGHT_VERSION}-mcp${PLAYWRIGHT_MCP_VERSION}-${hash}`;
}

/**
 * Docker labels on every Server browser resource. CONTAINER_LABEL's value is the role (`browser`,
 * `proxy`, `network`, `image`); the launcher label holds the host pid of the session's launcher, so
 * resources whose launcher is gone can be removed.
 */
export const CONTAINER_LABEL = "browser-prompt.server-browser";
export const CONTAINER_AGENT_LABEL = "browser-prompt.agent";
export const SESSION_LABEL = "browser-prompt.session";
export const LAUNCHER_PID_LABEL = "browser-prompt.launcher-pid";
/**
 * The plugin instance (daemon host name plus a uuid kept in the plugin's state directory) that made
 * a resource. The sweep only ever removes resources with its own instance id, so another daemon on
 * the same Docker, or a container someone started from the image by hand, is never touched.
 */
export const INSTANCE_LABEL = "browser-prompt.instance";
/** When the launcher created the resource (Unix seconds); the sweep leaves young resources alone. */
export const CREATED_LABEL = "browser-prompt.created";
/** Placeholders the launcher fills in (see server-browser/launch.mjs). */
export const PID_PLACEHOLDER = "__BP_PID__";
export const CREATED_PLACEHOLDER = "__BP_CREATED__";
export const SUBNET_PLACEHOLDER = "__BP_SUBNET__";
export const PROXY_IP_PLACEHOLDER = "__BP_PROXY_IP__";
export const PROXY_PORT = 3128;

/**
 * sha256 of server-browser/seccomp.json: Playwright's utils/docker/seccomp_profile.json at tag
 * v1.65.1 (https://raw.githubusercontent.com/microsoft/playwright/v1.65.1/utils/docker/seccomp_profile.json,
 * Apache-2.0), byte for byte. The plugin refuses to write a profile with another hash.
 */
export const SECCOMP_PROFILE_SHA256 = "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849";
export const SECCOMP_PROFILE_SOURCE = "microsoft/playwright v1.65.1 utils/docker/seccomp_profile.json";

/** Resources younger than this are never swept: their launcher may still be setting them up. */
export const SWEEP_MIN_AGE_MS = 2 * 60_000;
/** A run counts toward the cap from its admission until its browser container shows up (or this long). */
export const STARTING_WINDOW_MS = 2 * 60_000;

/** At most this many Server browser runs have a browser at the same time on one host. */
export const MAX_SERVER_BROWSER_RUNS = 3;

/** Resource limits per browser container, and the stops every container applies to itself. */
export const CONTAINER_LIMITS = {
  memory: "1536m",
  cpus: "1.5",
  pids: 512,
  tmpfs: "512m",
  shm: "256m",
  /** The container stops itself after this long, whatever happens to its session. */
  maxLifetimeSeconds: 12 * 60 * 60,
  /** ... and after this long without any MCP message (a killed docker client leaves stdin open). */
  idleTimeoutSeconds: 2 * 60 * 60,
} as const;

/** Limits of the proxy sidecar. */
export const PROXY_LIMITS = { memory: "256m", cpus: "0.5", pids: 64, tmpfs: "16m" } as const;

/** Public resolvers for the sidecar, so names never go to the host's (or the tailnet's) resolver. */
export const CONTAINER_DNS = ["1.1.1.1", "9.9.9.9"] as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

/** Agent ids go into container names and labels; anything unusual is refused. */
export function safeAgentId(agentId: string): string {
  if (!SAFE_ID.test(agentId)) throw new Error("Unexpected agent id for a Server browser container.");
  return agentId;
}

/** `bp-sb-<agent id>-<nonce>`: unique per session open, at most 63 characters with a suffix. */
export function containerName(agentId: string, nonce: string): string {
  const id = safeAgentId(agentId).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 36);
  const suffix = nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "0";
  return `bp-sb-${id}-${suffix}`;
}

/**
 * The daemon host's own addresses, for the block list: a service on the host that listens on all
 * interfaces is then not reachable through its public address either. Takes the shape of
 * `os.networkInterfaces()`; drops zone ids and anything that does not look like an address.
 */
export function hostAddressesToBlock(interfaces: Record<string, readonly { address: string }[] | undefined>): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const address = String(entry.address ?? "").split("%")[0]!.trim().toLowerCase();
      if (IP_TEXT.test(address)) out.add(address);
    }
  }
  return [...out].sort().slice(0, 64);
}

export interface DockerArgsInput {
  image: string;
  agentId: string;
  /** Unique part of the resource names. */
  nonce: string;
  /** The host's own addresses (see `hostAddressesToBlock`). */
  blockedIps: readonly string[];
  /** Host path of the seccomp profile the browser container uses (Playwright's, allowing user namespaces). */
  seccompProfile: string;
  /** This plugin instance (see INSTANCE_LABEL). */
  instance: string;
}

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Instance ids go into labels; anything unusual is refused. */
export function safeInstanceId(instance: string): string {
  if (!INSTANCE_ID.test(instance)) throw new Error("Unexpected plugin instance id.");
  return instance;
}

function checkImage(image: string) {
  if (!image.startsWith(`${IMAGE_REPOSITORY}:`) || image.endsWith(":latest")) throw new Error("The Server browser only runs its own pinned image.");
}

function sessionLabels(input: DockerArgsInput, role: string): string[] {
  return [
    "--label",
    `${CONTAINER_LABEL}=${role}`,
    "--label",
    `${CONTAINER_AGENT_LABEL}=${safeAgentId(input.agentId)}`,
    "--label",
    `${SESSION_LABEL}=${containerName(input.agentId, input.nonce)}`,
    "--label",
    `${LAUNCHER_PID_LABEL}=${PID_PLACEHOLDER}`,
    "--label",
    `${INSTANCE_LABEL}=${safeInstanceId(input.instance)}`,
    "--label",
    `${CREATED_LABEL}=${CREATED_PLACEHOLDER}`,
  ];
}

/** The session's names: browser container, proxy sidecar and internal network. */
export function sessionNames(agentId: string, nonce: string) {
  const base = containerName(agentId, nonce);
  return { browser: base, proxy: `${base}-proxy`, network: `${base}-net` };
}

/** `docker network create` for the session's internal network: no gateway, no route out. */
export function serverBrowserNetworkArgs(input: DockerArgsInput): string[] {
  return ["network", "create", "--internal", "--driver", "bridge", ...sessionLabels(input, "network"), sessionNames(input.agentId, input.nonce).network];
}

/**
 * `docker run -d` for the proxy sidecar: the only container of the session with a route out (the
 * default bridge; the launcher then connects it to the internal network). It accepts clients only
 * from the internal network. Same hardening as the browser: no mounts, every capability dropped, no
 * new privileges, read-only root, unprivileged user, limits, no log, never pulls.
 */
export function serverBrowserProxyArgs(input: DockerArgsInput): string[] {
  checkImage(input.image);
  const ips = input.blockedIps.filter((ip) => IP_TEXT.test(ip));
  return [
    "run",
    "-d",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    sessionNames(input.agentId, input.nonce).proxy,
    ...sessionLabels(input, "proxy"),
    "--network",
    "bridge",
    ...CONTAINER_DNS.flatMap((dns) => ["--dns", dns]),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${PROXY_LIMITS.tmpfs}`,
    "--memory",
    PROXY_LIMITS.memory,
    "--memory-swap",
    PROXY_LIMITS.memory,
    "--cpus",
    PROXY_LIMITS.cpus,
    "--pids-limit",
    String(PROXY_LIMITS.pids),
    "--user",
    "pwuser",
    "--workdir",
    "/tmp",
    "--hostname",
    "server-browser-proxy",
    "--env",
    `BP_BLOCKED_IPS=${ips.join(",")}`,
    "--env",
    `BP_ALLOW_CLIENTS=${SUBNET_PLACEHOLDER}`,
    "--env",
    `BP_PROXY_PORT=${PROXY_PORT}`,
    "--env",
    `BP_MAX_LIFETIME_S=${CONTAINER_LIMITS.maxLifetimeSeconds}`,
    "--log-driver",
    "none",
    "--stop-timeout",
    "2",
    "--entrypoint",
    "node",
    input.image,
    "/opt/browser-prompt/proxy-main.mjs",
  ];
}

/**
 * `docker run -i` for the browser container, attached to the session's stdio. It is on the internal
 * network only, so it reaches nothing but the sidecar; external names do not even resolve there.
 * No mounts (only tmpfs), every capability dropped except CAP_SYS_CHROOT in the bounding set (for
 * Chromium's own sandbox inside its user namespace; the container user has no effective
 * capabilities), no new privileges, Playwright's seccomp profile, read-only root, unprivileged user,
 * memory, CPU and process limits, no log, never pulls, and `--rm --init`.
 */
export function serverBrowserDockerArgs(input: DockerArgsInput): string[] {
  checkImage(input.image);
  if (!input.seccompProfile.startsWith("/") || /[,\s]/.test(input.seccompProfile)) throw new Error("The seccomp profile needs an absolute path.");
  const ips = input.blockedIps.filter((ip) => IP_TEXT.test(ip));
  const limits = CONTAINER_LIMITS;
  return [
    "run",
    "-i",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    sessionNames(input.agentId, input.nonce).browser,
    ...sessionLabels(input, "browser"),
    "--network",
    sessionNames(input.agentId, input.nonce).network,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SYS_CHROOT",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${input.seccompProfile}`,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.tmpfs}`,
    "--shm-size",
    limits.shm,
    "--memory",
    limits.memory,
    "--memory-swap",
    limits.memory,
    "--cpus",
    limits.cpus,
    "--pids-limit",
    String(limits.pids),
    "--user",
    "pwuser",
    "--workdir",
    "/tmp",
    "--hostname",
    "server-browser",
    "--env",
    "HOME=/tmp/home",
    "--env",
    `BP_PROXY=http://${PROXY_IP_PLACEHOLDER}:${PROXY_PORT}`,
    "--env",
    `BP_BLOCKED_IPS=${ips.join(",")}`,
    "--env",
    `BP_MAX_LIFETIME_S=${limits.maxLifetimeSeconds}`,
    "--env",
    `BP_IDLE_TIMEOUT_S=${limits.idleTimeoutSeconds}`,
    "--log-driver",
    "none",
    "--stop-timeout",
    "5",
    input.image,
  ];
}

/** Everything the launcher (server-browser/launch.mjs) runs for one session. */
export interface ServerBrowserPlan {
  docker: string;
  network: { name: string; create: string[] };
  proxy: { name: string; run: string[] };
  browser: { name: string; run: string[] };
}

export function serverBrowserPlan(docker: string, input: DockerArgsInput): ServerBrowserPlan {
  if (!docker.startsWith("/")) throw new Error("docker must be an absolute path");
  const names = sessionNames(input.agentId, input.nonce);
  return {
    docker,
    network: { name: names.network, create: serverBrowserNetworkArgs(input) },
    proxy: { name: names.proxy, run: serverBrowserProxyArgs(input) },
    browser: { name: names.browser, run: serverBrowserDockerArgs(input) },
  };
}

export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Base64 of UTF-8 JSON, without Node's Buffer (this module also runs in the app). */
function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The MCP server a Server browser run gets: `node launch.mjs <plan>` over stdio. */
export function serverBrowserMcpServer(node: string, launcher: string, plan: ServerBrowserPlan, dockerHost?: string | null): StdioServer {
  return { type: "stdio", command: node, args: [launcher, base64Json(plan)], ...(dockerHost ? { env: { DOCKER_HOST: dockerHost } } : {}) };
}

/** Labels that mark a run as a Server browser run, with its launch ticket. */
export function serverRunLabels(ticket: string): Record<string, string> {
  return { [BROWSER_LABEL]: SERVER_BROWSER_LABEL_VALUE, [TICKET_LABEL]: ticket };
}

export function isServerBrowserRun(labels: Record<string, unknown> | null | undefined): boolean {
  return !!labels && labels[BROWSER_LABEL] === SERVER_BROWSER_LABEL_VALUE;
}

/** Whether the card's `runs` setting records this agent as a Server browser run of that card. */
export function serverRunRecorded(
  runs: readonly (readonly string[])[],
  query: { sourceId: string; cardId: string; runId: string },
): boolean {
  const key = runKey(query.sourceId, query.cardId);
  return runs.some((entry) => entry[0] === key && entry[1] === query.runId && entry.slice(2).includes(SERVER_RUN_MARKER));
}

export interface SessionOpenLike {
  agentId: string;
  reason: string;
  purpose?: string;
  labels: Readonly<Record<string, string>>;
}

export interface GateDeps {
  /** Takes a one-time ticket issued for this source chat and card; false when unknown, used or expired. */
  consumeTicket(ticket: string, target: { sourceId: string; cardId: string }): boolean;
  /** Whether a card recorded this agent as a Server browser run (or this process attached it before). */
  isRecorded(query: { sourceId: string; cardId: string; runId: string }): Promise<boolean>;
}

/**
 * Whether this session open gets the Server browser MCP server. Only agents with the plugin's run
 * labels and the Server browser label count. The first open (`create`) happens before the card can
 * record the run, so it needs the one-time ticket the card got from the daemon for this chat and
 * card; every later open (resume, refresh, import) needs the card's run record with the Server
 * browser marker, the same record the mode guard and report back check. History opens get nothing.
 */
export async function shouldAttachServerBrowser(request: SessionOpenLike, deps: GateDeps): Promise<boolean> {
  if (request.purpose === "history") return false;
  if (!isServerBrowserRun(request.labels)) return false;
  const target = reportTarget(request.agentId, request.labels);
  if (!target) return false;
  if (request.reason === "create") {
    const ticket = request.labels[TICKET_LABEL];
    return typeof ticket === "string" && ticket.length > 0 && deps.consumeTicket(ticket, target);
  }
  try {
    return await deps.isRecorded({ ...target, runId: request.agentId });
  } catch {
    return false;
  }
}

/** One-time launch tickets: issued for a chat and card, valid once and briefly. */
export function createTicketStore(options: { ttlMs?: number; max?: number; now?: () => number; random: () => string }) {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const max = options.max ?? 200;
  const now = options.now ?? Date.now;
  const tickets = new Map<string, { sourceId: string; cardId: string; expires: number }>();
  function prune() {
    const t = now();
    for (const [ticket, entry] of tickets) if (entry.expires <= t) tickets.delete(ticket);
    while (tickets.size >= max) tickets.delete(tickets.keys().next().value!);
  }
  return {
    issue(target: { sourceId: string; cardId: string }): string {
      prune();
      const ticket = options.random();
      tickets.set(ticket, { ...target, expires: now() + ttlMs });
      return ticket;
    },
    consume(ticket: string, target: { sourceId: string; cardId: string }): boolean {
      const entry = tickets.get(ticket);
      if (!entry) return false;
      tickets.delete(ticket);
      return entry.expires > now() && entry.sourceId === target.sourceId && entry.cardId === target.cardId;
    },
    size: () => tickets.size,
    /** Tickets issued and not used or expired yet: runs about to start. */
    pending(): number {
      const t = now();
      let count = 0;
      for (const entry of tickets.values()) if (entry.expires > t) count++;
      return count;
    },
  };
}

export const SERVER_BROWSER_STATES = ["ready", "building", "no-image", "build-failed", "docker-missing", "docker-unavailable", "unsupported", "busy"] as const;
export type ServerBrowserState = (typeof SERVER_BROWSER_STATES)[number];

/** What the card and the settings say for each state. */
export const SERVER_BROWSER_STATE_MESSAGES: Record<ServerBrowserState, string> = {
  ready: "Ready.",
  busy: `${MAX_SERVER_BROWSER_RUNS} Server browser runs already have a browser on the server (the limit). Archive or close a finished Server browser run (or turn on Archive the agent after a successful run), or wait until one ends, then try again.`,
  building: "The Server browser image is being built on the server (first use; a few minutes). Try again when Settings shows it ready.",
  "no-image": "The Server browser image is not built yet. Building it starts now; try again in a few minutes.",
  "build-failed": "Building the Server browser image failed. See the plugin settings, fix the cause and build again.",
  "docker-missing": "The Server browser needs Docker on the Paseo server, and the docker command was not found there.",
  "docker-unavailable": "The Server browser needs Docker on the Paseo server, and Docker is not reachable there (is the rootless Docker service running?).",
  unsupported: "This Paseo version cannot give a run its own browser (no agent session hooks). Update Paseo, or use the Paseo browser.",
};
