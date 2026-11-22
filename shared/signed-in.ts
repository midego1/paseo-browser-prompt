// Pure logic for the signed-in Server browser: one persistent neko container per plugin instance
// (Chromium with the owner's logins on a named Docker volume, a desktop the owner can watch and take
// over from a phone), on its own internal network with the filtering proxy sidecar as its only way
// out, and a relay that is the only published part (on the host's Tailscale address, or 127.0.0.1).
// A signed-in run gets the same pinned, filtered Playwright MCP as a Server browser run, attached
// over the DevTools protocol from a container that shares neko's network namespace. Names, labels,
// docker arguments and their checks, the run gate's labels, the idle rule, and status texts. Imports
// only other pure shared modules, so `node --experimental-strip-types` can load it in tests.
import { SIGNED_IN_RUN_MARKER_TEXT } from "./agent-prompt.ts";
import {
  BROWSER_LABEL,
  CONTAINER_AGENT_LABEL,
  CONTAINER_LABEL,
  CONTAINER_LIMITS,
  CREATED_LABEL,
  CREATED_PLACEHOLDER,
  INSTANCE_LABEL,
  IMAGE_REPOSITORY,
  LAUNCHER_PID_LABEL,
  PID_PLACEHOLDER,
  PROXY_LIMITS,
  PROXY_PORT,
  CONTAINER_DNS,
  safeAgentId,
  safeInstanceId,
  SESSION_LABEL,
  TICKET_LABEL,
  type StdioServer,
} from "./server-browser.ts";

/** BROWSER_LABEL's value on a signed-in run. */
export const SIGNED_IN_LABEL_VALUE = "signed-in";
/** Marker in the card's `runs` record for a signed-in run. */
export const SIGNED_IN_RUN_MARKER = SIGNED_IN_RUN_MARKER_TEXT;

/** neko 3.2.0 with Chromium 155 (Apache-2.0), pinned by digest; the plugin's image builds on it. */
export const NEKO_VERSION = "3.2.0";
export const NEKO_BASE_IMAGE = "ghcr.io/m1k1o/neko/chromium:3.2.0@sha256:270face8b8111e639744fb7bcdbbf0deed227900bb89d58b2f8adfc12af8c41e";
export const SIGNED_IN_IMAGE_REPOSITORY = "browser-prompt-signed-in";

/** `browser-prompt-signed-in:neko3.2.0-<12 hex of the build context hash>`, never `latest`. */
export function signedInImageTag(contextHash: string): string {
  const hash = contextHash.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  if (hash.length < 12) throw new Error("The image tag needs a build context hash.");
  return `${SIGNED_IN_IMAGE_REPOSITORY}:neko${NEKO_VERSION}-${hash}`;
}

/**
 * The Bitwarden Password Manager release the optional Bitwarden variant of the image installs
 * (signed-in-bitwarden/bitwarden.json holds the same pin; a test keeps them equal). Downloaded from
 * Bitwarden's GitHub releases at image build time, only after the owner's two-press consent, and
 * refused unless size and SHA-256 match. Its files are the same as the Chrome Web Store build of
 * that version (only the store's update_url differs); the store's public key gives it its usual id.
 * Chromium loads it unpacked from the read-only image, so it is never updated behind the pin.
 */
export const BITWARDEN = {
  version: "2026.11.0",
  url: "https://github.com/bitwarden/clients/releases/download/browser-v2026.11.0/bit-dist-chrome-2026.11.0.zip",
  sha256: "07cf19b8f79e649005fdeee67c85d3cf31c735449a01a37a5b9f0287732605a5",
  size: 33_808_971,
  id: "nngceckbapebfimnlniiiahkandclblb",
  /** Bitwarden's own "Lock vault" command gets this shortcut; the daemon presses it on the desktop when the owner releases control. */
  lockShortcut: "Ctrl+Shift+7",
} as const;

/** `<signed-in image tag>-bw<version>-<12 hex of the variant's build context hash>`, never `latest`. */
export function bitwardenImageTag(baseTag: string, contextHash: string): string {
  const hash = contextHash.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  if (hash.length < 12 || !baseTag.startsWith(`${SIGNED_IN_IMAGE_REPOSITORY}:`)) throw new Error("The Bitwarden image tag needs the signed-in image and a build context hash.");
  return `${baseTag}-bw${BITWARDEN.version}-${hash}`;
}

