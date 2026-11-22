import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTAINER_LABEL, INSTANCE_LABEL, STARTING_WINDOW_MS, createTicketStore, type StdioServer } from "../shared/server-browser.ts";
import {
  BITWARDEN,
  bitwardenImageTag,
  BITWARDEN_LOCK_ATTEMPTS,
  bitwardenIdFromPin,
  bitwardenToolArgs,
  parseBitwardenTool,
  type BitwardenToolMode,
  bindHostAllowed,
  checkStackRun,
  IDLE_STOP_MS,
  shouldStopForIdle,
  SIGNED_IN_AGENT_ROLE,
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
  type BitwardenState,
  type SignedInState,
  type StackInput,
  type StackSecrets,
} from "../shared/signed-in.ts";
import { contextHash, execRunner, shortError, type Runner, type ServerBrowser } from "./server-browser.ts";
import { SIGNED_IN_BITWARDEN_FILES, SIGNED_IN_FILES } from "./server-browser-files.ts";
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

/** GET /bp/status on the relay; null when it does not answer as expected. */
export type RelayStatus = { viewers: number; idleMs: number; nekoUp: boolean; portrait: boolean; ownerControl?: boolean; lockPending?: boolean; lockGeneration?: number; lockFailed?: boolean };
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
              lockGeneration: Number(body.lockGeneration) || 0,
              lockFailed: body.lockFailed === true,
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

/** POST /bp/locked on the relay: the vault was locked for release `generation`; true when the relay let the run go on. */
export type RelayLocked = (host: string, port: number, token: string, generation: number) => Promise<boolean>;

