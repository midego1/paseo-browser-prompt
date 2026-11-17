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
const CREATED = "__BP_CREATED__";

/** Replaces the placeholders in every argument. */
export function substitute(args, values) {
  return args.map((arg) => Object.entries(values).reduce((text, [key, value]) => text.split(key).join(value), arg));
}

const IMAGE_PREFIX = "browser-prompt-server-browser:";
/** Flags that would reach the host or lift the isolation; never allowed in any command of a plan. */
const FORBIDDEN_FLAGS = new Set([
  "-v",
  "--volume",
  "--mount",
  "--volumes-from",
  "--privileged",
  "--device",
  "--device-cgroup-rule",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
  "-p",
  "--publish",
  "-P",
  "--publish-all",
  "--add-host",
  "--gpus",
  "-t",
  "--tty",
]);

/** `--flag value` and `--flag=value` pairs of a docker command up to the image (which comes after the last flag). */
function flagPairs(args) {
  const pairs = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) pairs.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else pairs.push([arg, args[i + 1] ?? ""]);
  }
  return pairs;
}

/**
 * Checks a `docker run` of the plan (defense in depth: the plugin builds these, but the launcher
 * refuses anything that would weaken the isolation): the pinned image, no forbidden flag, no host
 * network, `--read-only` and `--cap-drop ALL`, `--cap-add` at most SYS_CHROOT (browser only), no
 * unconfined seccomp or AppArmor, no privileged mode.
 */
export function checkRun(args, role, networkName) {
  const pairs = flagPairs(args);
  const values = (flag) => pairs.filter(([name]) => name === flag).map(([, value]) => value);
  for (const [name] of pairs) if (FORBIDDEN_FLAGS.has(name)) throw new Error(`${role}: ${name} is not allowed`);
  if (!args.includes("--read-only")) throw new Error(`${role}: --read-only is required`);
  if (!values("--cap-drop").includes("ALL")) throw new Error(`${role}: --cap-drop ALL is required`);
  const added = values("--cap-add").map((cap) => cap.toUpperCase().replace(/^CAP_/, ""));
  if (added.some((cap) => cap !== "SYS_CHROOT") || (role !== "browser" && added.length > 0)) throw new Error(`${role}: --cap-add is limited to SYS_CHROOT for the browser`);
  for (const opt of values("--security-opt")) {
    if (/unconfined/i.test(opt) || /^apparmor[=:]/i.test(opt) || /^label[=:]disable/i.test(opt) || /^systempaths/i.test(opt)) throw new Error(`${role}: --security-opt ${opt} is not allowed`);
  }
  if (!values("--security-opt").includes("no-new-privileges")) throw new Error(`${role}: no-new-privileges is required`);
  const networks = [...values("--network"), ...values("--net")];
  const allowed = role === "browser" ? [networkName] : ["bridge"];
  if (networks.length !== 1 || !allowed.includes(networks[0])) throw new Error(`${role}: network must be ${allowed.join(" or ")}`);
  const image = role === "browser" ? args.at(-1) : args.at(-2);
  if (typeof image !== "string" || !image.startsWith(IMAGE_PREFIX) || image.endsWith(":latest")) throw new Error(`${role}: only the pinned Server browser image`);
  return args;
}

/** Validates a decoded plan: an absolute docker path, names, string arrays, and the isolation of every command. */
export function checkPlan(plan) {
  const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
  const name = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
  if (!plan || typeof plan !== "object") throw new Error("no plan");
  if (typeof plan.docker !== "string" || !plan.docker.startsWith("/")) throw new Error("docker must be an absolute path");
  if (!name(plan.network?.name) || !strings(plan.network?.create)) throw new Error("bad network");
  if (!name(plan.proxy?.name) || !strings(plan.proxy?.run)) throw new Error("bad proxy");
  if (!name(plan.browser?.name) || !strings(plan.browser?.run)) throw new Error("bad browser");
  if (plan.browser.run[0] !== "run" || plan.proxy.run[0] !== "run" || plan.network.create[0] !== "network") throw new Error("bad commands");
  const create = plan.network.create;
  if (create[1] !== "create" || !create.includes("--internal") || create.at(-1) !== plan.network.name) throw new Error("the session network must be created --internal");
  checkRun(plan.proxy.run, "proxy", plan.network.name);
  checkRun(plan.browser.run, "browser", plan.network.name);
  if (plan.proxy.run.at(-1) !== "/opt/browser-prompt/proxy-main.mjs") throw new Error("proxy: only the proxy entry point");
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
  const values = { [PID]: String(deps.pid ?? process.pid), [CREATED]: String(Math.floor((deps.now ?? Date.now)() / 1000)) };
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