/**
 * `docker exec` that presses Bitwarden's "Lock vault" shortcut on neko's desktop, as the desktop
 * user (the X display Chromium runs on). Chromium handles it as the extension's command (the page
 * never sees the key). The daemon runs it; the run's agent cannot (it has no Docker and no desktop).
 */
export function bitwardenLockArgs(stackId: string): string[] {
  const keys = BITWARDEN.lockShortcut.toLowerCase();
  if (!/^(ctrl|alt)\+shift\+[0-9a-z]$/.test(keys)) throw new Error("Unexpected lock shortcut.");
  return ["exec", "--user", "neko", "--env", "DISPLAY=:99.0", stackNames(stackId).neko, "xdotool", "key", "--clearmodifiers", keys];
}

/** The Bitwarden option's state: off, or why it is not in the browser yet. */
export const BITWARDEN_STATES = ["off", "needs-browser", "no-image", "building", "build-failed", "ready"] as const;
export type BitwardenState = (typeof BITWARDEN_STATES)[number];

/** Label on every resource of the signed-in stack; its value is the role. Never swept by launcher pid. */
export const STACK_LABEL = "browser-prompt.signed-in";
/** CONTAINER_LABEL's value on a signed-in run's MCP container (swept like a Server browser's). */
export const SIGNED_IN_AGENT_ROLE = "signed-in-agent";

/** Default port of the owner's viewer on the bind address; the WebRTC (ICE-TCP) port is the next one. */
export const DEFAULT_SIGNED_IN_PORT = 5301;
/** The desktop's size: landscape for the agent and desktops, portrait while a phone watches. */
export const SCREEN_LANDSCAPE = "1280x720@30";
export const SCREEN_PORTRAIT = "720x1280@30";
/** The browser stops after this long without a run or a viewer. */
export const IDLE_STOP_MS = 30 * 60_000;
/** Chromium writes cookies about 30 s after a change: never stop sooner than this after the last viewer activity. */
export const MIN_UP_AFTER_VIEWER_MS = 45_000;
/** How long the owner's viewer link works (once). */
export const VIEWER_TICKET_TTL_S = 300;
/** The proxy and relay of a persistent stack stop themselves after this long at the latest (proxy-main.mjs, relay-main.mjs); the daemon starts new ones when needed. */
export const STACK_MAX_LIFETIME_S = 7 * 24 * 60 * 60;

export const NEKO_LIMITS = { memory: "2560m", cpus: "2", pids: 1024, shm: "2g" } as const;
export const RELAY_LIMITS = { memory: "256m", cpus: "0.5", pids: 64, tmpfs: "16m" } as const;
export const SIGNED_IN_AGENT_LIMITS = { memory: "1g", cpus: "1", pids: 256, tmpfs: "256m" } as const;

const STACK_ID = /^[0-9a-f]{8}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Only 127.0.0.1 or a Tailscale address (100.64.0.0/10) may be a bind address; never 0.0.0.0, a LAN or a public address. */
export function bindHostAllowed(host: string): boolean {
  const match = IPV4.exec(host.trim());
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((part) => part > 255)) return false;
  if (host.trim() === "127.0.0.1") return true;
  return a === 100 && b >= 64 && b <= 127;
}

/** Ports for the viewer (HTTP and WebSocket) and WebRTC over ICE-TCP. */
export function stackPorts(port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("The signed-in browser port must be 1024 to 65534.");
  return { http: port, rtc: port + 1 };
}

/** Names of one plugin instance's stack; `stackId` is 8 hex characters of a hash of the instance id. */
export function stackNames(stackId: string) {
  if (!STACK_ID.test(stackId)) throw new Error("Unexpected signed-in stack id.");
  const base = `bp-si-${stackId}`;
  return {
    network: `${base}-net`,
    publicNetwork: `${base}-pub`,
    proxy: `${base}-proxy`,
    neko: `${base}-neko`,
    relay: `${base}-relay`,
    volume: `${base}-profile`,
  };
}

function checkServerImage(image: string) {
  if (!image.startsWith(`${IMAGE_REPOSITORY}:`) || image.endsWith(":latest")) throw new Error("Only the pinned Server browser image.");
}
function checkSignedInImage(image: string) {
  if (!image.startsWith(`${SIGNED_IN_IMAGE_REPOSITORY}:`) || image.endsWith(":latest")) throw new Error("Only the pinned signed-in browser image.");
}

