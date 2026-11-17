// Entry point of a Server browser session's proxy sidecar. The sidecar is the only container of the
// session with a route out (Docker's default bridge); the browser container is alone on an internal
// network with no route and reaches nothing but this proxy. It accepts clients only from that
// internal network (BP_ALLOW_CLIENTS) and applies the policy in proxy.mjs. Logs go to stderr.
import { startProxy } from "./proxy.mjs";

const log = (message) => process.stderr.write(`[browser-prompt proxy] ${message}\n`);
const extraBlocked = (process.env.BP_BLOCKED_IPS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowClients = (process.env.BP_ALLOW_CLIENTS ?? "").trim();
if (!allowClients) {
  log("BP_ALLOW_CLIENTS is missing; refusing to start an open proxy");
  process.exit(1);
}
const port = Number(process.env.BP_PROXY_PORT ?? "3128");
const proxy = await startProxy({ extraBlocked, host: "0.0.0.0", port, allowClients, log });
log(`listening on port ${proxy.port} for ${allowClients}`);

const maxLifetimeSeconds = Number(process.env.BP_MAX_LIFETIME_S ?? "43200");
setTimeout(() => {
  log("reached the maximum lifetime; stopping");
  void proxy.close().finally(() => process.exit(0));
}, Math.max(60, maxLifetimeSeconds) * 1000).unref();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void proxy.close().finally(() => process.exit(0)));
