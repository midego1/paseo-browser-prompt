import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTAINER_LABEL, INSTANCE_LABEL, STARTING_WINDOW_MS, createTicketStore, type StdioServer } from "../shared/server-browser.ts";
import {
  bindHostAllowed,
  checkStackRun,
  IDLE_STOP_MS,
  isLegacyBitwardenImageTag,
  shouldStopForIdle,
  SIGNED_IN_AGENT_ROLE,
  SIGNED_IN_IMAGE_REPOSITORY,
  signedInImageTag,
  signedInMcpServer,
  signedInPlan,
  signedInAgentName,
  STACK_LABEL,
  STACK_SUBNET_PLACEHOLDER,
  stackNames,
  stackNekoArgs,
  stackNetworkArgs,
  stackPorts,
  stackProxyArgs,
  stackRelayArgs,
  stackVolumeArgs,
  viewerLink,
  viewerOrigins,
  VIEWER_TICKET_TTL_S,
  type SignedInState,
  type StackInput,
  type StackSecrets,
} from "../shared/signed-in.ts";
import { admittedAfter, contextHash, execRunner, nextAdmissionSeq, rememberAdmission, shortError, type Admission, type Runner, type ServerBrowser } from "./server-browser.ts";
import { SIGNED_IN_FILES } from "./server-browser-files.ts";
import { stateDir } from "./state-dir.ts";


/**
 * The plugin's viewer key and the relay's status token (kept in the state directory, mode 0600),
 * neko's passwords for the current start, and the salt of the current relay start: the relay only
 * knows a key derived from the viewer key and that salt, so links from before a relay restart are dead.
 */
export interface SignedInKeys extends StackSecrets {
  relaySalt: string;
}

/** The key the relay checks tickets with: HMAC-SHA256(viewer key, "relay:" + salt of this relay start). */
export function relaySecret(keys: Pick<SignedInKeys, "viewerSecret" | "relaySalt">): string {
  return createHmac("sha256", keys.viewerSecret).update(`relay:${keys.relaySalt}`).digest("base64url");
}