export interface StackInput {
  stackId: string;
  instance: string;
  /** The Server browser image (proxy, relay and the run's MCP). */
  serverImage: string;
  /** The signed-in (neko) image. */
  nekoImage: string;
  /** Host path of the seccomp profile (Playwright's pinned one). */
  seccompProfile: string;
  /** The host's own addresses, refused by the proxy. */
  blockedIps: readonly string[];
  /** Where the relay is published: 127.0.0.1 or this host's Tailscale address. */
  bindHost: string;
  port: number;
  /** Origins the viewer is opened from (http://<bind>:<port>, and the optional https base). */
  origins: readonly string[];
  /** neko runs the Bitwarden variant: the relay then keeps the run paused after a takeover until the vault is locked. */
  bitwarden?: boolean;
}

const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

function stackLabels(input: { instance: string }, role: string): string[] {
  return ["--label", `${STACK_LABEL}=${role}`, "--label", `${INSTANCE_LABEL}=${safeInstanceId(input.instance)}`];
}

/** `docker network create` for the stack's internal network (no route out) and its outward one (relay and proxy). */
export function stackNetworkArgs(input: StackInput) {
  const names = stackNames(input.stackId);
  return {
    internal: ["network", "create", "--internal", "--driver", "bridge", ...stackLabels(input, "network"), names.network],
    public: ["network", "create", "--driver", "bridge", ...stackLabels(input, "public-network"), names.publicNetwork],
  };
}

/** `docker volume create` for the owner's Chromium profile (cookies, logins, history). */
export function stackVolumeArgs(input: StackInput): string[] {
  return ["volume", "create", ...stackLabels(input, "profile"), stackNames(input.stackId).volume];
}

/** Placeholder the daemon fills in with the internal network's subnet (proxy clients, the relay's control listener). */
export const STACK_SUBNET_PLACEHOLDER = "__BP_SUBNET__";

/**
 * The proxy sidecar: the same filter as a Server browser run's (no tailnet, private, loopback or
 * host addresses), on the stack's outward network and connected to its internal one, accepting
 * clients only from the internal network.
 */
export function stackProxyArgs(input: StackInput): string[] {
  checkServerImage(input.serverImage);
  const ips = input.blockedIps.filter((ip) => IP_TEXT.test(ip));
  return [
    "run",
    "-d",
    "--init",
    "--pull",
    "never",
    "--name",
    stackNames(input.stackId).proxy,
    ...stackLabels(input, "proxy"),
    "--network",
    stackNames(input.stackId).publicNetwork,
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
    "signed-in-proxy",
    "--env",
    `BP_BLOCKED_IPS=${ips.join(",")}`,
    "--env",
    `BP_ALLOW_CLIENTS=${STACK_SUBNET_PLACEHOLDER}`,
    "--env",
    `BP_PROXY_PORT=${PROXY_PORT}`,
    "--env",
    `BP_MAX_LIFETIME_S=${STACK_MAX_LIFETIME_S}`,
    "--log-driver",
    "none",
    "--stop-timeout",
    "2",
    "--entrypoint",
    "node",
    input.serverImage,
    "/opt/browser-prompt/proxy-main.mjs",
  ];
}

/** Secrets for one start of the stack: neko's passwords (never shown to anyone), the relay's keys. */
export interface StackSecrets {
  nekoUserPassword: string;
  nekoAdminPassword: string;
  viewerSecret: string;
  statusToken: string;
}

/**
 * neko with the owner's profile: on the internal network only (its Chromium reaches the web only
 * through the proxy, loopback included), every capability dropped except the four its supervisor
 * and Chromium's sandbox need, no new privileges, Playwright's seccomp profile, read-only root with
 * tmpfs for what it writes, the profile on its named volume, limits, no log, never pulls.
 */
