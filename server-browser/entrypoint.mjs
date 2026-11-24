// Entry point of a Server browser session's browser container. The container is alone on an
// internal Docker network with no route out; Chromium reaches the web only through the session's
// proxy sidecar (BP_PROXY, see proxy-main.mjs). This writes the Playwright MCP config into the
// container's /tmp and runs the pinned Playwright MCP on this process's stdin and stdout (the MCP
// stdio transport), filtering both directions (mcp-filter.mjs). Logs go to stderr only, so stdout
// stays pure JSON-RPC. When the session closes stdin, Playwright MCP exits, this process exits, and
// `docker run --rm` removes the container. A killed `docker run` client may leave stdin open, so it
// also stops after BP_IDLE_TIMEOUT_S without any MCP message and after BP_MAX_LIFETIME_S in total.
//
// Signed-in mode (BP_CDP_ENDPOINT=http://127.0.0.1:9222): the container shares the network namespace
// of the signed-in browser's neko container and attaches Playwright MCP over the DevTools protocol to
// the owner's persistent, signed-in Chromium there (its default context) instead of launching one.
// That Chromium already sends everything through the stack's filtering proxy; the same origin rules
// apply on top. The same stdio filter, timeouts and denied tools apply. BP_CONTROL_URL (the relay's
// unpublished takeover state) is required: every tool call is refused until the relay confirms that
// the owner does not hold control, and again whenever that confirmation is missing (fail closed, see
// createControlGuard). The clean Server browser (no BP_CDP_ENDPOINT) has no owner and no guard.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startCdpFilter } from "./cdp-filter.mjs";
import { CONTROL_POLL, createControlGuard, createControlPoller, createRunFilter, lineSplitter, MAX_CLIENT_LINE, MAX_SERVER_LINE } from "./mcp-filter.mjs";
import { BLOCKED_HOST_SUFFIXES, normalizeAddress } from "./proxy.mjs";

const require = createRequire(import.meta.url);
const log = (message) => process.stderr.write(`[browser-prompt server browser] ${message}\n`);

export const SIGNED_IN_CDP_ENDPOINT = "http://127.0.0.1:9222";
const cdpEndpoint = (process.env.BP_CDP_ENDPOINT ?? "").trim();
const signedIn = cdpEndpoint !== "";
if (signedIn && cdpEndpoint !== SIGNED_IN_CDP_ENDPOINT) {
  log(`BP_CDP_ENDPOINT may only be ${SIGNED_IN_CDP_ENDPOINT}; refusing to start`);
  process.exit(1);
}
const controlUrl = (process.env.BP_CONTROL_URL ?? "").trim();
if (controlUrl && !/^http:\/\/bp-si-[0-9a-f]{8}-relay:8081\/control$/.test(controlUrl)) {
  log("BP_CONTROL_URL is not the signed-in relay's control address; refusing to start");
  process.exit(1);
}
if (signedIn && !controlUrl) {
  log("BP_CONTROL_URL is missing: the signed-in browser needs the relay's takeover state; refusing to start");
  process.exit(1);
}
if (!signedIn && controlUrl) {
  log("BP_CONTROL_URL is only for the signed-in browser; refusing to start");
  process.exit(1);
}
const proxyServer = (process.env.BP_PROXY ?? "").trim();
if (!signedIn && !/^http:\/\/[0-9a-fA-F:.[\]]+:\d+$/.test(proxyServer)) {
  log("BP_PROXY is missing or not an http://<address>:<port> URL; refusing to start without the proxy");
  process.exit(1);
}
const extraBlocked = (process.env.BP_BLOCKED_IPS ?? "")
  .split(",")
  .map((value) => normalizeAddress(value))
  .filter(Boolean);
const maxLifetimeSeconds = Number(process.env.BP_MAX_LIFETIME_S ?? "43200");
const idleTimeoutSeconds = Number(process.env.BP_IDLE_TIMEOUT_S ?? "7200");

const work = "/tmp/browser-prompt";
const outputDir = `${work}/output`;
mkdirSync(outputDir, { recursive: true });
mkdirSync(process.env.HOME || "/tmp/home", { recursive: true });

// Origin rules on top of the network boundary (defense in depth): tailnet and local names, and the
// host's own addresses.
const blockedOrigins = [
  ...BLOCKED_HOST_SUFFIXES.flatMap((suffix) => [suffix, `*.${suffix}`]),
  ...extraBlocked.map((address) => (address.includes(":") ? `[${address}]` : address)),
];

