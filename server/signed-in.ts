import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTAINER_LABEL, INSTANCE_LABEL, STARTING_WINDOW_MS, createTicketStore, type StdioServer } from "../shared/server-browser.ts";
import {
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
  STACK_PROXY_IP_PLACEHOLDER,
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
import { contextHash, execRunner, shortError, type Runner, type ServerBrowser } from "./server-browser.ts";
import { SIGNED_IN_FILES } from "./server-browser-files.ts";
import { stateDir } from "./state-dir.ts";


/** The plugin's viewer key and the relay's status token (kept in the state directory, mode 0600), and neko's passwords for the current start. */
export interface SignedInKeys extends StackSecrets {}

/** `v1.<exp>.<nonce>.<purpose>.<hmac>`; the relay (server-browser/relay.mjs) checks it the same way. */
export function signViewerTicket(secret: string, input: { exp: number; nonce: string; purpose: "login" | "takeover" }): string {
  const payload = `v1.${input.exp}.${input.nonce}.${input.purpose}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

const secret = () => randomBytes(32).toString("base64url");

export function newKeys(): SignedInKeys {
  return { viewerSecret: secret(), statusToken: secret(), nekoAdminPassword: secret(), nekoUserPassword: secret() };
}

function validKeys(value: unknown): value is SignedInKeys {
  const v = value as Record<string, unknown> | null;
  return !!v && ["viewerSecret", "statusToken", "nekoAdminPassword", "nekoUserPassword"].every((key) => typeof v[key] === "string" && (v[key] as string).length >= 32);
}

/** Reads the keys file, or creates it (0600) with fresh keys. */
export async function loadKeys(file: string, fresh = newKeys): Promise<SignedInKeys> {
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    if (validKeys(stored)) return stored;
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
export type RelayStatus = { viewers: number; idleMs: number; nekoUp: boolean; portrait: boolean };
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
            resolve({ viewers: Number(body.viewers) || 0, idleMs: Number(body.idleMs) || 0, nekoUp: body.nekoUp === true, portrait: body.portrait === true });
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
  const log = options.log ?? ((message: string) => console.log(`[browser-prompt] ${message}`));
  const random = options.random ?? (() => randomBytes(16).toString("hex"));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const relayStatus = options.relayStatus ?? fetchRelayStatus;
  const keysFile = options.keysFile ?? join(stateDir(), "signed-in", "keys.json");
  const tickets = createTicketStore({ random, now, max: 20 });
  /** Runs admitted by mcpServer whose MCP container may not exist yet: agent id -> until. */
  const starting = new Map<string, number>();
  let lastActive = now();
  let building: Promise<void> | null = null;
  let buildError: string | null = null;
  let startError: string | null = null;
  let lifecycle: Promise<unknown> = Promise.resolve();
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
    return createHash("sha256").update(`${input.bindHost}|${input.port}|${input.origins.join(",")}|${image}|${sb.image}`).digest("hex").slice(0, 16);
  }

  async function relayAnswer(input: StackInput, keys: SignedInKeys): Promise<RelayStatus | null> {
    return relayStatus(input.bindHost, stackPorts(input.port).http, keys.statusToken);
  }

  async function removeStack(input: { stackId: string }, graceful: boolean): Promise<void> {
    const names = stackNames(input.stackId);
    // neko first and gracefully: Chromium writes its cookies on the way out.
    if (graceful) await docker(["stop", "-t", "30", names.neko], 60_000).catch(() => undefined);
    await docker(["rm", "-f", names.relay, names.neko, names.proxy], 60_000).catch(() => undefined);
    await docker(["network", "rm", names.network], 30_000).catch(() => undefined);
    await docker(["network", "rm", names.publicNetwork], 30_000).catch(() => undefined);
  }

  async function startRelay(input: StackInput, keys: SignedInKeys): Promise<void> {
    const names = stackNames(input.stackId);
    const args = stackRelayArgs(input, keys);
    // The relay carries the configuration it was started with, so a changed address or port restarts it.
    const withTag = [...args.slice(0, -4), "--label", `${CONFIG_LABEL}=${configTag(input)}`, ...args.slice(-4)];
    checkStackRun(withTag, "relay", input);
    await mustDocker("starting the relay", withTag);
    await mustDocker("connecting the relay", ["network", "connect", names.network, names.relay]);
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
    const names = stackNames(input.stackId);
    log("starting the signed-in browser");
    await removeStack(input, false);
    const networks = stackNetworkArgs(input);
    await mustDocker("creating the internal network", networks.internal);
    await mustDocker("creating the outward network", networks.public);
    const subnetText = await mustDocker("reading the internal network", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", names.network]);
    const subnet = subnetText.split(/\s+/).find((cidr) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(cidr));
    if (!subnet) throw new Error("reading the internal network: no IPv4 subnet");
    await mustDocker("creating the profile volume", stackVolumeArgs(input));

    const proxy = stackProxyArgs(input).map((arg) => arg.split(STACK_SUBNET_PLACEHOLDER).join(subnet));
    checkStackRun(proxy, "proxy", input);
    await mustDocker("starting the proxy", proxy);
    await mustDocker("connecting the proxy", ["network", "connect", names.network, names.proxy]);
    const proxyIp = (await mustDocker("reading the proxy address", ["inspect", "--format", `{{(index .NetworkSettings.Networks "${names.network}").IPAddress}}`, names.proxy])).trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(proxyIp)) throw new Error("reading the proxy address: none");

    // neko's passwords are new on every start; only the relay knows the admin one.
    const keys = { ...(await loadKeys(keysFile)), nekoAdminPassword: secret(), nekoUserPassword: secret() };
    await saveKeys(keysFile, keys);
    const neko = stackNekoArgs(input, keys).map((arg) => arg.split(STACK_PROXY_IP_PLACEHOLDER).join(proxyIp));
    checkStackRun(neko, "neko", input);
    await mustDocker("starting the browser", neko);
    await startRelay(input, keys);
    await waitForNeko(input, keys);
    log("the signed-in browser is running");
  }

  /** Starts the stack unless all of it runs with the current configuration; returns the bind host and port. */
  async function ensureStarted(): Promise<{ input: StackInput }> {
    return serial(async () => {
      const bindHost = await options.bindHost();
      if (!bindHost || !bindHostAllowed(bindHost)) throw Object.assign(new Error("no Tailscale address for the viewer"), { state: "no-address" as const });
      const input = await stackInput(bindHost);
      const names = stackNames(input.stackId);
      const containers = await stackContainers();
      const allRunning = [names.neko, names.relay, names.proxy].every((name) => containers.get(name) === "running");
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
          await startRelay(input, keys);
          await waitForNeko(input, keys);
          lastActive = now();
          return { input };
        }
      }
      startingStack = true;
      try {
        await createStack(input);
        startError = null;
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
        log(`the signed-in browser could not start: ${startError}`);
        await removeStack(input, false);
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
      viewers = (await relayStatus(bindHost!, stackPorts(config.port).http, keys.statusToken))?.viewers ?? 0;
    }
    const busy = (await holders().catch(() => 0)) > 0;
    if (!running && startError) return { ...off("failed", startError) };
    return { state: running ? "running" : "ready", ...common, running, viewers, busy, detail: "" };
  }

  /** A ready stack, or why not; never builds. */
  async function readyForUse(): Promise<{ ok: true; input: StackInput } | { ok: false; state: SignedInState; detail: string }> {
    const current = await status();
    if (!["ready", "running", "failed"].includes(current.state)) return { ok: false, state: current.state, detail: current.detail };
    try {
      return { ok: true, ...(await ensureStarted()) };
    } catch (error) {
      const state = (error as { state?: SignedInState }).state ?? "failed";
      return { ok: false, state, detail: state === "failed" ? shortError(error instanceof Error ? error.message : String(error)) : "" };
    }
  }

  async function makeLink(input: StackInput, purpose: "login" | "takeover", portrait: boolean): Promise<string> {
    const keys = await loadKeys(keysFile);
    const ticket = signViewerTicket(keys.viewerSecret, { exp: Math.floor(now() / 1000) + VIEWER_TICKET_TTL_S, nonce: randomBytes(18).toString("base64url"), purpose });
    return viewerLink(input.origins.at(-1)!, ticket, portrait);
  }

  async function stopStack(wipe: boolean): Promise<void> {
    await serial(async () => {
      const id = await stackId();
      // Runs lose the browser: their MCP containers go first.
      const agents = await sb.listResources("container", [`label=${CONTAINER_LABEL}=${SIGNED_IN_AGENT_ROLE}`, `label=${INSTANCE_LABEL}=${await sb.instance()}`], []).catch(() => []);
      if (agents.length) await docker(["rm", "-f", ...agents.map(([cid]) => cid!)], 30_000).catch(() => undefined);
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
    if (!(await isRunning())) return false;
    const agentRunning = (await holders().catch(() => 1)) > 0;
    const config = await options.config();
    const bindHost = await options.bindHost().catch(() => null);
    const keys = await loadKeys(keysFile);
    const relay = bindHost ? await relayStatus(bindHost, stackPorts(config.port).http, keys.statusToken) : null;
    const viewers = relay?.viewers ?? 0;
    if (agentRunning || viewers > 0) lastActive = now();
    if (!shouldStopForIdle({ now: now(), lastActive, agentRunning, viewers, viewerIdleMs: relay ? relay.idleMs : null })) return false;
    log(`no run or viewer for ${Math.round(IDLE_STOP_MS / 60_000)} minutes`);
    await stopStack(false);
    return true;
  }

  let idleTimer: ReturnType<typeof setInterval> | null = null;

  return {
    image,
    status,
    ensureStarted,
    idleCheck,
    startIdleChecks() {
      if (idleTimer) return;
      idleTimer = setInterval(() => void idleCheck().catch(() => undefined), options.idleCheckMs ?? 60_000);
      (idleTimer as { unref?: () => void }).unref?.();
    },
    dispose() {
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
    },
    /** Starts the stack if needed and issues a one-time ticket for a run, when no other run holds the browser. */
    async prepare(target: { sourceId: string; cardId: string }) {
      const ready = await readyForUse();
      if (!ready.ok) return { ok: false as const, state: ready.state, detail: ready.detail };
      let held: number;
      try {
        held = await holders();
      } catch {
        return { ok: false as const, state: "docker-unavailable" as const, detail: "could not check the signed-in browser's runs" };
      }
      if (held > 0) return { ok: false as const, state: "busy" as const, detail: "" };
      lastActive = now();
      return { ok: true as const, ticket: tickets.issue(target) };
    },
    consumeTicket: (ticket: string, target: { sourceId: string; cardId: string }) => tickets.consume(ticket, target),
    /** The MCP server for one session of a signed-in run; refused while another run holds the browser. */
    async mcpServer(agentId: string): Promise<{ server: StdioServer; session: string } | { refused: "busy" | "unavailable" } | null> {
      const { path, host } = await sb.docker();
      const node = await sb.node();
      if (!path || !node) return null;
      let others: number;
      try {
        others = await holders(agentId);
      } catch {
        return { refused: "unavailable" };
      }
      if (others > 0) return { refused: "busy" };
      const runtime = await sb.runtime();
      const nonce = random().slice(0, 12);
      const plan = signedInPlan(path, { stackId: await stackId(), instance: await sb.instance(), serverImage: sb.image, agentId, nonce, blockedIps: sb.blockedIps() });
      starting.set(agentId, now() + STARTING_WINDOW_MS);
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
        await startRelay(input, next);
        await waitForNeko(input, next);
        log("rotated the signed-in browser's viewer key");
      });
    },
  };
}

export type SignedIn = ReturnType<typeof createSignedIn>;