export function stackNekoArgs(input: StackInput, secrets: StackSecrets): string[] {
  checkSignedInImage(input.nekoImage);
  if (!input.seccompProfile.startsWith("/") || /[,\s]/.test(input.seccompProfile)) throw new Error("The seccomp profile needs an absolute path.");
  if (!bindHostAllowed(input.bindHost)) throw new Error("The signed-in browser binds only 127.0.0.1 or this host's Tailscale address.");
  const names = stackNames(input.stackId);
  const ports = stackPorts(input.port);
  const owned = "uid=1000,gid=1000,mode=0700";
  return [
    "run",
    "-d",
    "--pull",
    "never",
    "--name",
    names.neko,
    ...stackLabels(input, "neko"),
    "--network",
    names.network,
    "--hostname",
    "signed-in-browser",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "SYS_CHROOT",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${input.seccompProfile}`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,size=512m",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=16m",
    "--tmpfs",
    "/var/run:rw,nosuid,nodev,size=16m",
    "--tmpfs",
    "/var/log/neko:rw,nosuid,nodev,size=64m",
    "--tmpfs",
    `/home/neko/.cache:rw,nosuid,nodev,size=512m,${owned}`,
    "--tmpfs",
    `/home/neko/.config/pulse:rw,nosuid,nodev,size=8m,${owned}`,
    "--tmpfs",
    `/home/neko/.local:rw,nosuid,nodev,size=64m,${owned}`,
    "--tmpfs",
    `/home/neko/Downloads:rw,nosuid,nodev,noexec,size=8m,${owned}`,
    "--mount",
    `type=volume,source=${names.volume},target=/home/neko/.config/chromium`,
    "--shm-size",
    NEKO_LIMITS.shm,
    "--memory",
    NEKO_LIMITS.memory,
    "--memory-swap",
    NEKO_LIMITS.memory,
    "--cpus",
    NEKO_LIMITS.cpus,
    "--pids-limit",
    String(NEKO_LIMITS.pids),
    "--env",
    "NEKO_MEMBER_PROVIDER=multiuser",
    "--env",
    `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${secrets.nekoUserPassword}`,
    "--env",
    `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${secrets.nekoAdminPassword}`,
    "--env",
    "NEKO_SESSION_COOKIE_ENABLED=false",
    "--env",
    "NEKO_SESSION_IMPLICIT_HOSTING=false",
    "--env",
    "NEKO_SESSION_MERCIFUL_RECONNECT=true",
    "--env",
    "NEKO_SERVER_METRICS=false",
    "--env",
    "NEKO_SERVER_PPROF=false",
    "--env",
    "NEKO_PLUGINS_ENABLED=false",
    "--env",
    "NEKO_FILETRANSFER_ENABLED=false",
    "--env",
    "NEKO_DESKTOP_UPLOAD_DROP=false",
    "--env",
    `NEKO_DESKTOP_SCREEN=${SCREEN_LANDSCAPE}`,
    "--env",
    `NEKO_WEBRTC_TCPMUX=${ports.rtc}`,
    "--env",
    `NEKO_WEBRTC_NAT1TO1=${input.bindHost}`,
    // No STUN or TURN servers (neko 3.2.0's default too, pinned here): the viewer gets only the
    // ICE-TCP candidate on the bind address, nothing goes to a public STUN server.
    "--env",
    "NEKO_WEBRTC_ICESERVERS_FRONTEND=[]",
    "--env",
    "NEKO_WEBRTC_ICESERVERS_BACKEND=[]",
    // By name (Docker's DNS on the internal network), so a replaced proxy is found again.
    "--env",
    `BP_PROXY=http://${names.proxy}:${PROXY_PORT}`,
    "--log-driver",
    "none",
    "--stop-timeout",
    "30",
    input.nekoImage,
  ];
}

/**
 * The relay: the only published container, on the stack's outward network (the daemon connects it
 * to the internal one to reach neko). Published only on the bind address. Same hardening as the
 * proxy.
 */
