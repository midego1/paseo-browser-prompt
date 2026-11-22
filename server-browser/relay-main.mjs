// Entry point of the signed-in Server browser's relay container (see relay.mjs). It is the stack's
// only container with published ports (on the daemon host's Tailscale address or 127.0.0.1); it
// reaches neko on the stack's internal network. Configuration comes from the environment; logs go
// to stderr and never hold tickets, cookies, tokens or passwords. It stops itself after
// BP_MAX_LIFETIME_S.
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { parseOrigins, startRelay } from "./relay.mjs";

const log = (message) => process.stderr.write(`[browser-prompt relay] ${message}\n`);
const env = process.env;
const take = (name) => {
  const value = env[name] ?? "";
  delete env[name];
  return value;
};
const origins = parseOrigins(env.BP_PUBLIC_ORIGINS);
const nekoHost = (env.BP_NEKO_HOST ?? "").trim();
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(nekoHost)) {
  log("BP_NEKO_HOST is missing or not a host name");
  process.exit(1);
}
try {
  const relay = await startRelay({
    nekoHost,
    nekoPort: Number(env.BP_NEKO_PORT ?? "8080"),
    listenPort: Number(env.BP_LISTEN_PORT ?? "8080"),
    rtcPort: Number(env.BP_RTC_PORT ?? "0"),
    origins,
    secret: take("BP_VIEWER_SECRET"),
    statusToken: take("BP_STATUS_TOKEN"),
    adminPassword: take("BP_NEKO_ADMIN_PASSWORD"),
    userPassword: take("BP_NEKO_USER_PASSWORD"),
    landscape: env.BP_SCREEN_LANDSCAPE,
    portrait: env.BP_SCREEN_PORTRAIT,
    // Bitwarden in the browser: the run stays paused after a takeover until the daemon locked the vault.
    lockOnRelease: env.BP_LOCK_ON_RELEASE === "1",
    log,
  });
  log(`listening on ${relay.port}${relay.rtcPort ? ` and ${relay.rtcPort} (ICE-TCP)` : ""} for ${origins.join(", ")}`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void relay.close().finally(() => process.exit(0)));
  // A persistent stack's relay stops itself after BP_MAX_LIFETIME_S, but never while a viewer is
  // connected (it checks again every minute); the daemon starts a new one, neko keeps running.
  const lifetime = Number(env.BP_MAX_LIFETIME_S ?? "604800");
  const startedAt = Date.now();
  setInterval(() => {
    if (Date.now() - startedAt < Math.max(60, lifetime) * 1000 || relay.state().viewers > 0) return;
    log("reached the maximum lifetime; stopping");
    void relay.close().finally(() => process.exit(0));
  }, 60_000).unref();

  // The takeover state for the run's MCP container: only on the relay's address in the stack's
  // internal network (BP_CONTROL_SUBNET), which the daemon connects it to right after the start.
  const controlPort = Number(env.BP_CONTROL_PORT ?? "0");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec((env.BP_CONTROL_SUBNET ?? "").trim());
  if (controlPort && match) {
    const subnet = new BlockList();
    subnet.addSubnet(match[1], Number(match[2]), "ipv4");
    const until = Date.now() + 120_000;
    const find = () => {
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) if (isIP(entry.address) === 4 && subnet.check(entry.address, "ipv4")) return entry.address;
      }
      return null;
    };
    const tryStart = async () => {
      const address = find();
      if (address) {
        await relay.startControl(address, controlPort);
        log(`takeover state on ${address}:${controlPort}`);
      } else if (Date.now() < until) setTimeout(() => void tryStart(), 500);
      else log("not connected to the internal network; no takeover state");
    };
    void tryStart();
  }
} catch (error) {
  log(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
