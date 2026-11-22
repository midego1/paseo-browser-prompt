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
// apply on top. The same stdio filter, timeouts and denied tools apply. With BP_CONTROL_URL (the
// relay's unpublished takeover state) it also refuses every tool call while the owner holds control
// of the browser in the viewer.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startCdpFilter } from "./cdp-filter.mjs";
import { createCallTracker, createControlGuard, filterClientLine, filterServerLine, lineSplitter } from "./mcp-filter.mjs";
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
// Bitwarden in the signed-in browser: the takeover guard never opens on failed polls (the relay is
// what tells the run the vault was locked after a takeover).
const failClosed = (process.env.BP_CONTROL_FAIL_CLOSED ?? "") === "1";
if (!["", "1"].includes(process.env.BP_CONTROL_FAIL_CLOSED ?? "")) {
  log("BP_CONTROL_FAIL_CLOSED may only be 1 or empty; refusing to start");
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

// The owner's takeover state, polled every second (never two polls at once). See createControlGuard:
// unsure counts as held, and the state opens only after sustained failure.
const guard = createControlGuard(failClosed ? { failuresToOpen: Number.POSITIVE_INFINITY } : {});
const calls = createCallTracker();
if (signedIn && controlUrl) {
  let polling = false;
  let warned = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    const seq = guard.next();
    try {
      const response = await fetch(controlUrl, { signal: AbortSignal.timeout(1500) });
      guard.result(seq, await response.json());
      warned = false;
    } catch {
      guard.failure(seq);
      if (!warned) log("could not read the takeover state from the relay");
      warned = true;
    } finally {
      polling = false;
      if (guard.held()) calls.markHeld();
    }
  };
  await poll();
  setInterval(() => void poll(), 1000).unref();
}

// Signed-in: Playwright MCP talks to the owner's Chromium only through the DevTools filter, which
// hides the owner's tabs (those open now, and those the owner opens while holding control).
if (signedIn) {
  const cdp = await startCdpFilter({ upstream: cdpEndpoint, held: () => guard.held(), log });
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
  const verdict = filterClientLine(line, { ownerControl: guard.held(), securing: guard.securing(), signedIn });
  if ("reply" in verdict) process.stdout.write(`${verdict.reply}\n`);
  else if ("forward" in verdict) {
    if (signedIn) calls.started(verdict.forward);
    child.stdin.write(`${verdict.forward}\n`);
  }
});
const fromServer = lineSplitter((line) => {
  let kept = filterServerLine(line, { signedIn });
  // A result that comes back while the owner holds control, or whose call overlapped a takeover, is withheld.
  if (kept !== null && signedIn) kept = calls.finish(kept, guard.held());
  if (kept !== null) process.stdout.write(`${kept}\n`);
});
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