export function stackRelayArgs(input: StackInput, secrets: StackSecrets): string[] {
  checkServerImage(input.serverImage);
  if (!bindHostAllowed(input.bindHost)) throw new Error("The signed-in browser binds only 127.0.0.1 or this host's Tailscale address.");
  const names = stackNames(input.stackId);
  const ports = stackPorts(input.port);
  const origins = input.origins.filter((origin) => /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin));
  return [
    "run",
    "-d",
    "--init",
    "--pull",
    "never",
    "--name",
    names.relay,
    ...stackLabels(input, "relay"),
    "--network",
    names.publicNetwork,
    "--publish",
    `${input.bindHost}:${ports.http}:8080/tcp`,
    "--publish",
    `${input.bindHost}:${ports.rtc}:${ports.rtc}/tcp`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${RELAY_LIMITS.tmpfs}`,
    "--memory",
    RELAY_LIMITS.memory,
    "--memory-swap",
    RELAY_LIMITS.memory,
    "--cpus",
    RELAY_LIMITS.cpus,
    "--pids-limit",
    String(RELAY_LIMITS.pids),
    "--user",
    "pwuser",
    "--workdir",
    "/tmp",
    "--hostname",
    "signed-in-relay",
    "--env",
    `BP_NEKO_HOST=${names.neko}`,
    "--env",
    "BP_NEKO_PORT=8080",
    "--env",
    "BP_LISTEN_PORT=8080",
    "--env",
    `BP_RTC_PORT=${ports.rtc}`,
    "--env",
    `BP_PUBLIC_ORIGINS=${origins.join(",")}`,
    "--env",
    `BP_VIEWER_SECRET=${secrets.viewerSecret}`,
    "--env",
    `BP_STATUS_TOKEN=${secrets.statusToken}`,
    "--env",
    `BP_NEKO_ADMIN_PASSWORD=${secrets.nekoAdminPassword}`,
    "--env",
    `BP_SCREEN_LANDSCAPE=${SCREEN_LANDSCAPE}`,
    "--env",
    `BP_SCREEN_PORTRAIT=${SCREEN_PORTRAIT}`,
    "--env",
    `BP_CONTROL_PORT=${CONTROL_PORT}`,
    "--env",
    `BP_CONTROL_SUBNET=${STACK_SUBNET_PLACEHOLDER}`,
    "--env",
    `BP_MAX_LIFETIME_S=${STACK_MAX_LIFETIME_S}`,
    ...(input.bitwarden ? ["--env", "BP_LOCK_ON_RELEASE=1"] : []),
    "--log-driver",
    "none",
    "--stop-timeout",
    "2",
    "--entrypoint",
    "node",
    input.serverImage,
    "/opt/browser-prompt/relay-main.mjs",
  ];
}

/** Flags that would reach the host or lift the isolation; never in a stack command. */
const FORBIDDEN_STACK_FLAGS = new Set([
  "-v",
  "--volume",
  "--volumes-from",
  "--privileged",
  "--device",
  "--device-cgroup-rule",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
  "-P",
  "--publish-all",
  "--add-host",
  "--gpus",
  "-p",
]);
const ALLOWED_CAPS: Record<string, readonly string[]> = { neko: ["SETUID", "SETGID", "CHOWN", "SYS_CHROOT"], relay: [], proxy: [] };

function flagPairs(args: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) pairs.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else pairs.push([arg, args[i + 1] ?? ""]);
  }
  return pairs;
}

/**
 * Checks a stack `docker run` before the daemon runs it (defense in depth; the functions above build
 * them): no forbidden flag, read-only root, every capability dropped (only neko adds its four), no
 * new privileges, no unconfined profile, the expected network, a pinned image, the profile volume
 * only on neko and only at the profile path, and published ports only on the relay, only on the bind
 * address, and only the stack's two ports.
 */
export function checkStackRun(args: readonly string[], role: "proxy" | "neko" | "relay", input: StackInput): readonly string[] {
  const names = stackNames(input.stackId);
  const pairs = flagPairs(args);
  const values = (flag: string) => pairs.filter(([name]) => name === flag).map(([, value]) => value);
  for (const [name] of pairs) if (FORBIDDEN_STACK_FLAGS.has(name)) throw new Error(`${role}: ${name} is not allowed`);
  if (args[0] !== "run") throw new Error(`${role}: not a run`);
  if (!args.includes("--read-only")) throw new Error(`${role}: --read-only is required`);
  if (!values("--cap-drop").includes("ALL")) throw new Error(`${role}: --cap-drop ALL is required`);
  const added = values("--cap-add").map((cap) => cap.toUpperCase().replace(/^CAP_/, ""));
  if (added.some((cap) => !ALLOWED_CAPS[role]!.includes(cap))) throw new Error(`${role}: capability not allowed`);
  const opts = values("--security-opt");
  if (!opts.includes("no-new-privileges")) throw new Error(`${role}: no-new-privileges is required`);
  if (opts.some((opt) => /unconfined/i.test(opt) || /^apparmor[=:]/i.test(opt) || /^label[=:]disable/i.test(opt) || /^systempaths/i.test(opt))) {
    throw new Error(`${role}: security option not allowed`);
  }
  const network = [...values("--network"), ...values("--net")];
  const expected = role === "neko" ? names.network : names.publicNetwork;
  if (network.length !== 1 || network[0] !== expected) throw new Error(`${role}: network must be ${expected}`);
  const mounts = values("--mount");
  if (role === "neko") {
    if (mounts.length !== 1 || mounts[0] !== `type=volume,source=${names.volume},target=/home/neko/.config/chromium`) throw new Error("neko: only the profile volume");
  } else if (mounts.length > 0) throw new Error(`${role}: no mounts`);
  const published = values("--publish");
  if (role === "relay") {
    const ports = stackPorts(input.port);
    const allowed = [`${input.bindHost}:${ports.http}:8080/tcp`, `${input.bindHost}:${ports.rtc}:${ports.rtc}/tcp`];
    if (!bindHostAllowed(input.bindHost) || published.length !== 2 || published.some((value) => !allowed.includes(value))) throw new Error("relay: ports only on the bind address");
  } else if (published.length > 0) throw new Error(`${role}: no published ports`);
  const image = role === "neko" ? args.at(-1)! : args.at(-2)!;
  if (role === "neko") checkSignedInImage(image);
  else checkServerImage(image);
  return args;
}

/** One signed-in run's MCP container: in neko's network namespace, attached to the DevTools port only. */
export interface SignedInAgentInput {
  stackId: string;
  instance: string;
  serverImage: string;
  agentId: string;
  nonce: string;
  blockedIps: readonly string[];
}

/** `bp-sa-<agent id>-<nonce>`. */
export function signedInAgentName(agentId: string, nonce: string): string {
  const id = safeAgentId(agentId).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 36);
  const suffix = nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "0";
  return `bp-sa-${id}-${suffix}`;
}

export const SIGNED_IN_CDP_ENDPOINT = "http://127.0.0.1:9222";
/** The relay's unpublished takeover-state port (GET /control), on the stack's networks only. */
export const CONTROL_PORT = 8081;
export function controlUrl(stackId: string): string {
  return `http://${stackNames(stackId).relay}:${CONTROL_PORT}/control`;
}