const launchedBrowser = {
  browserName: "chromium",
  isolated: true,
  launchOptions: {
    // The image's bundled Chromium (Playwright MCP defaults to the Chrome channel, not installed).
    channel: "chromium",
    headless: true,
    // Chromium's own sandbox: works with the container's seccomp profile (Playwright's, allowing
    // user namespaces) and CAP_SYS_CHROOT in the bounding set; the container user has no
    // effective capabilities.
    chromiumSandbox: true,
    // Every request goes to the sidecar; Playwright adds <-loopback> so loopback is proxied too.
    proxy: { server: proxyServer },
    args: [
      // WebRTC may not send UDP around the proxy (there is no route anyway).
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-quic",
      "--no-pings",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-domain-reliability",
      "--disable-breakpad",
    ],
  },
  contextOptions: {
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    serviceWorkers: "block",
  },
};
// The owner's signed-in Chromium: its default context (with the owner's logins), never a new one.
const attachedBrowser = { browserName: "chromium", isolated: false, cdpEndpoint, cdpTimeout: 30_000 };

const config = {
  browser: signedIn ? attachedBrowser : launchedBrowser,
  network: { blockedOrigins },
  outputDir,
  imageResponses: "allow",
  capabilities: [],
  // file:// navigation stays blocked (Playwright MCP's default; never allowUnrestrictedFileAccess).
  allowUnrestrictedFileAccess: false,
};
const configPath = `${work}/config.json`;

// cli.js is not in the package exports; find it next to its package.json.
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
/** Waits until the signed-in browser's DevTools endpoint answers (neko starts Chromium a few seconds after the container). */
async function waitForCdp(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
if (signedIn && !(await waitForCdp())) {
  log("the signed-in browser did not answer on its DevTools port; stopping");
  process.exit(1);
}

// Signed-in: the owner's takeover state, polled every 500 ms (never two polls at once). See
// createControlGuard: it starts held, opens only on a valid `ownerControl: false` from the relay, and
// holds again on a failed poll, an invalid status, or a release older than CONTROL_MAX_AGE_MS (from
// the relay's read of neko). The first poll ends before Playwright MCP starts and before any message
// from the agent is read. Results of calls in flight while the state was unknown are buffered until
// it is confirmed (createCallTracker). The clean Server browser has no guard (no owner can take it over).
const guard = signedIn ? createControlGuard() : null;
const filter = createRunFilter({ signedIn, guard, log, emit: (line) => process.stdout.write(`${line}\n`) });
if (guard) {
  const poll = createControlPoller({ guard, url: controlUrl, timeoutMs: CONTROL_POLL.timeoutMs, log, onPoll: () => filter.sync() });
  await poll();
  setInterval(() => void poll(), CONTROL_POLL.intervalMs).unref();
  // A release that went stale between polls, and buffered results that waited too long.
  setInterval(() => filter.sync(), 250).unref();
}

// Signed-in: Playwright MCP talks to the owner's Chromium only through the DevTools filter, which
// hides the owner's tabs (those open now, and those the owner opens while holding control).
if (signedIn) {
  const cdp = await startCdpFilter({ upstream: cdpEndpoint, held: () => guard?.held() ?? true, log });
  config.browser.cdpEndpoint = cdp.endpoint;
}
writeFileSync(configPath, JSON.stringify(config));

const cliArgs = signedIn
  ? [cli, "--config", configPath, "--output-dir", outputDir]
  : [cli, "--config", configPath, "--headless", "--isolated", "--output-dir", outputDir, "--block-service-workers"];
const child = spawn(process.execPath, cliArgs, {
  cwd: work,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir },
});


let lastMessage = Date.now();
const fromAgent = lineSplitter((line) => {
  lastMessage = Date.now();
  const verdict = filter.client(line);
  if ("reply" in verdict) process.stdout.write(`${verdict.reply}\n`);
  else if ("forward" in verdict) child.stdin.write(`${verdict.forward}\n`);
}, { maxLength: MAX_CLIENT_LINE, onOverflow: () => filter.overflowFromClient() });
const fromServer = lineSplitter((line) => {
  // Signed-in: a result that comes back while held, or whose call overlapped a held period, is withheld.
  const kept = filter.server(line);
  if (kept !== null) process.stdout.write(`${kept}\n`);
}, { maxLength: MAX_SERVER_LINE, onOverflow: () => filter.overflowFromServer() });
process.stdin.setEncoding("utf8");
child.stdout.setEncoding("utf8");
process.stdin.on("data", (chunk) => fromAgent.push(chunk));
process.stdin.on("end", () => {
  fromAgent.end();
  child.stdin.end();
});
process.stdin.on("error", () => child.stdin.end());
child.stdin.on("error", () => {});
child.stdout.on("data", (chunk) => fromServer.push(chunk));
child.stdout.on("end", () => fromServer.end());

const idle = setInterval(() => {
  if (Date.now() - lastMessage < Math.max(60, idleTimeoutSeconds) * 1000) return;
  log(`no MCP message for ${idleTimeoutSeconds} s; stopping`);
  child.kill("SIGTERM");
}, 30_000);
idle.unref();
const lifetime = setTimeout(() => {
  log(`reached the maximum lifetime of ${maxLifetimeSeconds} s; stopping`);
  child.kill("SIGTERM");
}, Math.max(60, maxLifetimeSeconds) * 1000);
lifetime.unref();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  log(`could not start Playwright MCP: ${error.message}`);
  process.exit(1);
});
