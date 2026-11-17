// Container entry point for the browser-prompt Server browser: starts the filtering proxy
// (proxy.mjs), writes the Playwright MCP config into the container's /tmp, then runs the pinned
// Playwright MCP on this process's stdin and stdout (the MCP stdio transport). Logs go to stderr
// only, so stdout stays pure JSON-RPC. When the agent session closes stdin, Playwright MCP exits,
// this process exits, and `docker run --rm` removes the container. A killed `docker run` client
// does not close the container's stdin, so the container also stops itself after BP_IDLE_TIMEOUT_S
// without any MCP message and after BP_MAX_LIFETIME_S in total.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BLOCKED_HOST_SUFFIXES, startProxy } from "./proxy.mjs";

const require = createRequire(import.meta.url);
const log = (message) => process.stderr.write(`[browser-prompt server browser] ${message}\n`);

const extraBlocked = (process.env.BP_BLOCKED_IPS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const maxLifetimeSeconds = Number(process.env.BP_MAX_LIFETIME_S ?? "43200");
const idleTimeoutSeconds = Number(process.env.BP_IDLE_TIMEOUT_S ?? "7200");

const proxy = await startProxy({ extraBlocked, log });

const work = "/tmp/browser-prompt";
const outputDir = `${work}/output`;
mkdirSync(outputDir, { recursive: true });
mkdirSync(process.env.HOME || "/tmp/home", { recursive: true });

// Origin rules on top of the proxy (defense in depth; the proxy is the boundary): tailnet and
// local names, and the host's own addresses.
const blockedOrigins = [
  ...BLOCKED_HOST_SUFFIXES.flatMap((suffix) => [suffix, `*.${suffix}`]),
  ...proxy.policy.extras.map((address) => (address.includes(":") ? `[${address}]` : address)),
];

const config = {
  browser: {
    browserName: "chromium",
    isolated: true,
    launchOptions: {
      // The image's bundled Chromium (Playwright MCP defaults to the Chrome channel, not installed).
      channel: "chromium",
      headless: true,
      // Chromium's own sandbox needs user namespaces or a setuid helper, which --cap-drop=ALL,
      // no-new-privileges and Docker's seccomp profile refuse. The container is the sandbox.
      chromiumSandbox: false,
      // Every request goes through the proxy; Playwright adds <-loopback> so loopback is proxied too.
      proxy: { server: `http://127.0.0.1:${proxy.port}` },
      args: [
        // WebRTC may not send UDP around the proxy (it could reach private addresses directly).
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
};
const configPath = `${work}/config.json`;
writeFileSync(configPath, JSON.stringify(config));

// cli.js is not in the package exports; find it next to its package.json.
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const child = spawn(process.execPath, [cli, "--config", configPath, "--headless", "--isolated", "--output-dir", outputDir, "--block-service-workers"], {
  // stdin is passed through here, so the idle timer sees the session's messages; stdout and
  // stderr go straight to the container's.
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir },
});

let lastMessage = Date.now();
process.stdin.on("data", (chunk) => {
  lastMessage = Date.now();
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
process.stdin.on("error", () => child.stdin.end());
child.stdin.on("error", () => {});
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

child.on("exit", (code, signal) => {
  void proxy.close().finally(() => process.exit(code ?? (signal ? 1 : 0)));
});
child.on("error", (error) => {
  log(`could not start Playwright MCP: ${error.message}`);
  process.exit(1);
});