/**
 * `docker run -i` for a signed-in run's Playwright MCP: in neko's network namespace (so the
 * DevTools port on neko's loopback is reachable, and nothing else is new), every capability dropped,
 * no new privileges, read-only root, unprivileged user, limits, no log, never pulls, `--rm --init`.
 * Swept like a Server browser's container when its launcher is gone.
 */
export function signedInAgentArgs(input: SignedInAgentInput): string[] {
  checkServerImage(input.serverImage);
  const names = stackNames(input.stackId);
  const ips = input.blockedIps.filter((ip) => IP_TEXT.test(ip));
  const name = signedInAgentName(input.agentId, input.nonce);
  return [
    "run",
    "-i",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    `${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`,
    "--label",
    `${CONTAINER_AGENT_LABEL}=${safeAgentId(input.agentId)}`,
    "--label",
    `${SESSION_LABEL}=${name}`,
    "--label",
    `${LAUNCHER_PID_LABEL}=${PID_PLACEHOLDER}`,
    "--label",
    `${INSTANCE_LABEL}=${safeInstanceId(input.instance)}`,
    "--label",
    `${CREATED_LABEL}=${CREATED_PLACEHOLDER}`,
    "--network",
    `container:${names.neko}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${SIGNED_IN_AGENT_LIMITS.tmpfs}`,
    "--memory",
    SIGNED_IN_AGENT_LIMITS.memory,
    "--memory-swap",
    SIGNED_IN_AGENT_LIMITS.memory,
    "--cpus",
    SIGNED_IN_AGENT_LIMITS.cpus,
    "--pids-limit",
    String(SIGNED_IN_AGENT_LIMITS.pids),
    "--user",
    "pwuser",
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp/home",
    "--env",
    `BP_CDP_ENDPOINT=${SIGNED_IN_CDP_ENDPOINT}`,
    "--env",
    `BP_CONTROL_URL=${controlUrl(input.stackId)}`,
    "--env",
    `BP_BLOCKED_IPS=${ips.join(",")}`,
    "--env",
    `BP_MAX_LIFETIME_S=${CONTAINER_LIMITS.maxLifetimeSeconds}`,
    "--env",
    `BP_IDLE_TIMEOUT_S=${CONTAINER_LIMITS.idleTimeoutSeconds}`,
    "--log-driver",
    "none",
    "--stop-timeout",
    "5",
    input.serverImage,
  ];
}

export interface SignedInPlan {
  kind: "signed-in";
  docker: string;
  neko: string;
  agent: { name: string; run: string[] };
}

