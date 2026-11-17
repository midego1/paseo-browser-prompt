#!/usr/bin/env node
// Host-side launcher for one Server browser session. The plugin writes this file to its state
// directory and gives the run agent an MCP server `node launch.mjs <plan>`; the plan (base64 JSON,
// built by `serverBrowserPlan` in shared/server-browser.ts) holds every docker argument. Steps:
//   1. create the session's internal network (no route out),
//   2. start the proxy sidecar on Docker's default bridge, accepting clients only from that network,
//   3. connect the sidecar to the internal network and read its address there,
//   4. run the browser container on the internal network only, attached to this process's stdio
//      (the MCP transport), with the sidecar as its proxy,
//   5. when the browser container ends (the session closed stdio) or a signal arrives, remove the
//      browser container, the sidecar and the network.
// Every resource carries this process's id as a label, so the plugin can remove what a killed
// launcher left behind. This process writes nothing to stdout: that belongs to the MCP stream.
// Node standard library only.
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PID = "__BP_PID__";
const SUBNET = "__BP_SUBNET__";
const PROXY_IP = "__BP_PROXY_IP__";

/** Replaces the placeholders in every argument. */
export function substitute(args, values) {
  return args.map((arg) => Object.entries(values).reduce((text, [key, value]) => text.split(key).join(value), arg));
}

/** Validates a decoded plan: an absolute docker path, names, and string arrays only. */
export function checkPlan(plan) {
  const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
  const name = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
  if (!plan || typeof plan !== "object") throw new Error("no plan");
  if (typeof plan.docker !== "string" || !plan.docker.startsWith("/")) throw new Error("docker must be an absolute path");
  if (!name(plan.network?.name) || !strings(plan.network?.create)) throw new Error("bad network");
  if (!name(plan.proxy?.name) || !strings(plan.proxy?.run)) throw new Error("bad proxy");
  if (!name(plan.browser?.name) || !strings(plan.browser?.run)) throw new Error("bad browser");
  if (plan.browser.run[0] !== "run" || plan.proxy.run[0] !== "run" || plan.network.create[0] !== "network") throw new Error("bad commands");
  return plan;
}

const defaultRun = (docker) => (args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    execFile(docker, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });

/**
 * Runs one session. `deps` (for tests): `run(args)` for docker commands, `spawnBrowser(args)` for
 * the attached browser container (returns a child with `on("exit")` and `kill()`), `pid`, `log`,
 * `onSignal(handler)`. Resolves with the exit code.
 */
export async function launch(plan, deps = {}) {
  checkPlan(plan);
  const run = deps.run ?? defaultRun(plan.docker);
  const log = deps.log ?? ((message) => process.stderr.write(`[browser-prompt launcher] ${message}\n`));
  const values = { [PID]: String(deps.pid ?? process.pid) };
  let cleaned = null;
  const cleanup = () =>
    (cleaned ??= (async () => {
      await run(["rm", "-f", plan.browser.name, plan.proxy.name], 30_000);
      await run(["network", "rm", plan.network.name], 30_000);
    })());
  // A signal before the browser runs stops the setup; after that it goes to the browser container.
  let child = null;
  let stopping = false;
  const onSignal = deps.onSignal ?? ((handler) => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => handler(signal));
  });
  onSignal((signal) => {
    if (child) child.kill(signal);
    else stopping = true;
  });
  const fail = async (step, result) => {
    log(`${step} failed: ${(result?.stderr || "").trim().slice(-300)}`);
    await cleanup();
    return 1;
  };

  const steps = async () => {
    let result = await run(substitute(plan.network.create, values));
    if (!result.ok) return fail("creating the internal network", result);
    if (stopping) return fail("setup (stopped)", null);
    result = await run(["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", plan.network.name]);
    const subnet = result.stdout.split(/\s+/).find((cidr) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(cidr));
    if (!result.ok || !subnet) return fail("reading the internal network", result);
    values[SUBNET] = subnet;

    result = await run(substitute(plan.proxy.run, values));
    if (!result.ok) return fail("starting the proxy", result);
    result = await run(["network", "connect", plan.network.name, plan.proxy.name]);
    if (!result.ok) return fail("connecting the proxy to the internal network", result);
    result = await run(["inspect", "--format", `{{(index .NetworkSettings.Networks "${plan.network.name}").IPAddress}}`, plan.proxy.name]);
    const proxyIp = result.stdout.trim();
    if (!result.ok || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(proxyIp)) return fail("reading the proxy address", result);
    values[PROXY_IP] = proxyIp;
    if (stopping) return fail("setup (stopped)", null);
    return null;
  };
  const failed = await steps();
  if (failed !== null) return failed;

  const spawnBrowser = deps.spawnBrowser ?? ((args) => spawn(plan.docker, args, { stdio: "inherit" }));
  child = spawnBrowser(substitute(plan.browser.run, values));
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
  await cleanup();
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let plan;
  try {
    plan = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"));
  } catch {
    process.stderr.write("[browser-prompt launcher] the plan is not valid\n");
    process.exit(2);
  }
  launch(plan).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[browser-prompt launcher] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