/** `v1.<exp>.<nonce>.<purpose>.<hmac>`; the relay (server-browser/relay.mjs) checks it the same way. */
export function signViewerTicket(secret: string, input: { exp: number; nonce: string; purpose: "login" | "takeover" }): string {
  const payload = `v1.${input.exp}.${input.nonce}.${input.purpose}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

const secret = () => randomBytes(32).toString("base64url");

export function newKeys(): SignedInKeys {
  return { viewerSecret: secret(), statusToken: secret(), nekoAdminPassword: secret(), nekoUserPassword: secret(), relaySalt: secret() };
}

function validKeys(value: unknown): value is SignedInKeys {
  const v = value as Record<string, unknown> | null;
  return !!v && ["viewerSecret", "statusToken", "nekoAdminPassword", "nekoUserPassword"].every((key) => typeof v[key] === "string" && (v[key] as string).length >= 32);
}

/** Reads the keys file, or creates it (0600) with fresh keys. */
export async function loadKeys(file: string, fresh = newKeys): Promise<SignedInKeys> {
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    if (validKeys(stored)) {
      if (typeof stored.relaySalt === "string" && stored.relaySalt.length >= 32) return stored;
      const upgraded = { ...stored, relaySalt: secret() };
      await saveKeys(file, upgraded);
      return upgraded;
    }
  } catch {
    // not created yet, or unreadable: make new ones
  }
  const keys = fresh();
  await saveKeys(file, keys);
  return keys;
}

export async function saveKeys(file: string, keys: SignedInKeys): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * GET /bp/status on the relay; null when it does not answer as expected. `lockPending` only comes
 * from a relay started before 0.25.0 with Bitwarden (migration: see legacyRelayCheck).
 */
export type RelayStatus = { viewers: number; idleMs: number; nekoUp: boolean; portrait: boolean; ownerControl?: boolean; lockPending?: boolean; bootId?: string };
export type RelayStatusFetch = (host: string, port: number, token: string) => Promise<RelayStatus | null>;

export const fetchRelayStatus: RelayStatusFetch = (host, port, token) =>
  new Promise((resolve) => {
    const req = httpRequest(
      { host, port, path: "/bp/status", method: "GET", headers: { Authorization: `Bearer ${token}`, Host: `${host}:${port}` }, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({
              viewers: Number(body.viewers) || 0,
              idleMs: Number(body.idleMs) || 0,
              nekoUp: body.nekoUp === true,
              portrait: body.portrait === true,
              ownerControl: body.ownerControl === true,
              lockPending: body.lockPending === true,
              bootId: typeof body.bootId === "string" ? body.bootId.slice(0, 64) : "",
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });

export interface SignedInConfig {
  port: number;
  httpsBaseUrl: string;
}

/** A settings read as the plugin host gives it (index.server.ts), or null when the read threw. */
export type SignedInSettingsRead = { status: string; values?: { port?: unknown; httpsBaseUrl?: unknown } } | null;

/**
 * The daemon's view of the signed-in settings: not ready, invalid or a failed read give the
 * defaults. Keys of earlier versions (0.23.0 to 0.24.x stored `bitwarden` and `bitwardenConsent`)
 * are ignored.
 */
export function signedInConfigFrom(read: SignedInSettingsRead, defaults: { port: number; validHttpsBase: (base: string) => boolean }): SignedInConfig {
  if (read?.status !== "ready" || !read.values) return { port: defaults.port, httpsBaseUrl: "" };
  const v = read.values;
  const base = typeof v.httpsBaseUrl === "string" ? v.httpsBaseUrl.trim() : "";
  return {
    port: typeof v.port === "number" && Number.isInteger(v.port) ? v.port : defaults.port,
    httpsBaseUrl: base && defaults.validHttpsBase(base) ? base : "",
  };
}

export interface SignedInOptions {
  serverBrowser: ServerBrowser;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  files?: Readonly<Record<string, string>>;
  buildRoot?: string;
  keysFile?: string;
  log?: (message: string) => void;
  random?: () => string;
  now?: () => number;
  /** Where the relay is published: this host's Tailscale address (or the launcher's 127.0.0.1); null when none. */
  bindHost: () => Promise<string | null>;
  config: () => Promise<SignedInConfig>;
  relayStatus?: RelayStatusFetch;
  /** Migration: where plugin versions before 0.25.0 kept the Bitwarden signing key (default next to the keys file); removed. */
  legacyBitwardenKeyFile?: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long a start waits for neko to answer through the relay. */
  startTimeoutMs?: number;
  idleCheckMs?: number;
}

export interface SignedInStatus {
  state: SignedInState;
  image: string;
  serverImage: string;
  running: boolean;
  viewers: number;
  busy: boolean;
  bindHost: string | null;
  viewerOrigin: string | null;
  detail: string;
}

const CONFIG_LABEL = "browser-prompt.signed-in-config";

/**
 * The daemon side of the signed-in Server browser: builds its image on the owner's explicit choice,
 * starts the persistent stack on demand (network, proxy, neko with the profile volume, relay), stops
 * it after IDLE_STOP_MS without a run or viewer, gives one run at a time its MCP server, makes viewer
 * links, rotates the viewer key, and logs the owner out of everything by wiping the profile volume.
 */
export function createSignedIn(options: SignedInOptions) {
  const sb = options.serverBrowser;
  const run = options.run ?? execRunner;
  const files = options.files ?? SIGNED_IN_FILES;
  const image = signedInImageTag(contextHash(files));
  const keysFile = options.keysFile ?? join(stateDir(), "signed-in", "keys.json");
  const legacyKeyFile = options.legacyBitwardenKeyFile ?? join(dirname(keysFile), "bitwarden-key.pem");
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const random = options.random ?? (() => randomBytes(16).toString("hex"));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const relayStatus = options.relayStatus ?? fetchRelayStatus;
  const tickets = createTicketStore({ random, now, max: 20 });
  /** Runs admitted by mcpServer whose MCP container may not exist yet: agent id -> until. */
  const starting = new Map<string, number>();
  /** The latest admission of each run: a close event older than it is about an older session. */
  const admissions = new Map<string, Admission>();
  let lastActive = now();
  let building: Promise<void> | null = null;
  let buildError: string | null = null;
  let startError: string | null = null;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let admission: Promise<unknown> = Promise.resolve();
  /** Check and claim of the one run slot, one at a time (concurrent presses cannot both get it). */
  function admit<T>(task: () => Promise<T>): Promise<T> {
    const next = admission.then(task, task);
    admission = next.catch(() => undefined);
    return next;
  }
  let startingStack = false;

  /** Runs one stack change at a time (start, stop, wipe, key rotation). */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = lifecycle.then(task, task);
    lifecycle = next.catch(() => undefined);
    return next;
  }

  async function stackId(): Promise<string> {
    return createHash("sha256").update(await sb.instance()).digest("hex").slice(0, 8);
  }

  async function docker(args: string[], timeoutMs = 60_000) {
    const { path, host } = await sb.docker();
    if (!path) throw new Error("docker not found");
    return run(path, args, { timeoutMs, env: sb.dockerEnv(host) });
  }

  async function mustDocker(step: string, args: string[], timeoutMs?: number) {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new Error(`${step}: ${shortError(result.stderr || result.stdout || result.failure || "failed")}`);
    return result.stdout;
  }

  async function imageExists(tag: string): Promise<boolean> {
    return (await docker(["image", "inspect", "--format", "{{.Id}}", tag], 15_000).catch(() => ({ code: 1 }))).code === 0;
  }

  /** `name -> state` of this instance's stack containers. */
  async function stackContainers(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const result = await docker(["ps", "-a", "--filter", `label=${STACK_LABEL}`, "--filter", `label=${INSTANCE_LABEL}=${await sb.instance()}`, "--format", "{{.Names}}\t{{.State}}"], 15_000);
    if (result.code !== 0) throw new Error("docker ps failed");
    for (const line of result.stdout.split("\n")) {
      const [name, state] = line.trim().split("\t");
      if (name) out.set(name, state ?? "");
    }
    return out;
  }

  /** Signed-in MCP containers of this instance: agent ids. */
  async function agentContainers(): Promise<string[]> {
    const rows = await sb.listResources("container", [`label=${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`, `label=${INSTANCE_LABEL}=${await sb.instance()}`], ["browser-prompt.agent"]);
    return rows.map(([, agent]) => agent!).filter(Boolean);
  }

  /** Runs holding the signed-in browser: an MCP container, admitted recently, or about to start (ticket). */
  async function holders(except?: string): Promise<number> {
    const agents = new Set(await agentContainers());
    const t = now();
    for (const [agent, until] of starting) {
      if (until <= t || agents.has(agent)) starting.delete(agent);
      else agents.add(agent);
    }
    if (except) agents.delete(except);
    return agents.size + tickets.pending();
  }

  async function stackInput(bindHost: string): Promise<StackInput> {
    const config = await options.config();
    const runtime = await sb.runtime();
    return {
      stackId: await stackId(),
      instance: await sb.instance(),
      serverImage: sb.image,
      nekoImage: image,
      seccompProfile: runtime.seccomp,
      blockedIps: sb.blockedIps(),
      bindHost,
      port: config.port,
      origins: viewerOrigins(bindHost, config.port, config.httpsBaseUrl),
    };
  }

  function configTag(input: StackInput): string {
    return createHash("sha256")
      .update(`${input.bindHost}|${input.port}|${input.origins.join(",")}|${input.nekoImage}|${sb.image}`)
      .digest("hex")
      .slice(0, 16);
  }

  async function relayAnswer(input: StackInput, keys: SignedInKeys): Promise<RelayStatus | null> {
    return relayStatus(input.bindHost, stackPorts(input.port).http, keys.statusToken);
  }

  /**
   * Removes the stack's containers and networks (never the volume). neko first and, unless the
   * profile is about to be wiped, gracefully: Chromium writes its cookies on the way out (up to 45 s).
   */
  async function removeStack(input: { stackId: string }, graceful = true): Promise<void> {
    const names = stackNames(input.stackId);
    if (graceful) await docker(["stop", "-t", "45", names.neko], 90_000).catch(() => undefined);
    await docker(["rm", "-f", names.relay, names.neko, names.proxy], 60_000).catch(() => undefined);
    await docker(["network", "rm", names.network], 30_000).catch(() => undefined);
    await docker(["network", "rm", names.publicNetwork], 30_000).catch(() => undefined);
  }

  async function internalSubnet(input: { stackId: string }): Promise<string> {
    const text = await mustDocker("reading the internal network", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", stackNames(input.stackId).network]);
    const subnet = text.split(/\s+/).find((cidr) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(cidr));
    if (!subnet) throw new Error("reading the internal network: no IPv4 subnet");
    return subnet;
  }

  async function startProxy(input: StackInput, subnet: string): Promise<void> {
    const names = stackNames(input.stackId);
    const proxy = stackProxyArgs(input).map((arg) => arg.split(STACK_SUBNET_PLACEHOLDER).join(subnet));
    checkStackRun(proxy, "proxy", input);
    await mustDocker("starting the proxy", proxy);
    await mustDocker("connecting the proxy", ["network", "connect", names.network, names.proxy]);
  }

  /** Starts the relay with a new salt: tickets signed for an earlier relay start no longer work. */
  async function startRelay(input: StackInput, current: SignedInKeys): Promise<SignedInKeys> {
    const names = stackNames(input.stackId);
    const keys = { ...current, relaySalt: secret() };
    await saveKeys(keysFile, keys);
    const subnet = await internalSubnet(input);
    const args = stackRelayArgs(input, { ...keys, viewerSecret: relaySecret(keys) }).map((arg) => arg.split(STACK_SUBNET_PLACEHOLDER).join(subnet));
    // The relay carries the configuration it was started with, so a changed address or port restarts it.
    const withTag = [...args.slice(0, -4), "--label", `${CONFIG_LABEL}=${configTag(input)}`, ...args.slice(-4)];
    checkStackRun(withTag, "relay", input);
    await mustDocker("starting the relay", withTag);
    await mustDocker("connecting the relay", ["network", "connect", names.network, names.relay]);
    return keys;
  }

  async function waitForNeko(input: StackInput, keys: SignedInKeys): Promise<void> {
    const until = now() + (options.startTimeoutMs ?? 90_000);
    while (now() < until) {
      const answer = await relayAnswer(input, keys);
      if (answer?.nekoUp) return;
      await sleep(1500);
    }
    throw new Error("the signed-in browser did not come up in time");
  }

  async function createStack(input: StackInput): Promise<void> {
    log("starting the signed-in browser");
    // Whatever is left of an earlier start goes first; a neko that still runs is stopped gracefully.
    await removeStack(input, true);
    const networks = stackNetworkArgs(input);
    await mustDocker("creating the internal network", networks.internal);
    await mustDocker("creating the outward network", networks.public);
    const subnet = await internalSubnet(input);
    await mustDocker("creating the profile volume", stackVolumeArgs(input));
    await startProxy(input, subnet);

    // neko's passwords are new on every start; only the relay knows the admin one.
    let keys: SignedInKeys = { ...(await loadKeys(keysFile)), nekoAdminPassword: secret(), nekoUserPassword: secret() };
    await saveKeys(keysFile, keys);
    const neko = stackNekoArgs(input, keys);
    checkStackRun(neko, "neko", input);
    await mustDocker("starting the browser", neko);
    keys = await startRelay(input, keys);
    await waitForNeko(input, keys);
    log("the signed-in browser is running");
  }

  /** Starts the stack unless all of it runs with the current configuration; returns the bind host and port. */
  async function ensureStarted(): Promise<{ input: StackInput }> {
    return serial(async () => {
      const bindHost = await options.bindHost();
      if (!bindHost || !bindHostAllowed(bindHost)) throw Object.assign(new Error("no Tailscale address for the viewer"), { state: "no-address" as const });
      let input = await stackInput(bindHost);
      const names = stackNames(input.stackId);
      let containers = await stackContainers();
      // neko runs but its proxy or relay stopped (their 7-day lifetime, a crash): start only those;
      // neko and the owner's sessions stay as they are.
      if (containers.get(names.neko) === "running" && (containers.get(names.proxy) !== "running" || containers.get(names.relay) !== "running")) {
        try {
          if (containers.get(names.proxy) !== "running") {
            await docker(["rm", "-f", names.proxy], 30_000).catch(() => undefined);
            await startProxy(input, await internalSubnet(input));
          }
          if (containers.get(names.relay) !== "running") {
            await docker(["rm", "-f", names.relay], 30_000).catch(() => undefined);
            await waitForNeko(input, await startRelay(input, await loadKeys(keysFile)));
          }
          log("restarted the signed-in browser's proxy or relay");
        } catch (error) {
          log(`could not restart the proxy or relay: ${error instanceof Error ? error.message : String(error)}`);
        }
        containers = await stackContainers();
      }
      let allRunning = [names.neko, names.relay, names.proxy].every((name) => containers.get(name) === "running");
      if (allRunning) {
        // A plugin update changed the image: neko starts again with the new one, but never under a
        // run (it would lose its browser); that run's next start or the idle check does it.
        const running = (await docker(["inspect", "--format", "{{.Config.Image}}", names.neko], 15_000)).stdout.trim();
        if (running && running !== input.nekoImage) {
          // Never while a viewer is connected either (the owner would lose the browser mid-use),
          // except for an image with Bitwarden from before 0.25.0: it goes as soon as no run holds it.
          const legacy = isLegacyBitwardenImageTag(running);
          const viewers = legacy ? 0 : ((await relayAnswer(input, await loadKeys(keysFile)))?.viewers ?? 0);
          if ((await holders().catch(() => 1)) === 0 && viewers === 0) {
            log(legacy ? "starting the signed-in browser again without Bitwarden (removed in 0.25.0; logins kept)" : "starting the signed-in browser again with its new image");
            allRunning = false;
          } else {
            // Keep what runs, and a relay that matches it.
            input = { ...input, nekoImage: running };
          }
        }
      }
      if (allRunning) {
        const tag = (await docker(["inspect", "--format", `{{index .Config.Labels "${CONFIG_LABEL}"}}`, names.relay], 15_000)).stdout.trim();
        const keys = await loadKeys(keysFile);
        if (tag === configTag(input) && (await relayAnswer(input, keys))?.nekoUp) {
          lastActive = now();
          return { input };
        }
        if (tag !== configTag(input)) {
          // Only the relay holds the address and port: restart it alone, neko keeps running.
          await docker(["rm", "-f", names.relay], 30_000).catch(() => undefined);
          await waitForNeko(input, await startRelay(input, keys));
          lastActive = now();
          return { input };
        }
      }
      startingStack = true;
      try {
        await createStack(input);
        startError = null;
        // What plugin versions before 0.25.0 left for Bitwarden (best effort, never fails the start).
        void removeLegacyBitwarden();
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
        log(`the signed-in browser could not start: ${startError}`);
        await removeStack(input, true);
        throw error;
      } finally {
        startingStack = false;
      }
      lastActive = now();
      return { input };
    });
  }

  async function isRunning(): Promise<boolean> {
    try {
      const names = stackNames(await stackId());
      const containers = await stackContainers();
      return [names.neko, names.relay, names.proxy].every((name) => containers.get(name) === "running");
    } catch {
      return false;
    }
  }

  async function build(): Promise<void> {
    const { path, host } = await sb.docker();
    if (!path) throw new Error("docker not found");
    const dir = join(options.buildRoot ?? join(stateDir(), "signed-in"), image.split(":")[1]!);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    log(`building the signed-in browser image ${image}`);
    const result = await run(path, ["build", "--label", `${STACK_LABEL}=image`, "-t", image, dir], { timeoutMs: 30 * 60_000, env: sb.dockerEnv(host) });
    if (result.code !== 0) throw new Error(shortError(result.stderr || result.stdout || result.failure || "build failed"));
    log(`built the signed-in browser image ${image}`);
  }

  function startBuild(): void {
    if (building) return;
    buildError = null;
    building = build()
      .catch((error: unknown) => {
        buildError = error instanceof Error ? error.message : String(error);
        log(`building the signed-in browser image failed: ${buildError}`);
      })
      .finally(() => {
        building = null;
      });
  }

  async function status(input: { build?: boolean } = {}): Promise<SignedInStatus> {
    const base = await sb.status({ build: input.build });
    const bindHost = await options.bindHost().catch(() => null);
    const config = await options.config();
    const origin = bindHost && bindHostAllowed(bindHost) ? viewerOrigins(bindHost, config.port, config.httpsBaseUrl).at(-1)! : null;
    const common = { image, serverImage: sb.image, bindHost, viewerOrigin: origin };
    const off = (state: SignedInState, detail = "") => ({ state, ...common, running: false, viewers: 0, busy: false, detail });
    if (base.state === "docker-missing" || base.state === "docker-unavailable" || base.state === "unsupported") return off(base.state, base.detail);
    let own = await imageExists(image);
    if (!own && input.build) {
      startBuild();
      own = false;
    }
    if (base.state === "building" || building) return off("building");
    if (base.state === "build-failed") return off("build-failed", base.detail);
    if (!own && buildError) return off("build-failed", buildError);
    if (base.state === "no-image" || !own) return off("no-image");
    if (!origin) return off("no-address");
    if (startingStack) return off("starting");
    const running = await isRunning();
    let viewers = 0;
    if (running) {
      const keys = await loadKeys(keysFile);
      const relay = await relayStatus(bindHost!, stackPorts(config.port).http, keys.statusToken);
      viewers = relay?.viewers ?? 0;
    }
    const busy = (await holders().catch(() => 0)) > 0;
    if (!running && startError) return off("failed", startError);
    return { state: running ? "running" : "ready", ...common, running, viewers, busy, detail: "" };
  }

  /** A ready stack, or why not; never builds. */
  async function readyForUse(): Promise<{ ok: true; input: StackInput } | { ok: false; state: SignedInState; detail: string }> {
    const current = await status();
    if (!["ready", "running", "failed"].includes(current.state)) return { ok: false, state: current.state, detail: current.detail };
    try {
      const started = await ensureStarted();
      return { ok: true, ...started };
    } catch (error) {
      const state = (error as { state?: SignedInState }).state ?? "failed";
      return { ok: false, state, detail: state === "failed" ? shortError(error instanceof Error ? error.message : String(error)) : "" };
    }
  }

  async function makeLink(input: StackInput, purpose: "login" | "takeover", portrait: boolean): Promise<string> {
    const keys = await loadKeys(keysFile);
    const ticket = signViewerTicket(relaySecret(keys), { exp: Math.floor(now() / 1000) + VIEWER_TICKET_TTL_S, nonce: randomBytes(18).toString("base64url"), purpose });
    return viewerLink(input.origins.at(-1)!, ticket, portrait);
  }

  async function stopStack(wipe: boolean): Promise<void> {
    await serial(async () => {
      const id = await stackId();
      // Runs lose the browser: their MCP containers go first.
      const agents = await sb.listResources("container", [`label=${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`, `label=${INSTANCE_LABEL}=${await sb.instance()}`], []).catch(() => []);
      if (agents.length) await docker(["rm", "-f", ...agents.map(([cid]) => cid!)], 30_000).catch(() => undefined);
      // Those runs no longer hold the browser, also the ones admitted but not up yet.
      starting.clear();
      await removeStack({ stackId: id }, !wipe);
      if (wipe) {
        const result = await docker(["volume", "rm", stackNames(id).volume], 60_000);
        if (result.code !== 0 && !/no such volume/i.test(result.stderr)) throw new Error(`removing the profile: ${shortError(result.stderr)}`);
        // New keys too: links and viewer sessions from before are dead.
        await saveKeys(keysFile, newKeys());
      }
      startError = null;
      log(wipe ? "logged out of everything: stopped the signed-in browser and removed its profile" : "stopped the signed-in browser");
    });
  }

  /** Stops the stack after IDLE_STOP_MS without a run or a viewer. */
  async function idleCheck(): Promise<boolean> {
    if (!(await isRunning())) {
      // neko up but its proxy or relay gone: repair (ensureStarted restarts only those).
      const names = stackNames(await stackId());
      const containers = await stackContainers().catch(() => new Map<string, string>());
      if (containers.get(names.neko) === "running") await ensureStarted().catch(() => undefined);
      return false;
    }
    void removeLegacyBitwarden();
    if (await legacyRelayCheck()) return false;
    const agentRunning = (await holders().catch(() => 1)) > 0;
    const config = await options.config();
    // The running browser has an older image (a plugin update while a run held it): start it again
    // with the current one once no run holds it (ensureStarted also waits for viewers to leave).
    if (!agentRunning) {
      const current = await runningNekoImage();
      if (current && current !== image) {
        await ensureStarted().catch(() => undefined);
        return false;
      }
    }
    const bindHost = await options.bindHost().catch(() => null);
    const keys = await loadKeys(keysFile);
    const relay = bindHost ? await relayStatus(bindHost, stackPorts(config.port).http, keys.statusToken) : null;
    const viewers = relay?.viewers ?? 0;
    if (agentRunning || viewers > 0) lastActive = now();
    else if (relay) lastActive = Math.max(lastActive, now() - relay.idleMs);
    if (!shouldStopForIdle({ now: now(), lastActive, agentRunning, viewers, viewerIdleMs: relay ? relay.idleMs : null })) return false;
    log(`no run or viewer for ${Math.round(IDLE_STOP_MS / 60_000)} minutes`);
    await stopStack(false);
    return true;
  }

  /** The image the running neko was started from ("" when it does not run). */
  async function runningNekoImage(): Promise<string> {
    const names = stackNames(await stackId());
    const result = await docker(["inspect", "--format", "{{.Config.Image}}", names.neko], 15_000).catch(() => ({ code: 1, stdout: "" }));
    return result.code === 0 ? result.stdout.trim() : "";
  }

  /** The relay's status now (null when it does not answer or there is no bind address). */
  async function relayNow(): Promise<RelayStatus | null> {
    const config = await options.config();
    const bindHost = await options.bindHost().catch(() => null);
    if (!bindHost || !bindHostAllowed(bindHost)) return null;
    const keys = await loadKeys(keysFile);
    return relayStatus(bindHost, stackPorts(config.port).http, keys.statusToken);
  }

  /**
   * Migration from before 0.25.0: a relay started with Bitwarden (BP_LOCK_ON_RELEASE) keeps a run
   * paused after every takeover until the daemon confirms a vault lock, which nothing does any more.
   * When the running relay still reports such a pending lock and no viewer is connected, it is
   * started again without it (neko and the owner's logins keep running; the run's guard fails closed
   * across the relay restart as always). With a viewer connected the run stays paused until the
   * viewer leaves; the next check does it then. True when the relay was started again.
   */
  async function legacyRelayCheck(): Promise<boolean> {
    const relay = await relayNow().catch(() => null);
    if (relay?.lockPending !== true || relay.viewers > 0) return false;
    log("the relay still waits for a Bitwarden lock (from before 0.25.0): starting it again without; the browser keeps running");
    await serial(async () => {
      const bindHost = await options.bindHost();
      if (!bindHost || !bindHostAllowed(bindHost) || !(await isRunning())) return;
      const running = await runningNekoImage();
      const input = { ...(await stackInput(bindHost)), ...(running ? { nekoImage: running } : {}) };
      await docker(["rm", "-f", stackNames(input.stackId).relay], 30_000).catch(() => undefined);
      await waitForNeko(input, await startRelay(input, await loadKeys(keysFile)));
    }).catch((error: unknown) => log(`could not start the relay again: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }

  /**
   * Migration from before 0.25.0 (Bitwarden removed), best effort and never throwing: removes the
   * Bitwarden signing key (and any temp file of it) from the state directory, the build contexts of
   * the Bitwarden image variants, and those images themselves (`docker rmi` without force, so an image
   * a container still uses stays until a later check). Done once nothing is left. The Bitwarden data
   * in the browser profile is removed by the image's start script (signed-in/chromium-start.sh).
   */
  let legacyDone = false;
  let legacyRunning: Promise<void> | null = null;
  function removeLegacyBitwarden(): Promise<void> {
    if (legacyDone) return Promise.resolve();
    legacyRunning ??= (async () => {
      try {
        const keyDir = dirname(legacyKeyFile);
        const keyName = legacyKeyFile.slice(keyDir.length + 1);
        for (const name of await readdir(keyDir).catch(() => [] as string[])) {
          if (name === keyName || (name.startsWith(`${keyName}.`) && name.endsWith(".tmp"))) {
            await rm(join(keyDir, name), { force: true });
            log("removed the Bitwarden signing key (Bitwarden was removed in 0.25.0)");
          }
        }
        const buildRoot = options.buildRoot ?? join(stateDir(), "signed-in");
        for (const name of await readdir(buildRoot).catch(() => [] as string[])) {
          if (isLegacyBitwardenImageTag(`${SIGNED_IN_IMAGE_REPOSITORY}:${name}`)) await rm(join(buildRoot, name), { recursive: true, force: true });
        }
        const listed = await docker(["image", "ls", "--filter", `reference=${SIGNED_IN_IMAGE_REPOSITORY}:*`, "--format", "{{.Repository}}:{{.Tag}}"], 15_000);
        if (listed.code !== 0) return;
        let left = 0;
        for (const tag of listed.stdout.split("\n").map((line) => line.trim()).filter(isLegacyBitwardenImageTag)) {
          const removed = await docker(["rmi", tag], 60_000).catch(() => ({ code: 1 }));
          if (removed.code === 0) log(`removed the old Bitwarden image ${tag}`);
          else left++;
        }
        if (left === 0) legacyDone = true;
      } catch {
        // tried again at the next check
      }
    })().finally(() => {
      legacyRunning = null;
    });
    return legacyRunning;
  }

  let idleTimer: ReturnType<typeof setInterval> | null = null;

  return {
    image,
    status,
    ensureStarted,
    idleCheck,
    removeLegacyBitwarden,
    legacyRelayCheck,
    startIdleChecks() {
      if (idleTimer) return;
      idleTimer = setInterval(() => void idleCheck().catch(() => undefined), options.idleCheckMs ?? 60_000);
      (idleTimer as { unref?: () => void }).unref?.();
      // Right away too: a run paused by a relay from before 0.25.0 should not wait for the first check.
      void removeLegacyBitwarden();
      void legacyRelayCheck().catch(() => false);
    },
    dispose() {
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
    },
    /** Starts the stack if needed and issues a one-time ticket for a run, when no other run holds the browser. */
    async prepare(target: { sourceId: string; cardId: string }) {
      const ready = await readyForUse();
      if (!ready.ok) return { ok: false as const, state: ready.state, detail: ready.detail };
      // An image with Bitwarden from before 0.25.0 that still runs (another run holds it) is never
      // handed to a new run; it is replaced once nothing holds it.
      if (isLegacyBitwardenImageTag(await runningNekoImage())) return { ok: false as const, state: "busy" as const, detail: "" };
      return admit(async () => {
        let held: number;
        try {
          held = await holders();
        } catch {
          return { ok: false as const, state: "docker-unavailable" as const, detail: "could not check the signed-in browser's runs" };
        }
        if (held > 0) return { ok: false as const, state: "busy" as const, detail: "" };
        lastActive = now();
        return { ok: true as const, ticket: tickets.issue(target) };
      });
    },
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => tickets.consume(ticket, target),
    /**
     * Frees the browser for the next run when this one was admitted but is stopped or closed before
     * its MCP container came up. `seenAt` is the admission sequence number when the stop or close was
     * seen: a run admitted after it is a newer session (a refresh or resume) and keeps the browser.
     */
    release(agentId: string, seenAt?: number): void {
      if (admittedAfter(admissions.get(agentId), seenAt)) return;
      starting.delete(agentId);
    },
    /** The run's latest admission (sequence number and session name), for the close hook. */
    admission: (agentId: string): Admission | undefined => admissions.get(agentId),
    /** The MCP server for one session of a signed-in run; refused while another run holds the browser. */
    async mcpServer(agentId: string): Promise<{ server: StdioServer; session: string } | { refused: "busy" | "unavailable" } | null> {
      const { path, host } = await sb.docker();
      const node = await sb.node();
      if (!path || !node) return null;
      // Never a new session on an image with Bitwarden from before 0.25.0 (no lock machinery, no
      // extension guard any more): refused until it is replaced, which is started here when possible.
      if (isLegacyBitwardenImageTag(await runningNekoImage())) {
        log(`run ${agentId}: the signed-in browser still runs the old image with Bitwarden; it is replaced once no run holds it`);
        void ensureStarted().catch(() => undefined);
        return { refused: "unavailable" };
      }
      // This call's own admission: noted at the claim, with its session name once known (below), and
      // the admission it replaced (put back when this setup fails).
      const admission: Admission = { seq: 0, session: "" };
      const claimed = await admit(async () => {
        let others: number;
        try {
          others = await holders(agentId);
        } catch {
          return "unavailable" as const;
        }
        if (others > 0) return "busy" as const;
        admission.previous = admissions.get(agentId);
        admission.until = now() + STARTING_WINDOW_MS;
        starting.set(agentId, admission.until);
        admission.seq = nextAdmissionSeq();
        rememberAdmission(admissions, agentId, admission);
        return null;
      });
      if (claimed) return { refused: claimed };
      try {
        const runtime = await sb.runtime();
        const nonce = random().slice(0, 12);
        // The run's takeover guard always fails closed: see createControlGuard.
        const plan = signedInPlan(path, { stackId: await stackId(), instance: await sb.instance(), serverImage: sb.image, agentId, nonce, blockedIps: sb.blockedIps() });
        lastActive = now();
        // A resumed run may find the browser stopped (idle): start it; the launcher waits for it.
        if (!(await isRunning())) void ensureStarted().catch(() => undefined);
        const session = signedInAgentName(agentId, nonce);
        admission.session = session;
        const server = signedInMcpServer(node, runtime.launcher, plan, host);
        admission.previous = undefined;
        return { server, session };
      } catch (error) {
        // Admitted but not set up: never restored itself. Unless a newer call replaced it, the nearest
        // earlier admission whose setup did not fail comes back (an earlier session of the same run
        // keeps its own), or none; the starting window goes back to that one's, or goes, so the browser
        // is not reported busy for the rest of the window. A release meanwhile (the window is no
        // longer this claim's) is left as it is.
        admission.failed = true;
        if (admissions.get(agentId) === admission) {
          let back = admission.previous;
          while (back?.failed) back = back.previous;
          if (back) rememberAdmission(admissions, agentId, back);
          else admissions.delete(agentId);
          if (starting.get(agentId) === admission.until) {
            if (back?.until !== undefined && back.until > now()) starting.set(agentId, back.until);
            else starting.delete(agentId);
          }
        }
        throw error;
      }
    },
    /** A one-time viewer link (ticket in the fragment), starting the browser when needed. */
    async viewerLink(input: { purpose: "login" | "takeover"; portrait: boolean }) {
      const ready = await readyForUse();
      if (!ready.ok) return { ok: false as const, state: ready.state, detail: ready.detail };
      lastActive = now();
      return { ok: true as const, url: await makeLink(ready.input, input.purpose, input.portrait) };
    },
    stop: () => stopStack(false),
    /** Stops the stack gracefully (logins kept) and starts it again (the owner's Restart browser). */
    async restart(): Promise<void> {
      await stopStack(false);
      await ensureStarted();
    },
    /** Logs the owner out of every site: stops the browser and removes its profile volume. */
    logout: () => stopStack(true),
    /** New viewer key: every earlier link and viewer session stops working; a running relay restarts. */
    async rotateKey(): Promise<void> {
      await serial(async () => {
        const keys = await loadKeys(keysFile);
        const next = { ...keys, viewerSecret: secret(), statusToken: secret() };
        await saveKeys(keysFile, next);
        const bindHost = await options.bindHost();
        if (!bindHost || !(await isRunning())) return;
        const input = await stackInput(bindHost);
        await docker(["rm", "-f", stackNames(input.stackId).relay], 30_000).catch(() => undefined);
        await waitForNeko(input, await startRelay(input, next));
        log("rotated the signed-in browser's viewer key");
      });
    },
  };
}

export type SignedIn = ReturnType<typeof createSignedIn>;