export function signedInPlan(docker: string, input: SignedInAgentInput): SignedInPlan {
  if (!docker.startsWith("/")) throw new Error("docker must be an absolute path");
  return {
    kind: "signed-in",
    docker,
    neko: stackNames(input.stackId).neko,
    agent: { name: signedInAgentName(input.agentId, input.nonce), run: signedInAgentArgs(input) },
  };
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The MCP server a signed-in run gets: `node launch.mjs <plan>` over stdio. */
export function signedInMcpServer(node: string, launcher: string, plan: SignedInPlan, dockerHost?: string | null): StdioServer {
  return { type: "stdio", command: node, args: [launcher, base64Json(plan)], ...(dockerHost ? { env: { DOCKER_HOST: dockerHost } } : {}) };
}

/** Labels that mark a run as a signed-in run, with its launch ticket. */
export function signedInRunLabels(ticket: string): Record<string, string> {
  return { [BROWSER_LABEL]: SIGNED_IN_LABEL_VALUE, [TICKET_LABEL]: ticket };
}

export function isSignedInRun(labels: Record<string, unknown> | null | undefined): boolean {
  return !!labels && labels[BROWSER_LABEL] === SIGNED_IN_LABEL_VALUE;
}

/** `https://host[:port]` without a path: the optional base for the viewer behind `tailscale serve`. Error text or null. */
export function validateHttpsBase(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(text)) return "Enter https://<name>[:port] without a path, for example https://my-server.tailnet-name.ts.net:8443, or leave empty.";
  return null;
}

/** The viewer's origins: `http://<bind>:<port>`, plus the https base when set. */
export function viewerOrigins(bindHost: string, port: number, httpsBase: string): string[] {
  const out = [`http://${bindHost}:${stackPorts(port).http}`];
  const base = httpsBase.trim().replace(/\/$/, "");
  if (base && validateHttpsBase(base) === null) out.push(base.toLowerCase());
  return out;
}

/** The link that opens the viewer: the ticket only in the fragment (never sent to a server, never logged). */
export function viewerLink(origin: string, ticket: string, portrait: boolean): string {
  return `${origin}/bp/open#t=${encodeURIComponent(ticket)}${portrait ? "&p=1" : ""}`;
}

/** Whether the idle stack should stop now: no run, no viewer, and IDLE_STOP_MS since the last use. */
export function shouldStopForIdle(input: { now: number; lastActive: number; agentRunning: boolean; viewers: number; viewerIdleMs: number | null }): boolean {
  if (input.agentRunning || input.viewers > 0) return false;
  if (input.viewerIdleMs !== null && input.viewerIdleMs < Math.max(IDLE_STOP_MS, MIN_UP_AFTER_VIEWER_MS)) return false;
  return input.now - input.lastActive >= IDLE_STOP_MS;
}

export const SIGNED_IN_STATES = [
  "ready",
  "running",
  "starting",
  "busy",
  "building",
  "no-image",
  "build-failed",
  "no-address",
  "docker-missing",
  "docker-unavailable",
  "unsupported",
  "failed",
] as const;
export type SignedInState = (typeof SIGNED_IN_STATES)[number];

export const SIGNED_IN_STATE_MESSAGES: Record<SignedInState, string> = {
  ready: "Ready (stopped; it starts when a run or the viewer needs it).",
  running: "Running.",
  starting: "The signed-in browser is starting on the server; try again in a few seconds.",
  busy: "The signed-in browser is in use by another run (one run at a time shares your logins). Wait until that run ends, or stop it, then try again.",
  building: "The signed-in browser images are being downloaded and built on the server (a few minutes). Try again when Settings shows them ready.",
  "no-image": "The signed-in browser is not set up on this server yet. Set it up once in the plugin settings (Signed-in Server browser → Download and build), then try again.",
  "build-failed": "Building the signed-in browser image failed. See the plugin settings, fix the cause and build again.",
  "no-address": "The signed-in browser needs this server's Tailscale address (or the launcher's bind address 127.0.0.1) for its viewer, and none was found.",
  "docker-missing": "The signed-in browser needs Docker on the Paseo server, and the docker command was not found there.",
  "docker-unavailable": "The signed-in browser needs Docker on the Paseo server, and Docker is not reachable there (is the rootless Docker service running?).",
  unsupported: "This Paseo version cannot give a run its own browser (no agent session hooks). Update Paseo, or use the Paseo browser.",
  failed: "The signed-in browser could not start. See the plugin settings.",
};
