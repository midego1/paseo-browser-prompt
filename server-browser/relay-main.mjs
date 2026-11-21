// Entry point of the signed-in Server browser's relay container (see relay.mjs). It is the stack's
// only container with published ports (on the daemon host's Tailscale address or 127.0.0.1); it
// reaches neko on the stack's internal network. Configuration comes from the environment; logs go
// to stderr and never hold tickets, cookies, tokens or passwords. It stops itself after
// BP_MAX_LIFETIME_S.
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
    controlPort: Number(env.BP_CONTROL_PORT ?? "0"),
    origins,
    secret: take("BP_VIEWER_SECRET"),
    statusToken: take("BP_STATUS_TOKEN"),
    adminPassword: take("BP_NEKO_ADMIN_PASSWORD"),
    landscape: env.BP_SCREEN_LANDSCAPE,
    portrait: env.BP_SCREEN_PORTRAIT,
    log,
  });
  log(`listening on ${relay.port}${relay.rtcPort ? ` and ${relay.rtcPort} (ICE-TCP)` : ""} for ${origins.join(", ")}`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void relay.close().finally(() => process.exit(0)));
  // A persistent stack's relay still stops itself after BP_MAX_LIFETIME_S (the daemon starts a new one when needed).
  const lifetime = Number(env.BP_MAX_LIFETIME_S ?? "604800");
  setTimeout(() => {
    log("reached the maximum lifetime; stopping");
    void relay.close().finally(() => process.exit(0));
  }, Math.min(2_000_000_000, Math.max(60, lifetime) * 1000)).unref();
} catch (error) {
  log(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