export const postRelayLocked: RelayLocked = (host, port, token, generation) =>
  new Promise((resolve) => {
    const body = JSON.stringify({ generation });
    const req = httpRequest(
      {
        host,
        port,
        path: "/bp/locked",
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Host: `${host}:${port}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString("utf8")).cleared === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });

/** POST /bp/lock-failed on the relay: the vault could not be locked for release `generation`. */
export const postRelayLockFailed: RelayLocked = (host, port, token, generation) =>
  new Promise((resolve) => {
    const body = JSON.stringify({ generation });
    const req = httpRequest(
      { host, port, path: "/bp/lock-failed", method: "POST", headers: { Authorization: `Bearer ${token}`, Host: `${host}:${port}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 5000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });

export interface SignedInConfig {
  port: number;
  httpsBaseUrl: string;
  /** The owner chose Bitwarden in the signed-in browser (Settings, two presses); undefined: the settings could not be read. */
  bitwarden?: boolean;
  /** SHA-256 of the Bitwarden release the owner consented to download (the pin shown when they confirmed). */
  bitwardenConsent?: string;
}

/** Chromium's extension id for a public key (SPKI DER): the first 16 bytes of its SHA-256, as letters a to p. */
export function extensionIdOfKey(privateKeyPem: string): string {
  const der = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  return [...createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
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
  relayLocked?: RelayLocked;
  relayLockFailed?: RelayLocked;
  /** The Bitwarden variant's build context (signed-in-bitwarden/). */
  bitwardenFiles?: Readonly<Record<string, string>>;
  /** How often the daemon checks whether the vault must be locked (Bitwarden only). */
  lockCheckMs?: number;
  /** The Bitwarden extension's signing key (made once per daemon install; default next to the keys file). */
  bitwardenKeyFile?: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long a start waits for neko to answer through the relay. */
  startTimeoutMs?: number;
  idleCheckMs?: number;
}

export interface BitwardenStatus {
  state: BitwardenState;
  /** The run waits until the daemon has locked the vault after a takeover. */
  lockPending: boolean;
  /** The last lock the daemon did: verified or not, why not, and how many failed in a row. */
  lastLock: { at: number; ok: boolean; detail: string; failures: number } | null;
  /** The running browser has another image than the current choice needs (it switches once no run holds it). */
  updatePending: boolean;
  /** The pinned Bitwarden version (what a download installs). */
  version: string;
  /** The running browser has it. */
  active: boolean;
  detail: string;
}

export interface SignedInStatus {
  state: SignedInState;
  bitwarden: BitwardenStatus;
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
  const bitwardenKeyFile = options.bitwardenKeyFile ?? join(dirname(options.keysFile ?? join(stateDir(), "signed-in", "keys.json")), "bitwarden-key.pem");
  let bitwardenBuildCache: { id: string; image: string } | null = null;
  /**
   * The Bitwarden build of this install: its extension id comes from a signing key made once per
   * daemon install and kept in the plugin's state directory (0600, never in an image, never logged;
   * the image build gets it only as a BuildKit secret). So the id, and the vault's local data in the
   * profile, survive new images and pins. The image tag includes the id. `create`: make the key when
   * there is none (only for a download the owner confirmed); otherwise null without a key.
   */
  function bitwardenBuild(create = false): { id: string; image: string } | null {
    if (bitwardenBuildCache) return bitwardenBuildCache;
    let pem: string | null = null;
    try {
      pem = readFileSync(bitwardenKeyFile, "utf8");
    } catch {
      pem = null;
    }
    if (!pem) {
      if (!create) return null;
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "der" } });
      mkdirSync(dirname(bitwardenKeyFile), { recursive: true, mode: 0o700 });
      writeFileSync(bitwardenKeyFile, privateKey, { mode: 0o600 });
      chmodSync(bitwardenKeyFile, 0o600);
      pem = privateKey;
      log("made the signing key for this install's Bitwarden build");
    }
    const id = extensionIdOfKey(pem);
    bitwardenBuildCache = { id, image: bitwardenImageTag(image, contextHash({ ...(options.bitwardenFiles ?? SIGNED_IN_BITWARDEN_FILES), "extension-id": id })) };
    return bitwardenBuildCache;
  }
  /** The Bitwarden image of this install, or null before any key exists. */
  const bitwardenImageOrNull = (): string | null => {
    try {
      return bitwardenBuild(false)?.image ?? null;
    } catch {
      return null;
    }
  };
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const random = options.random ?? (() => randomBytes(16).toString("hex"));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const relayStatus = options.relayStatus ?? fetchRelayStatus;
  const relayLocked = options.relayLocked ?? postRelayLocked;
  const relayLockFailed = options.relayLockFailed ?? postRelayLockFailed;
  const keysFile = options.keysFile ?? join(stateDir(), "signed-in", "keys.json");
  const tickets = createTicketStore({ random, now, max: 20 });
  /** Runs admitted by mcpServer whose MCP container may not exist yet: agent id -> until. */
  const starting = new Map<string, number>();
  let lastActive = now();
  let building: Promise<void> | null = null;
  let buildError: string | null = null;
  /** The last vault lock the daemon did (for the settings and the card). */
  let lastLock: { at: number; ok: boolean; detail: string; failures: number } | null = null;
  let bitwardenBuilding: Promise<void> | null = null;
  let bitwardenBuildError: string | null = null;
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

  /** Whether the owner's saved consent is for the pinned release (a new pin needs a new confirmation). */
  const consented = (config: SignedInConfig) => config.bitwarden === true && config.bitwardenConsent === BITWARDEN.sha256;

  /** The Bitwarden variant when the owner chose it (for this pin) and it is built; otherwise the plain signed-in image. */
  async function nekoImageFor(config: SignedInConfig): Promise<string> {
    const bw = bitwardenImageOrNull();
    return consented(config) && bw && (await imageExists(bw)) ? bw : image;
  }

  async function stackInput(bindHost: string): Promise<StackInput> {
    const config = await options.config();
    const runtime = await sb.runtime();
    let nekoImage: string;
    if (config.bitwarden === undefined) {
      // The settings could not be read: never switch images on a guess (turning Bitwarden off by
      // mistake would remove its data). Keep what runs; do not start without knowing.
      const running = await runningNekoImage();
      if (!running) throw Object.assign(new Error("the plugin's settings could not be read; try again in a moment"), { state: "failed" as const });
      nekoImage = running;
    } else nekoImage = await nekoImageFor(config);
    return {
      stackId: await stackId(),
      instance: await sb.instance(),
      serverImage: sb.image,
      nekoImage,
      bitwarden: nekoImage === bitwardenImageOrNull(),
      seccompProfile: runtime.seccomp,
      blockedIps: sb.blockedIps(),
      bindHost,
      port: config.port,
      origins: viewerOrigins(bindHost, config.port, config.httpsBaseUrl),
    };
  }

  function configTag(input: StackInput): string {
    return createHash("sha256")
      .update(`${input.bindHost}|${input.port}|${input.origins.join(",")}|${input.nekoImage}|${input.bitwarden === true}|${sb.image}`)
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
        // Bitwarden turned on or off (or a new pin built): neko starts again with the other image, but
        // never under a run (it would lose its browser); that run's next start or the idle stop does it.
        const running = (await docker(["inspect", "--format", "{{.Config.Image}}", names.neko], 15_000)).stdout.trim();
        if (running && running !== input.nekoImage) {
          // Never under a run or while a viewer is connected (the owner would lose the browser mid-use).
          const viewers = (await relayAnswer(input, await loadKeys(keysFile)))?.viewers ?? 0;
          if ((await holders().catch(() => 1)) === 0 && viewers === 0) {
            log(input.bitwarden ? "starting the signed-in browser again with Bitwarden" : "starting the signed-in browser again without Bitwarden");
            allRunning = false;
          } else {
            // Keep what runs, and a relay that matches it (with Bitwarden, it keeps locking the vault).
            input = { ...input, nekoImage: running, bitwarden: running === bitwardenImageOrNull() };
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
        // Data of Bitwarden builds no longer installed (Bitwarden turned off, or a new pin): cleared
        // once Chromium runs.
        void cleanupOldBitwarden().catch(() => undefined);
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

  /** The Bitwarden variant on top of the signed-in image: downloads the pinned release (consent given). */
  async function buildBitwarden(): Promise<void> {
    const { path, host } = await sb.docker();
    if (!path) throw new Error("docker not found");
    if (!(await imageExists(image))) throw new Error("the signed-in browser image is not built yet");
    const build = bitwardenBuild(true)!;
    const dir = join(options.buildRoot ?? join(stateDir(), "signed-in"), build.image.split(":")[1]!);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(options.bitwardenFiles ?? SIGNED_IN_BITWARDEN_FILES)) await writeFile(join(dir, name), content);
    log(`building the signed-in browser image with Bitwarden ${BITWARDEN.version}: ${build.image}`);
    // The signing key goes in only as a BuildKit secret (mounted for that one step, never in a layer
    // or the build context); the expected id as a build argument the install script checks.
    const result = await run(
      path,
      ["build", "--label", `${STACK_LABEL}=bitwarden-image`, "--build-arg", `BASE_IMAGE=${image}`, "--build-arg", `BITWARDEN_ID=${build.id}`, "--secret", `id=bitwarden-key,src=${bitwardenKeyFile}`, "-t", build.image, dir],
      { timeoutMs: 15 * 60_000, env: sb.dockerEnv(host) },
    );
    if (result.code !== 0) throw new Error(shortError(result.stderr || result.stdout || result.failure || "build failed"));
    log(`built ${build.image}`);
  }

  function startBitwardenBuild(): void {
    if (bitwardenBuilding) return;
    bitwardenBuildError = null;
    bitwardenBuilding = buildBitwarden()
      .catch((error: unknown) => {
        bitwardenBuildError = error instanceof Error ? error.message : String(error);
        log(`building the Bitwarden image failed: ${bitwardenBuildError}`);
      })
      .finally(() => {
        bitwardenBuilding = null;
      });
  }

  async function bitwardenStatus(config: SignedInConfig, baseBuilt: boolean, running: boolean, lockPending: boolean): Promise<BitwardenStatus> {
    let active = false;
    let updatePending = false;
    const bw = bitwardenImageOrNull();
    if (running) {
      const current = await runningNekoImage();
      active = !!bw && current === bw;
      updatePending = config.bitwarden !== undefined && current !== "" && current !== (await nekoImageFor(config));
    }
    const out = (state: BitwardenState, detail = "", isActive = false): BitwardenStatus => ({ state, version: BITWARDEN.version, active: isActive, detail, lockPending, lastLock, updatePending });
    if (config.bitwarden !== true) return out("off", "", active);
    if (bitwardenBuilding) return out("building", "", active);
    if (!consented(config)) return out(baseBuilt ? "no-image" : "needs-browser", "", active);
    if (bw && (await imageExists(bw))) return out("ready", "", active);
    if (bitwardenBuildError) return out("build-failed", bitwardenBuildError, active);
    return out(baseBuilt ? "no-image" : "needs-browser", "", active);
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
    const bwOff: BitwardenStatus = { state: config.bitwarden === true ? "needs-browser" : "off", version: BITWARDEN.version, active: false, detail: "", lockPending: false, lastLock, updatePending: false };
    const off = (state: SignedInState, detail = "") => ({ state, ...common, bitwarden: bwOff, running: false, viewers: 0, busy: false, detail });
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
    let lockPending = false;
    if (running) {
      const keys = await loadKeys(keysFile);
      const relay = await relayStatus(bindHost!, stackPorts(config.port).http, keys.statusToken);
      viewers = relay?.viewers ?? 0;
      lockPending = relay?.lockPending === true;
    }
    const busy = (await holders().catch(() => 0)) > 0;
    const bitwarden = await bitwardenStatus(config, true, running, lockPending);
    if (!running && startError) return { ...off("failed", startError), bitwarden };
    return { state: running ? "running" : "ready", ...common, bitwarden, running, viewers, busy, detail: "" };
  }

  /** A ready stack, or why not; never builds. */
  async function readyForUse(): Promise<{ ok: true; input: StackInput } | { ok: false; state: SignedInState; detail: string }> {
    const current = await status();
    if (!["ready", "running", "failed"].includes(current.state)) return { ok: false, state: current.state, detail: current.detail };
    try {
      const started = await ensureStarted();
      // A relay that just started holds runs until the vault is locked: wait for the first lock (the
      // lock timer does it) before the browser is handed out, so a run does not begin paused. Outside
      // the stack lock, and bounded.
      if (started.input.bitwarden) await waitForFirstLock(started.input);
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
    const agentRunning = (await holders().catch(() => 1)) > 0;
    const config = await options.config();
    // The running browser has an older image or the other Bitwarden choice (a plugin update, Bitwarden
    // turned on or off while a run held it): start it again with the right one once no run holds it.
    // Not on unknown settings, and not while a viewer is connected (ensureStarted checks that too).
    if (!agentRunning && config.bitwarden !== undefined) {
      const current = await runningNekoImage();
      if (current && current !== (await nekoImageFor(config))) {
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

  /** The id of the Bitwarden build in the running neko, or null. */
  async function installedBitwardenId(): Promise<string | null> {
    const names = stackNames(await stackId());
    const result = await docker(["exec", names.neko, "cat", "/opt/bitwarden/browser-prompt-pin.json"], 15_000).catch(() => ({ code: 1, stdout: "" }));
    return result.code === 0 ? bitwardenIdFromPin(result.stdout) : null;
  }

  /** Runs the Bitwarden tool (server-browser/bitwarden-lock.mjs) in neko's network namespace. */
  async function bitwardenTool(mode: BitwardenToolMode, ids: string[]) {
    const args = bitwardenToolArgs({ stackId: await stackId(), instance: await sb.instance(), serverImage: sb.image }, mode, ids);
    const result = await docker(args, 150_000).catch(() => null);
    return result && result.code === 0 ? parseBitwardenTool(result.stdout) : null;
  }

  /** Relay state for the lock decisions: null when it does not answer. */
  async function relayNow(): Promise<{ relay: RelayStatus | null; bindHost: string | null; port: number; token: string }> {
    const config = await options.config();
    const bindHost = await options.bindHost().catch(() => null);
    const keys = await loadKeys(keysFile);
    const port = stackPorts(config.port).http;
    if (!bindHost || !bindHostAllowed(bindHost)) return { relay: null, bindHost: null, port, token: keys.statusToken };
    return { relay: await relayStatus(bindHost, port, keys.statusToken), bindHost, port, token: keys.statusToken };
  }

  /**
   * Locks Bitwarden and verifies it through Chromium's DevTools (not the desktop, so keyboard focus,
   * fullscreen pages, dialogs and the number of accounts do not matter): Bitwarden's own "lock all"
   * (it then reloads itself), checked by asking it for every account and every account's state; if
   * that cannot be verified, a reload of the extension (clears chrome.storage.session, where the key
   * of an unlocked session lives), checked the same way; after BITWARDEN_LOCK_ATTEMPTS rounds, a
   * restart of Chromium (logins kept), checked again, but only with `allowRestart` (no viewer
   * connected: the owner would lose the browser mid-use). Locked only when Bitwarden answers for
   * every account and none is unlocked. Returns when it was verified (`at`).
   */
  let locking: Promise<{ ok: boolean; detail: string; at: number }> | null = null;
  let lockFailures = 0;
  let nextLockAt = 0;
  function verifiedLock(allowRestart: boolean): Promise<{ ok: boolean; detail: string; at: number }> {
    locking ??= (async () => {
      const id = await installedBitwardenId();
      // No Bitwarden in the running browser: nothing to lock.
      if (!id) return { ok: true, detail: "no Bitwarden in the running browser", at: now() };
      let detail = "";
      for (let attempt = 0; attempt < BITWARDEN_LOCK_ATTEMPTS; attempt++) {
        for (const mode of ["lock", "reload"] as const) {
          const answer = await bitwardenTool(mode, [id]);
          if (answer?.locked) return { ok: true, detail: "", at: now() };
          detail = answer ? answer.detail || `not locked (${mode})` : `the lock tool did not answer (${mode})`;
          if (answer?.statuses?.some((s) => s.status === 2)) detail = "Bitwarden is still unlocked";
          // Another Bitwarden than the one the check knows: retrying will not help.
          if (/unknown shape/.test(detail)) return { ok: false, detail: "Bitwarden's internals are not the expected ones (a new Bitwarden version?): the plugin cannot verify the lock", at: now() };
        }
      }
      if (!allowRestart) return { ok: false, detail: `${detail}; the browser is not restarted while a viewer is connected (close the viewer, or press Restart browser)`, at: now() };
      log(`Bitwarden could not be locked (${detail}); restarting Chromium`);
      await bitwardenTool("restart", []);
      await sleep(5000);
      const after = await bitwardenTool("status", [id]);
      if (after?.locked) return { ok: true, detail: "locked by restarting the browser", at: now() };
      if (after?.statuses?.some((s) => s.status === 2)) {
        return { ok: false, detail: "Bitwarden unlocked itself again after a browser restart: its vault timeout is probably set to Never. Set a timeout (1 minute) with action Lock in Bitwarden's settings.", at: now() };
      }
      return { ok: false, detail: after ? after.detail || "not locked" : "the lock tool did not answer", at: now() };
    })()
      .then((result) => {
        lockFailures = result.ok ? 0 : lockFailures + 1;
        // After a failure, wait longer each time (15 s, 30 s, … at most 5 minutes) before the timer tries again.
        nextLockAt = result.ok ? 0 : now() + Math.min(5 * 60_000, 15_000 * 2 ** (lockFailures - 1));
        lastLock = { at: result.at, ok: result.ok, detail: result.detail, failures: lockFailures };
        if (!result.ok) log(`Bitwarden is not locked: ${result.detail}`);
        return result;
      })
      .finally(() => {
        locking = null;
      });
    return locking;
  }

  /**
   * Bitwarden: when the relay says the vault must be locked (after a takeover, or a relay start),
   * lock it (verified) and tell the relay that release's generation, which then lets the run go on;
   * until then the run stays paused (and after a failure is told the owner has to act). Never while
   * the owner holds control. When the relay cannot be asked while a Bitwarden browser and a run are
   * up, the run's guard stays paused (fail closed) and the vault is locked anyway.
   */
  let relayDownLockAt = 0;
  let lastGeneration = -1;
  async function lockCheck(): Promise<boolean> {
    if (locking) return false;
    try {
      const { relay, bindHost, port, token } = await relayNow();
      if (relay && bindHost) {
        if (!relay.lockPending || !relay.nekoUp) return false;
        // The owner holds control: nothing to lock yet (the release starts a new round).
        if (relay.ownerControl === true) return false;
        const generation = relay.lockGeneration ?? 0;
        // A new release is tried right away; a failed one again after a growing pause.
        if (generation !== lastGeneration) {
          lastGeneration = generation;
          nextLockAt = 0;
        }
        if (now() < nextLockAt) return false;
        const result = await verifiedLock(relay.viewers === 0);
        if (!result.ok) {
          await relayLockFailed(bindHost, port, token, generation);
          return false;
        }
        return relayLocked(bindHost, port, token, generation);
      }
      if (now() - relayDownLockAt < 15_000) return false;
      relayDownLockAt = now();
      const bw = bitwardenImageOrNull();
      if (!bw || (await runningNekoImage()) !== bw || (await holders().catch(() => 1)) === 0) return false;
      log("the relay does not answer while a run uses Bitwarden's browser: locking the vault");
      // Without the relay no viewer can be connected.
      await verifiedLock(true);
      return false;
    } catch {
      return false;
    }
  }

  /**
   * The owner's Lock now: the generation is read before the lock, and only that release is
   * confirmed (a takeover that began and ended meanwhile is a new release, locked on its own).
   */
  async function lockNow(): Promise<{ ok: boolean; detail: string }> {
    const before = await relayNow();
    const generation = before.relay?.lockGeneration ?? null;
    const result = await verifiedLock((before.relay?.viewers ?? 0) === 0);
    if (!result.ok || generation === null || !before.bindHost) return result;
    if (before.relay?.lockPending) await relayLocked(before.bindHost, before.port, before.token, generation);
    return result;
  }

  /**
   * After a start: the relay holds runs until the vault is locked; wait for that (the lock timer does
   * it; this only nudges it) so a run does not begin paused. Bounded by the wall clock, outside the
   * stack lock.
   */
  async function waitForFirstLock(input: StackInput): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (let i = 0; i < 120 && Date.now() < deadline; i++) {
      const relay = await relayAnswer(input, await loadKeys(keysFile));
      if (relay && !relay.lockPending) return;
      if (relay?.nekoUp && !locking) void lockCheck();
      await sleep(1500);
    }
    log("Bitwarden: the first lock is taking long; runs stay paused until it is done");
  }

  /**
   * Clears what Bitwarden builds no longer installed left in the profile (their extension origins'
   * storage), retried; an id is forgotten once no trace of it is left in the profile.
   */
  async function cleanupOldBitwarden(): Promise<string[]> {
    const names = stackNames(await stackId());
    const file = "/home/neko/.config/chromium/.bp-bitwarden-ids";
    const listed = await docker(["exec", "--user", "neko", names.neko, "cat", file], 15_000).catch(() => ({ code: 1, stdout: "" }));
    if (listed.code !== 0) return [];
    const current = await installedBitwardenId();
    const all = [...new Set(listed.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[a-p]{32}$/.test(line)))];
    const old = all.filter((id) => id !== current);
    if (old.length === 0) return [];
    let cleared: string[] = [];
    // Chromium may still be starting: a few tries, a little longer each time.
    for (let i = 0; i < 5 && cleared.length < old.length; i++) {
      const answer = await bitwardenTool("cleanup", old);
      cleared = answer?.cleared ?? [];
      if (cleared.length < old.length) await sleep(3000 * (i + 1));
    }
    if (cleared.length < old.length) {
      log(`could not clear the storage of ${old.length - cleared.length} earlier Bitwarden build(s); the next start tries again`);
      return cleared;
    }
    log(`cleared the storage of ${old.length} earlier Bitwarden build(s)`);
    // Forget an id once nothing in the profile names it any more (a preference stub Chromium brings
    // back is removed by the start script at the next start; until then the id stays recorded).
    const gone: string[] = [];
    for (const id of old) {
      const traces = await docker(
        ["exec", "--user", "neko", names.neko, "sh", "-c", `find /home/neko/.config/chromium -name '*${id}*' | head -1; grep -l '${id}' /home/neko/.config/chromium/*/Preferences /home/neko/.config/chromium/*/'Secure Preferences' 2>/dev/null | head -1; true`],
        15_000,
      ).catch(() => ({ code: 1, stdout: "x" }));
      if (traces.code === 0 && traces.stdout.trim() === "") gone.push(id);
    }
    if (gone.length) {
      const keep = all.filter((id) => !gone.includes(id));
      await docker(["exec", "--user", "neko", names.neko, "sh", "-c", `printf '%s' '${keep.map((id) => `${id}\n`).join("")}' > ${file}`], 15_000).catch(() => undefined);
    }
    return cleared;
  }

  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let lockTimer: ReturnType<typeof setInterval> | null = null;

  return {
    image,
    status,
    ensureStarted,
    idleCheck,
    lockCheck,
    lockNow,
    cleanupOldBitwarden,
    /** This install's Bitwarden image tag (null before a key exists) and extension id. */
    bitwardenImage: () => bitwardenImageOrNull(),
    bitwardenId: () => bitwardenBuild(false)?.id ?? null,
    startIdleChecks() {
      if (idleTimer) return;
      idleTimer = setInterval(() => void idleCheck().catch(() => undefined), options.idleCheckMs ?? 60_000);
      (idleTimer as { unref?: () => void }).unref?.();
      lockTimer = setInterval(() => void lockCheck(), options.lockCheckMs ?? 1500);
      (lockTimer as { unref?: () => void }).unref?.();
    },
    dispose() {
      if (idleTimer) clearInterval(idleTimer);
      if (lockTimer) clearInterval(lockTimer);
      idleTimer = null;
      lockTimer = null;
    },
    /**
     * Bitwarden in the signed-in browser. `download` (only from the settings' two-press consent, and
     * only once that consent is saved) builds the variant with the pinned release; `apply` restarts an
     * idle browser so a changed choice takes effect now (otherwise when no run holds it); `lock`
     * locks the vault now (verified) and lets a run that waits for it go on; `restart-browser`
     * restarts Chromium (logins kept, every in-memory key gone), then locks.
     */
    async bitwarden(action: "download" | "apply" | "lock" | "restart-browser"): Promise<{ ok: boolean; message: string }> {
      if (action === "download") {
        if (!consented(await options.config())) return { ok: false, message: `Confirm the download of Bitwarden ${BITWARDEN.version} in the settings first (Download and enable, then Confirm download).` };
        if (!(await imageExists(image))) return { ok: false, message: "Set up the signed-in browser first (Download and build)." };
        startBitwardenBuild();
        return { ok: true, message: `Downloading Bitwarden ${BITWARDEN.version} and building the browser image with it (a minute or two).` };
      }
      if (action === "lock" || action === "restart-browser") {
        if (!(await isRunning())) return { ok: true, message: "The signed-in browser is not running: nothing is unlocked." };
        if (action === "restart-browser") await bitwardenTool("restart", []);
        if (action === "restart-browser") await sleep(5000);
        const result = await lockNow();
        return result.ok
          ? { ok: true, message: action === "lock" ? "Bitwarden is locked (verified). A run that waited for it goes on." : "Restarted the browser; Bitwarden is locked (verified). Your logins are kept." }
          : { ok: false, message: `Bitwarden could not be locked: ${result.detail}` };
      }
      if ((await holders().catch(() => 1)) > 0) return { ok: false, message: "Update pending: a run is using the signed-in browser; it switches when the run ends." };
      if (!(await isRunning())) return { ok: true, message: "The change applies when the signed-in browser next starts." };
      await stopStack(false);
      return { ok: true, message: "Stopped the signed-in browser; it starts with the new choice when next needed. Your logins are kept." };
    },
    /** Starts the stack if needed and issues a one-time ticket for a run, when no other run holds the browser. */
    async prepare(target: { sourceId: string; cardId: string }) {
      const ready = await readyForUse();
      if (!ready.ok) return { ok: false as const, state: ready.state, detail: ready.detail };
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
    /** The MCP server for one session of a signed-in run; refused while another run holds the browser. */
    async mcpServer(agentId: string): Promise<{ server: StdioServer; session: string } | { refused: "busy" | "unavailable" } | null> {
      const { path, host } = await sb.docker();
      const node = await sb.node();
      if (!path || !node) return null;
      const claimed = await admit(async () => {
        let others: number;
        try {
          others = await holders(agentId);
        } catch {
          return "unavailable" as const;
        }
        if (others > 0) return "busy" as const;
        starting.set(agentId, now() + STARTING_WINDOW_MS);
        return null;
      });
      if (claimed) return { refused: claimed };
      const runtime = await sb.runtime();
      const nonce = random().slice(0, 12);
      // With Bitwarden (running, or chosen and built) the run's takeover guard fails closed.
      const config = await options.config();
      const bw = bitwardenImageOrNull();
      const failClosed = !!bw && ((await runningNekoImage()) === bw || (consented(config) && (await imageExists(bw))));
      const plan = signedInPlan(path, { stackId: await stackId(), instance: await sb.instance(), serverImage: sb.image, agentId, nonce, blockedIps: sb.blockedIps(), failClosed });
      lastActive = now();
      // A resumed run may find the browser stopped (idle): start it; the launcher waits for it.
      if (!(await isRunning())) void ensureStarted().catch(() => undefined);
      return { server: signedInMcpServer(node, runtime.launcher, plan, host), session: signedInAgentName(agentId, nonce) };
    },
    /** A one-time viewer link (ticket in the fragment), starting the browser when needed. */
    async viewerLink(input: { purpose: "login" | "takeover"; portrait: boolean }) {
      const ready = await readyForUse();
      if (!ready.ok) return { ok: false as const, state: ready.state, detail: ready.detail };
      lastActive = now();
      return { ok: true as const, url: await makeLink(ready.input, input.purpose, input.portrait) };
    },
    stop: () => stopStack(false),
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
