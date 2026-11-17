// Entry point of a Server browser session's browser container. The container is alone on an
// internal Docker network with no route out; Chromium reaches the web only through the session's
// proxy sidecar (BP_PROXY, see proxy-main.mjs). This writes the Playwright MCP config into the
// container's /tmp and runs the pinned Playwright MCP on this process's stdin and stdout (the MCP
// stdio transport), filtering both directions (mcp-filter.mjs). Logs go to stderr only, so stdout
// stays pure JSON-RPC. When the session closes stdin, Playwright MCP exits, this process exits, and
// `docker run --rm` removes the container. A killed `docker run` client may leave stdin open, so it
// also stops after BP_IDLE_TIMEOUT_S without any MCP message and after BP_MAX_LIFETIME_S in total.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { filterClientLine, filterServerLine, lineSplitter } from "./mcp-filter.mjs";
import { BLOCKED_HOST_SUFFIXES, normalizeAddress } from "./proxy.mjs";

const require = createRequire(import.meta.url);
const log = (message) => process.stderr.write(`[browser-prompt server browser] ${message}\n`);

const proxyServer = (process.env.BP_PROXY ?? "").trim();
if (!/^http:\/\/[0-9a-fA-F:.[\]]+:\d+$/.test(proxyServer)) {
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

const config = {
  browser: {
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
  },
  network: { blockedOrigins },
  outputDir,
  imageResponses: "allow",
  capabilities: [],
  // file:// navigation stays blocked (Playwright MCP's default; never allowUnrestrictedFileAccess).
  allowUnrestrictedFileAccess: false,
};
const configPath = `${work}/config.json`;
writeFileSync(configPath, JSON.stringify(config));

// cli.js is not in the package exports; find it next to its package.json.
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const child = spawn(process.execPath, [cli, "--config", configPath, "--headless", "--isolated", "--output-dir", outputDir, "--block-service-workers"], {
  cwd: work,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir },
});

let lastMessage = Date.now();
const fromAgent = lineSplitter((line) => {
  lastMessage = Date.now();
  const verdict = filterClientLine(line);
  if ("reply" in verdict) process.stdout.write(`${verdict.reply}\n`);
  else if ("forward" in verdict) child.stdin.write(`${verdict.forward}\n`);
});
const fromServer = lineSplitter((line) => process.stdout.write(`${filterServerLine(line)}\n`));
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
