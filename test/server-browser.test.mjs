// Run: npm test. The Server browser: the docker arguments of the browser container, the proxy
// sidecar and the internal network, the host launcher that wires them up and tears them down, the
// MCP stdio filter, the network policy of the proxy (also end to end on 127.0.0.1), which agent
// sessions get the MCP server (labels, one-time ticket, run record), status, build, the run cap and
// the sweep of leftovers, the prompt variant, and that the embedded files match server-browser/.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import {
  AGENT_SAFETY_PREAMBLE,
  buildAgentPrompt,
  CHROME_SAFETY_PREAMBLE,
  CLOSE_TABS_RULE,
  describeLaunch,
  parseBrowserAgent,
  resolveAgentConfig,
  runBrowserOf,
  RUN_SUCCESS_RULE,
  SCREENSHOT_RULE,
  SERVER_BROWSER_DENIED_TOOLS,
  SERVER_BROWSER_TOOLS,
  SERVER_SAFETY_PREAMBLE,
  SERVER_SCREENSHOT_RULE,
  DEFAULT_AGENT_SETTINGS,
} from "../shared/agent-prompt.ts";
import { permissionDetails } from "../shared/owner-prompt.ts";
import { runLabels } from "../shared/report-back.ts";
import { isScreenshotTool } from "../shared/screenshot.ts";
import {
  BASE_IMAGE,
  BROWSER_LABEL,
  CONTAINER_AGENT_LABEL,
  CONTAINER_LABEL,
  containerName,
  createTicketStore,
  hostAddressesToBlock,
  isServerBrowserRun,
  CREATED_LABEL,
  INSTANCE_LABEL,
  LAUNCHER_PID_LABEL,
  MAX_SERVER_BROWSER_RUNS,
  SECCOMP_PROFILE_SHA256,
  SECCOMP_PROFILE_SOURCE,
  STARTING_WINDOW_MS,
  SWEEP_MIN_AGE_MS,
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
  SERVER_BROWSER_MCP_NAME,
  SERVER_BROWSER_STATE_MESSAGES,
  SERVER_BROWSER_STATES,
  SERVER_RUN_MARKER,
  serverBrowserDockerArgs,
  serverBrowserImageTag,
  serverBrowserMcpServer,
  serverBrowserNetworkArgs,
  serverBrowserPlan,
  serverBrowserProxyArgs,
  serverRunLabels,
  serverRunRecorded,
  SESSION_LABEL,
  sessionNames,
  shouldAttachServerBrowser,
  TICKET_LABEL,
} from "../shared/server-browser.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import {
  contextHash,
  createServerBrowser,
  currentImageTag,
  findDocker,
  findNode,
  loadInstanceId,
  processAlive,
  registerServerBrowser,
  resolveDockerHost,
  shortError,
} from "../server/server-browser.ts";
import { SERVER_BROWSER_FILES, SERVER_BROWSER_RUNTIME_FILES } from "../server/server-browser-files.ts";
import { renderEmbedded, SERVER_BROWSER_FILE_NAMES, SERVER_BROWSER_RUNTIME_FILE_NAMES } from "../scripts/embed-server-browser.mjs";
import {
  BLOCKED_HOST_SUFFIXES,
  connectFirst,
  createClientCheck,
  createPolicy,
  normalizeAddress,
  parseAuthority,
  resolveTarget,
  startProxy,
} from "../server-browser/proxy.mjs";
import { ALLOWED_TOOLS, DENIED_TOOLS, DENIED_TEXT, filterClientLine, filterServerLine, lineSplitter, toolAllowed } from "../server-browser/mcp-filter.mjs";
import { checkPlan, checkRun, launch, substitute } from "../server-browser/launch.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const IMAGE = serverBrowserImageTag("ab".repeat(32));
const SECCOMP = "/state/server-browser/runtime-x/seccomp.json";
const INSTANCE = "paseo-box-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const input = (extra = {}) => ({ image: IMAGE, agentId: "agent-1", nonce: "n0nce", blockedIps: ["100.96.145.38", "152.53.114.172"], seccompProfile: SECCOMP, instance: INSTANCE, ...extra });
const argsFor = (extra = {}) => serverBrowserDockerArgs(input(extra));
const flagValues = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
const FORBIDDEN = ["-v", "--volume", "--mount", "--device", "--privileged", "--pid", "--ipc", "--userns", "-p", "--publish", "-P", "-t", "--add-host", "--net", "--volumes-from"];
const noHostAccess = (args) => {
  for (const flag of FORBIDDEN) assert.ok(!args.includes(flag), flag);
  assert.ok(!args.some((arg) => /^host$|unconfined|docker\.sock|apparmor/.test(arg)), "no host network, no unconfined profile, no socket");
};
const sessionLabelsOf = (role) => [
  `${CONTAINER_LABEL}=${role}`,
  `${CONTAINER_AGENT_LABEL}=agent-1`,
  `${SESSION_LABEL}=bp-sb-agent-1-n0nce`,
  `${LAUNCHER_PID_LABEL}=__BP_PID__`,
  `${INSTANCE_LABEL}=${INSTANCE}`,
  `${CREATED_LABEL}=__BP_CREATED__`,
];

test("browser container: internal network only, Chromium sandbox, every other isolation flag, the pinned image last", () => {
  const args = argsFor();
  assert.deepEqual(args.slice(0, 4), ["run", "-i", "--rm", "--init"]);
  assert.equal(args.at(-1), IMAGE, "the image comes last, nothing after it");
  assert.deepEqual(flagValues(args, "--pull"), ["never"]);
  assert.deepEqual(flagValues(args, "--network"), ["bp-sb-agent-1-n0nce-net"], "the session's internal network, never bridge or host");
  assert.deepEqual(flagValues(args, "--dns"), [], "no resolver: external names do not resolve on the internal network");
  assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(args, "--cap-add"), ["SYS_CHROOT"], "only for Chromium's sandbox inside its user namespace");
  assert.deepEqual(flagValues(args, "--security-opt"), ["no-new-privileges", `seccomp=${SECCOMP}`]);
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(flagValues(args, "--tmpfs"), ["/tmp:rw,nosuid,nodev,size=512m"]);
  assert.deepEqual(flagValues(args, "--memory"), ["1536m"]);
  assert.deepEqual(flagValues(args, "--memory-swap"), ["1536m"], "no swap on top");
  assert.deepEqual(flagValues(args, "--cpus"), ["1.5"]);
  assert.deepEqual(flagValues(args, "--pids-limit"), ["512"]);
  assert.deepEqual(flagValues(args, "--user"), ["pwuser"]);
  assert.deepEqual(flagValues(args, "--log-driver"), ["none"]);
  assert.deepEqual(flagValues(args, "--name"), ["bp-sb-agent-1-n0nce"]);
  assert.deepEqual(flagValues(args, "--label"), sessionLabelsOf("browser"));
  const env = flagValues(args, "--env");
  assert.ok(env.includes("BP_PROXY=http://__BP_PROXY_IP__:3128"), "the sidecar is its proxy");
  assert.ok(env.includes("BP_BLOCKED_IPS=100.96.145.38,152.53.114.172"));
  assert.ok(env.includes("BP_MAX_LIFETIME_S=43200"));
  assert.ok(env.includes("BP_IDLE_TIMEOUT_S=7200"));
  noHostAccess(args);
});

test("proxy sidecar: the only container with a route out, hardened the same way, clients only from the internal network", () => {
  const args = serverBrowserProxyArgs(input());
  assert.deepEqual(args.slice(0, 4), ["run", "-d", "--rm", "--init"]);
  assert.deepEqual(args.slice(-3), ["node", IMAGE, "/opt/browser-prompt/proxy-main.mjs"]);
  assert.deepEqual(flagValues(args, "--entrypoint"), ["node"]);
  assert.deepEqual(flagValues(args, "--pull"), ["never"]);
  assert.deepEqual(flagValues(args, "--network"), ["bridge"]);
  assert.deepEqual(flagValues(args, "--dns"), ["1.1.1.1", "9.9.9.9"]);
  assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(args, "--cap-add"), []);
  assert.deepEqual(flagValues(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(flagValues(args, "--memory"), ["256m"]);
  assert.deepEqual(flagValues(args, "--memory-swap"), ["256m"]);
  assert.deepEqual(flagValues(args, "--pids-limit"), ["64"]);
  assert.deepEqual(flagValues(args, "--user"), ["pwuser"]);
  assert.deepEqual(flagValues(args, "--log-driver"), ["none"]);
  assert.deepEqual(flagValues(args, "--name"), ["bp-sb-agent-1-n0nce-proxy"]);
  assert.deepEqual(flagValues(args, "--label"), sessionLabelsOf("proxy"));
  const env = flagValues(args, "--env");
  assert.ok(env.includes("BP_ALLOW_CLIENTS=__BP_SUBNET__"));
  assert.ok(env.includes("BP_BLOCKED_IPS=100.96.145.38,152.53.114.172"));
  noHostAccess(args);
  const network = serverBrowserNetworkArgs(input());
  assert.deepEqual(network.slice(0, 5), ["network", "create", "--internal", "--driver", "bridge"]);
  assert.equal(network.at(-1), "bp-sb-agent-1-n0nce-net");
  assert.deepEqual(flagValues(network, "--label"), sessionLabelsOf("network"));
  assert.deepEqual(sessionNames("agent-1", "n0nce"), { browser: "bp-sb-agent-1-n0nce", proxy: "bp-sb-agent-1-n0nce-proxy", network: "bp-sb-agent-1-n0nce-net" });
});

test("docker arguments refuse other images, odd agent ids, odd profile paths and non-addresses", () => {
  assert.throws(() => argsFor({ image: "browser-prompt-server-browser:latest" }), /pinned image/);
  assert.throws(() => argsFor({ image: "mcr.microsoft.com/playwright:v1.65.1-noble" }), /pinned image/);
  assert.throws(() => serverBrowserProxyArgs(input({ image: "alpine:3" })), /pinned image/);
  assert.throws(() => argsFor({ agentId: "a; rm -rf /" }), /agent id/);
  assert.throws(() => argsFor({ agentId: "" }), /agent id/);
  assert.throws(() => argsFor({ seccompProfile: "relative.json" }), /absolute path/);
  assert.throws(() => argsFor({ seccompProfile: "/x.json,unconfined" }), /absolute path/);
  const env = flagValues(argsFor({ blockedIps: ["10.0.0.1", "x,y", "1.2.3.4 --privileged"] }), "--env");
  assert.ok(env.includes("BP_BLOCKED_IPS=10.0.0.1"), env.join(" "));
  assert.equal(containerName("a".repeat(100), "zz-99!"), `bp-sb-${"a".repeat(36)}-zz99`);
  assert.throws(() => serverBrowserPlan("docker", input()), /absolute path/);
});

test("the plan and the MCP server: node runs the launcher with the plan; DOCKER_HOST only when known", () => {
  const plan = serverBrowserPlan("/usr/bin/docker", input());
  assert.deepEqual(Object.keys(plan), ["docker", "network", "proxy", "browser"]);
  assert.equal(checkPlan(plan), plan, "the launcher accepts what the plugin builds");
  const server = serverBrowserMcpServer("/usr/bin/node", "/state/launch.mjs", plan, null);
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "/usr/bin/node");
  assert.equal(server.args[0], "/state/launch.mjs");
  assert.deepEqual(JSON.parse(Buffer.from(server.args[1], "base64").toString("utf8")), plan);
  assert.equal(server.env, undefined);
  assert.deepEqual(serverBrowserMcpServer("/usr/bin/node", "/l.mjs", plan, "unix:///run/user/1001/docker.sock").env, { DOCKER_HOST: "unix:///run/user/1001/docker.sock" });
  for (const bad of [null, {}, { ...plan, docker: "docker" }, { ...plan, browser: { name: "x; y", run: ["run"] } }, { ...plan, proxy: { name: "p", run: ["exec"] } }, { ...plan, network: { name: "n", create: [] } }]) {
    assert.throws(() => checkPlan(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});

/** A fake docker for the launcher: records commands, answers inspect, and a browser child it controls. */
function fakeLauncherDeps({ fail = "" } = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => child.killed.push(signal);
  let signalHandler = null;
  const deps = {
    pid: 4242,
    now: () => 1_800_000_000_000,
    log: () => {},
    onSignal: (handler) => (signalHandler = handler),
    run: async (args) => {
      calls.push(args);
      if (fail && args.join(" ").includes(fail)) return { ok: false, stdout: "", stderr: "boom" };
      if (args[0] === "network" && args[1] === "inspect") return { ok: true, stdout: "172.19.0.0/16 fd00::/64 ", stderr: "" };
      if (args[0] === "inspect") return { ok: true, stdout: "172.19.0.2\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
    spawnBrowser: (args) => {
      calls.push(["SPAWN", ...args]);
      return child;
    },
  };
  return { deps, calls, child, signal: (s) => signalHandler(s) };
}

test("the launcher creates the network, starts and connects the sidecar, runs the browser with its address, and removes everything after", async () => {
  const plan = serverBrowserPlan("/usr/bin/docker", input());
  const fake = fakeLauncherDeps();
  const done = launch(plan, fake.deps);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const steps = fake.calls.map((call) => call.slice(0, 2).join(" "));
  assert.deepEqual(steps, ["network create", "network inspect", "run -d", "network connect", "inspect --format", "SPAWN run"]);
  assert.ok(fake.calls[0].includes(`${LAUNCHER_PID_LABEL}=4242`), "the launcher's pid goes on every resource");
  assert.ok(fake.calls[0].includes(`${CREATED_LABEL}=1800000000`), "and its creation time");
  assert.ok(fake.calls[2].includes(`${INSTANCE_LABEL}=${INSTANCE}`) && fake.calls[5].includes(`${CREATED_LABEL}=1800000000`));
  assert.ok(fake.calls[2].includes("BP_ALLOW_CLIENTS=172.19.0.0/16"), "the sidecar serves only the internal network");
  assert.deepEqual(fake.calls[3], ["network", "connect", "bp-sb-agent-1-n0nce-net", "bp-sb-agent-1-n0nce-proxy"]);
  const browser = fake.calls[5];
  assert.ok(browser.includes("BP_PROXY=http://172.19.0.2:3128"));
  assert.ok(!browser.some((arg) => arg.includes("__BP_")), "no placeholder left");
  fake.signal("SIGTERM");
  assert.deepEqual(fake.child.killed, ["SIGTERM"], "a signal goes to the browser container");
  fake.child.emit("exit", 0, null);
  assert.equal(await done, 0);
  assert.deepEqual(fake.calls.slice(-2), [["rm", "-f", "bp-sb-agent-1-n0nce", "bp-sb-agent-1-n0nce-proxy"], ["network", "rm", "bp-sb-agent-1-n0nce-net"]]);
  assert.deepEqual(substitute(["a__BP_PID__b", "x"], { __BP_PID__: "7" }), ["a7b", "x"]);
});

test("the launcher cleans up when a step fails or a signal arrives before the browser runs", async () => {
  const plan = serverBrowserPlan("/usr/bin/docker", input());
  const failing = fakeLauncherDeps({ fail: "network connect" });
  assert.equal(await launch(plan, failing.deps), 1);
  assert.ok(!failing.calls.some((call) => call[0] === "SPAWN"), "no browser without its proxy");
  assert.deepEqual(failing.calls.slice(-2), [["rm", "-f", "bp-sb-agent-1-n0nce", "bp-sb-agent-1-n0nce-proxy"], ["network", "rm", "bp-sb-agent-1-n0nce-net"]]);
  const stopped = fakeLauncherDeps();
  const originalRun = stopped.deps.run;
  stopped.deps.run = async (args) => {
    const result = await originalRun(args);
    if (args[0] === "network" && args[1] === "create") stopped.signal("SIGTERM");
    return result;
  };
  assert.equal(await launch(plan, stopped.deps), 1);
  assert.ok(!stopped.calls.some((call) => call[0] === "SPAWN"));
  assert.deepEqual(stopped.calls.at(-1), ["network", "rm", "bp-sb-agent-1-n0nce-net"]);
});

test("the MCP filter removes and refuses the tools that run code or pick files", () => {
  for (const tool of SERVER_BROWSER_DENIED_TOOLS) assert.ok(DENIED_TOOLS.has(tool), tool);
  assert.deepEqual([...DENIED_TOOLS].sort(), [...SERVER_BROWSER_DENIED_TOOLS].sort(), "the prompt names exactly the denied tools");
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "browser_navigate" }, { name: "browser_run_code_unsafe" }, { name: "browser_file_upload" }, { name: "browser_drop" }, { name: "browser_snapshot" }] } });
  assert.deepEqual(JSON.parse(filterServerLine(list)).result.tools.map((tool) => tool.name), ["browser_navigate", "browser_snapshot"]);
  const other = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } });
  assert.equal(filterServerLine(other), other, "other messages pass unchanged");
  assert.equal(filterServerLine("not json"), null, "non-JSON from the server is dropped");
  assert.equal(filterServerLine("[1,2]"), null);
  const unknown = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "browser_navigate" }, { name: "browser_emulate_media" }, { name: "browser_network_request" }, { name: "browser_new_tool" }] } });
  assert.deepEqual(JSON.parse(filterServerLine(unknown)).result.tools.map((tool) => tool.name), ["browser_navigate"], "allowlist: unknown tools are not listed");
  const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_run_code_unsafe", arguments: { code: "async () => require('fs')" } } });
  const verdict = filterClientLine(call);
  assert.deepEqual(JSON.parse(verdict.reply), { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: DENIED_TEXT }], isError: true } });
  assert.deepEqual(filterClientLine(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "browser_file_upload" } })), { drop: true });
  const allowed = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://example.com" } } });
  assert.deepEqual(filterClientLine(allowed), { forward: allowed });
  const notListed = filterClientLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_emulate_media" } }));
  assert.equal(JSON.parse(notListed.reply).result.isError, true, "a tool not on the allowlist is refused");
  assert.equal(JSON.parse(filterClientLine(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: {} })).reply).result.isError, true, "no name");
  // Batches and other JSON values never reach Playwright MCP.
  assert.deepEqual(filterClientLine(JSON.stringify([{ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "browser_run_code_unsafe" } }])), { drop: true });
  for (const value of ["42", '"text"', "null", "true", "not json", ""]) assert.deepEqual(filterClientLine(value), { drop: true }, value);
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(filterClientLine(init), { forward: init }, "other requests pass");
  // The allowlist is the preamble's tool list, and no denied tool is on it.
  assert.deepEqual([...ALLOWED_TOOLS].sort(), [...SERVER_BROWSER_TOOLS].sort());
  for (const tool of DENIED_TOOLS) assert.equal(toolAllowed(tool), false, tool);
  const lines = [];
  const split = lineSplitter((line) => lines.push(line));
  split.push('{"a":1}\n{"b"');
  split.push(':2}\n{"c":3}');
  split.end();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("the image tag is pinned and versioned, never latest", () => {
  assert.equal(IMAGE, `browser-prompt-server-browser:pw${PLAYWRIGHT_VERSION}-mcp${PLAYWRIGHT_MCP_VERSION}-abababababab`);
  assert.throws(() => serverBrowserImageTag(""), /hash/);
  const tag = currentImageTag();
  assert.match(tag, /^browser-prompt-server-browser:pw1\.65\.1-mcp0\.0\.84-[0-9a-f]{12}$/);
  assert.equal(currentImageTag({ ...SERVER_BROWSER_FILES }), tag, "same files, same tag");
  assert.notEqual(currentImageTag({ ...SERVER_BROWSER_FILES, "proxy.mjs": "changed" }), tag, "any change rebuilds");
  assert.equal(contextHash({ b: "2", a: "1" }), contextHash({ a: "1", b: "2" }), "order does not matter");
});

test("the build context is pinned: base image digest, exact Playwright MCP version, Playwright overridden to the image's, lock file", () => {
  const dockerfile = readFileSync(new URL("../server-browser/Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(`FROM ${BASE_IMAGE}`), "FROM by digest");
  assert.match(BASE_IMAGE, /^mcr\.microsoft\.com\/playwright:v1\.65\.1-noble@sha256:[0-9a-f]{64}$/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER pwuser$/m);
  assert.match(dockerfile, /COPY proxy\.mjs proxy-main\.mjs mcp-filter\.mjs cdp-filter\.mjs entrypoint\.mjs relay\.mjs relay-main\.mjs bitwarden-lock\.mjs \.\//);
  const pkg = JSON.parse(readFileSync(new URL("../server-browser/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@playwright/mcp"], PLAYWRIGHT_MCP_VERSION, "exact version, no range");
  assert.deepEqual(pkg.overrides, { playwright: PLAYWRIGHT_VERSION, "playwright-core": PLAYWRIGHT_VERSION }, "the browser the image ships");
  const lock = JSON.parse(readFileSync(new URL("../server-browser/package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages["node_modules/@playwright/mcp"].version, PLAYWRIGHT_MCP_VERSION);
  assert.match(lock.packages["node_modules/@playwright/mcp"].integrity, /^sha512-/);
  assert.equal(lock.packages["node_modules/playwright-core"].version, PLAYWRIGHT_VERSION);
  assert.equal(lock.packages["node_modules/playwright"].version, PLAYWRIGHT_VERSION);
  for (const doc of ["../SECURITY.md", "../README.md"]) {
    assert.match(readFileSync(new URL(doc, import.meta.url), "utf8"), /[Rr]elease checklist/, `${doc} has the bump-on-release line`);
  }
});

test("the embedded files match server-browser/ (run scripts/embed-server-browser.mjs)", () => {
  const generated = readFileSync(new URL("../server/server-browser-files.ts", import.meta.url), "utf8");
  assert.equal(generated, renderEmbedded());
  assert.deepEqual(Object.keys(SERVER_BROWSER_FILES).sort(), [...SERVER_BROWSER_FILE_NAMES].sort());
  assert.deepEqual(Object.keys(SERVER_BROWSER_RUNTIME_FILES).sort(), [...SERVER_BROWSER_RUNTIME_FILE_NAMES].sort());
  assert.ok(!("launch.mjs" in SERVER_BROWSER_FILES), "the launcher is not part of the image or its tag");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("server-browser/"), "the Dockerfile ships with the plugin");
});

test("the seccomp profile is Playwright's: Docker's default plus user namespaces, nothing unconfined", () => {
  const profile = JSON.parse(SERVER_BROWSER_RUNTIME_FILES["seccomp.json"]);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO", "deny by default");
  const unconditional = profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.includes?.caps?.length && !rule.args?.length);
  const names = new Set(unconditional.flatMap((rule) => rule.names));
  for (const call of ["clone", "unshare", "setns"]) assert.ok(names.has(call), call);
  for (const call of ["mount", "bpf", "kexec_load", "init_module", "chroot", "pivot_root"]) assert.ok(!names.has(call), `${call} stays behind a capability`);
});

test("the entrypoint: headless, isolated, Chromium sandbox on, only the sidecar as proxy, file:// blocked, filtered stdio", () => {
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  for (const flag of ['"--headless"', '"--isolated"', '"--output-dir"', '"--block-service-workers"']) assert.ok(entry.includes(flag), flag);
  assert.match(entry, /chromiumSandbox: true/);
  assert.match(entry, /proxy: \{ server: proxyServer \}/);
  assert.match(entry, /refusing to start without the proxy/, "no proxy, no browser");
  assert.match(entry, /allowUnrestrictedFileAccess: false/);
  assert.match(entry, /disable_non_proxied_udp/);
  assert.match(entry, /acceptDownloads: false/);
  assert.match(entry, /const work = "\/tmp\/browser-prompt";/, "output only under the container's tmpfs");
  assert.match(entry, /stdio: \["pipe", "pipe", "inherit"\]/, "both MCP directions go through the filter");
  assert.match(entry, /filterClientLine\(line, \{ ownerControl: guard\.held\(\), securing: guard\.securing\(\), lockFailed: guard\.lockFailed\(\), signedIn \}\)/);
  assert.match(entry, /filterServerLine\(line, \{ signedIn \}\)/);
  assert.match(entry, /BP_IDLE_TIMEOUT_S/);
  assert.doesNotMatch(entry, /console\.log/, "stdout stays JSON-RPC");
  const main = readFileSync(new URL("../server-browser/proxy-main.mjs", import.meta.url), "utf8");
  assert.match(main, /refusing to start an open proxy/);
  assert.match(main, /host: "0\.0\.0\.0", port, allowClients/);
  const launcher = readFileSync(new URL("../server-browser/launch.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /console\.log|process\.stdout/, "the launcher never writes to the MCP stream");
});

test("network policy: private, tailnet, loopback, link-local and reserved addresses are blocked", () => {
  const policy = createPolicy(["152.53.114.172", "2a0a:4cc0:80:49f5::1"]);
  const blocked = [
    "10.1.2.3", "100.64.0.1", "100.96.145.38", "100.127.255.255", "127.0.0.1", "127.255.0.1", "169.254.169.254",
    "172.16.0.1", "172.17.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fc00::1", "fd7a:115c:a1e0::ea37:9127", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001::1", "[::1]", "fe80::1%eth0",
    "152.53.114.172", "2a0a:4cc0:80:49f5::1", "not-an-ip",
  ];
  for (const address of blocked) assert.equal(policy.blockedAddress(address), true, address);
  for (const address of ["93.184.215.14", "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) {
    assert.equal(policy.blockedAddress(address), false, address);
  }
  assert.equal(normalizeAddress("::FFFF:192.168.0.1"), "192.168.0.1");
  assert.deepEqual(policy.extras, ["152.53.114.172", "2a0a:4cc0:80:49f5::1"]);
});

test("network policy: tailnet and local names are blocked whatever they resolve to", () => {
  const policy = createPolicy();
  for (const host of ["localhost", "LOCALHOST.", "app.localhost", "paseo-box.tail60821.ts.net", "ts.net", "x.beta.tailscale.net", "printer.local", "host.docker.internal", "router.home.arpa", "nas.lan", "", "100.96.145.38", "[::1]"]) {
    assert.equal(policy.blockedName(host), true, host);
  }
  for (const host of ["example.com", "tailscale.com", "ts.network", "notlocal", "1.1.1.1"]) assert.equal(policy.blockedName(host), false, host);
  for (const required of ["ts.net", "localhost", "local", "internal"]) assert.ok(BLOCKED_HOST_SUFFIXES.includes(required));
});

test("resolveTarget connects only to the checked address and refuses names with any private address", async () => {
  const policy = createPolicy();
  const dns = (map) => async (host) => {
    if (!(host in map)) throw new Error("ENOTFOUND");
    return map[host];
  };
  assert.deepEqual(await resolveTarget(policy, "example.com", dns({ "example.com": ["93.184.215.14"] })), { address: "93.184.215.14", family: 4, addresses: ["93.184.215.14"] });
  assert.deepEqual(
    await resolveTarget(policy, "two.example", dns({ "two.example": ["93.184.215.14", "2606:4700::1111"] })),
    { address: "93.184.215.14", family: 4, addresses: ["93.184.215.14", "2606:4700::1111"] },
    "every checked address is kept for fallback",
  );
  assert.deepEqual(await resolveTarget(policy, "rebind.example", dns({ "rebind.example": ["127.0.0.1"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "mixed.example", dns({ "mixed.example": ["93.184.215.14", "10.0.0.5"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "mapped.example", dns({ "mapped.example": ["::ffff:192.168.0.10"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "gone.example", dns({})), { refused: "not found" });
  assert.deepEqual(await resolveTarget(policy, "empty.example", dns({ "empty.example": [] })), { refused: "not found" });
  assert.deepEqual(await resolveTarget(policy, "x.tail1234.ts.net", dns({ "x.tail1234.ts.net": ["93.184.215.14"] })), { refused: "blocked host" });
  assert.deepEqual(await resolveTarget(policy, "100.96.145.38", dns({})), { refused: "blocked host" });
  assert.deepEqual(await resolveTarget(policy, "[2606:4700::1111]", dns({})), { address: "2606:4700::1111", family: 6, addresses: ["2606:4700::1111"] });
  assert.deepEqual(parseAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseAuthority("[::1]:8080"), { host: "::1", port: 8080 });
  for (const bad of ["example.com", "a:0", "a:70000", ":443", "a:b:443", ""]) assert.equal(parseAuthority(bad), null, bad);
});

/** Raw request to the proxy; resolves with the first response line and the body. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 1500);
  });
}

test("the proxy refuses CONNECT and plain HTTP to loopback and tailnet addresses (end to end)", async () => {
  const proxy = await startProxy({ resolve: async () => ["127.0.0.1"] });
  try {
    const connectReply = await rawRequest(proxy.port, "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n");
    assert.match(connectReply, /^HTTP\/1\.1 403 Forbidden/);
    assert.match(connectReply, /X-Browser-Prompt-Blocked: blocked-host/);
    const tailnet = await rawRequest(proxy.port, "CONNECT 100.96.145.38:5310 HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(tailnet, /^HTTP\/1\.1 403/);
    const rebind = await rawRequest(proxy.port, "CONNECT evil.example:443 HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(rebind, /blocked-address/, "a public name that resolves to loopback");
    const plain = await rawRequest(proxy.port, "GET http://paseo-box.tail60821.ts.net/ HTTP/1.1\r\nHost: paseo-box.tail60821.ts.net\r\nConnection: close\r\n\r\n");
    assert.match(plain, /^HTTP\/1\.1 403/);
    assert.match(plain, /Blocked by the browser-prompt Server browser/);
    const origin = await rawRequest(proxy.port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(origin, /^HTTP\/1\.1 400/, "not a proxy request");
  } finally {
    await proxy.close();
  }
});

test("the proxy tunnels and forwards when the policy allows the target", async () => {
  const echo = createTcpServer((socket) => socket.on("data", (chunk) => socket.end(`echo:${chunk}`)));
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const web = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/plain" }).end(`host=${req.headers.host} path=${req.url}`));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const allowAll = { blockedAddress: () => false, blockedName: () => false, extras: [] };
  const proxy = await startProxy({ policy: allowAll, resolve: async () => ["127.0.0.1"] });
  try {
    const tunnel = await new Promise((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT localhost:${echo.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`));
      let data = "";
      let sent = false;
      socket.on("data", (chunk) => {
        data += chunk;
        if (!sent && data.includes("\r\n\r\n")) {
          sent = true;
          socket.write("ping");
        }
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(tunnel, /^HTTP\/1\.1 200 Connection Established\r\n\r\necho:ping$/);
    const body = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxy.port, path: `http://site.example:${web.address().port}/a?b=1`, headers: { Host: `site.example:${web.address().port}` } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(`${res.statusCode} ${text}`));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, `200 host=site.example:${web.address().port} path=/a?b=1`);
  } finally {
    await proxy.close();
    echo.close();
    web.close();
  }
});

test("connectFirst tries the checked addresses in order and stops at the first that connects", async () => {
  const tried = [];
  const fakeConnect = (ok) => ({ host }) => {
    tried.push(host);
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.removeListener = EventEmitter.prototype.removeListener;
    setTimeout(() => (ok(host) ? socket.emit("connect") : socket.emit("error", new Error("ECONNREFUSED"))), 1);
    return socket;
  };
  const socket = await connectFirst(["203.0.113.1", "93.184.215.14", "1.1.1.1"], 443, { connectTo: fakeConnect((host) => host === "93.184.215.14") });
  assert.ok(socket);
  assert.deepEqual(tried, ["203.0.113.1", "93.184.215.14"], "the second address after the first failed; not the third");
  tried.length = 0;
  await assert.rejects(connectFirst(["a", "b"], 80, { connectTo: fakeConnect(() => false) }), /no address connected/);
  assert.deepEqual(tried, ["a", "b"]);
});

test("the proxy serves only clients from the session's internal network", async () => {
  const check = createClientCheck("172.19.0.0/16");
  assert.equal(check("172.19.0.3"), true);
  assert.equal(check("::ffff:172.19.0.3"), true);
  assert.equal(check("172.17.0.5"), false, "another container on the default bridge");
  assert.equal(check("127.0.0.1"), false);
  assert.equal(createClientCheck("garbage")("172.19.0.3"), false, "a bad range lets nobody in");
  const proxy = await startProxy({ allowClients: "10.99.0.0/16", resolve: async () => ["93.184.215.14"] });
  try {
    const reply = await rawRequest(proxy.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.equal(reply, "", "a client outside the range is disconnected without an answer");
  } finally {
    await proxy.close();
  }
});

test("host addresses for the block list: every interface address, without zone ids", () => {
  const list = hostAddressesToBlock({
    eth0: [{ address: "152.53.114.172" }, { address: "fe80::1%eth0" }],
    tailscale0: [{ address: "100.96.145.38" }, { address: "fd7a:115c:a1e0::1" }],
    weird: [{ address: "not an ip" }],
    none: undefined,
  });
  assert.deepEqual(list, ["100.96.145.38", "152.53.114.172", "fd7a:115c:a1e0::1", "fe80::1"]);
});

test("launch tickets: once, for the chat and card they were issued for, and briefly", () => {
  let now = 1000;
  let n = 0;
  const store = createTicketStore({ ttlMs: 100, now: () => now, random: () => `ticket-${++n}-0123456789abcdef` });
  const target = { sourceId: "chat", cardId: "card" };
  const first = store.issue(target);
  assert.equal(store.consume(first, { sourceId: "chat", cardId: "other" }), false, "another card");
  assert.equal(store.consume(first, target), false, "a wrong try used it up");
  const second = store.issue(target);
  assert.equal(store.consume(second, target), true);
  assert.equal(store.consume(second, target), false, "only once");
  const third = store.issue(target);
  now += 101;
  assert.equal(store.consume(third, target), false, "expired");
  assert.equal(store.consume("never-issued", target), false);
});

const sessionOpen = (overrides = {}) => ({
  agentId: "run-1",
  reason: "create",
  purpose: "interactive",
  labels: { ...runLabels("chat", "card"), ...serverRunLabels("t1") },
  ...overrides,
});

test("the MCP server goes only to Server browser runs: labels plus ticket on create, run record later", async () => {
  const consumed = [];
  const deps = (recorded = false, ticketOk = true) => ({
    consumeTicket: (ticket, target) => (consumed.push([ticket, target]), ticketOk),
    isRecorded: async () => recorded,
  });
  assert.equal(await shouldAttachServerBrowser(sessionOpen(), deps()), true);
  assert.deepEqual(consumed.at(-1), ["t1", { sourceId: "chat", cardId: "card" }]);
  assert.equal(await shouldAttachServerBrowser(sessionOpen(), deps(true, false)), false, "create needs a valid ticket, a record is not enough");
  const noTicket = sessionOpen({ labels: { ...runLabels("chat", "card"), [BROWSER_LABEL]: "server" } });
  assert.equal(await shouldAttachServerBrowser(noTicket, deps(true)), false, "no ticket on create");
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ labels: runLabels("chat", "card") }), deps(true)), false, "a Paseo browser run");
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ labels: serverRunLabels("t1") }), deps(true)), false, "browser label without run labels");
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ labels: {} }), deps(true)), false, "any other agent");
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ agentId: "chat" }), deps(true)), false, "a run cannot be its own source");
  for (const reason of ["resume", "refresh", "import"]) {
    assert.equal(await shouldAttachServerBrowser(sessionOpen({ reason }), deps(true, false)), true, `${reason} with a record`);
    assert.equal(await shouldAttachServerBrowser(sessionOpen({ reason }), deps(false, true)), false, `${reason} without a record`);
  }
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ purpose: "history" }), deps(true)), false, "history opens get nothing");
  const failing = { consumeTicket: () => true, isRecorded: async () => { throw new Error("settings down"); } };
  assert.equal(await shouldAttachServerBrowser(sessionOpen({ reason: "resume" }), failing), false, "fails closed");
  assert.equal(isServerBrowserRun({ [BROWSER_LABEL]: "paseo" }), false);
});

test("a run record counts only with the Server browser marker, for that card and run", () => {
  const runs = [
    ["chat:card", "run-1", "key:abc", SERVER_RUN_MARKER],
    ["chat:card", "run-2", "key:abc"],
    ["chat:other", "run-3", SERVER_RUN_MARKER],
  ];
  assert.equal(serverRunRecorded(runs, { sourceId: "chat", cardId: "card", runId: "run-1" }), true);
  assert.equal(serverRunRecorded(runs, { sourceId: "chat", cardId: "card", runId: "run-2" }), false, "no marker");
  assert.equal(serverRunRecorded(runs, { sourceId: "chat", cardId: "card", runId: "run-3" }), false, "another card's run");
  assert.equal(runBrowserOf(runs, "run-1"), "server");
  assert.equal(runBrowserOf(runs, "run-2"), "paseo");
  assert.equal(runBrowserOf([["k", "c", "browser:chrome"]], "c"), "chrome");
  assert.equal(runBrowserOf(runs, "unknown"), null);
});

/** Fake docker for the status and build tests. */
/**
 * Fake docker for the status, build, cap and sweep tests. `containers` and `networks` are
 * `{ id, labels }`; `ps` and `network ls` filter them by `label=k` or `label=k=v` and print the
 * requested `{{.ID}}\t{{.Label "..."}}` columns, like docker does.
 */
function fakeDocker({ info = 0, image = false, build = 0, containers = [], networks = [] } = {}) {
  const calls = [];
  const state = { image, containers: [...containers], networks: [...networks], psFails: false };
  const list = (items, args) => {
    const filters = args.flatMap((arg, i) => (arg === "--filter" ? [args[i + 1].replace(/^label=/, "").split(/=(.*)/s)] : []));
    const format = args[args.indexOf("--format") + 1];
    const columns = [...format.matchAll(/\{\{\.Label "([^"]+)"\}\}/g)].map((m) => m[1]);
    return items
      .filter((item) => filters.every(([key, value]) => key in item.labels && (value === undefined || item.labels[key] === value)))
      .map((item) => [item.id, ...columns.map((label) => item.labels[label] ?? "")].join("\t"))
      .join("\n");
  };
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const [sub] = args;
    if (sub === "info") return info === 0 ? { code: 0, stdout: '["name=seccomp,profile=builtin","name=rootless"]', stderr: "" } : { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock" };
    if (sub === "image") return state.image ? { code: 0, stdout: "sha256:x", stderr: "" } : { code: 1, stdout: "", stderr: "No such image" };
    if (sub === "build") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (build === 0) state.image = true;
      return build === 0 ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: failed to solve: token=abc123 pull access denied" };
    }
    if (sub === "ps") return state.psFails ? { code: 1, stdout: "", stderr: "Cannot connect" } : { code: 0, stdout: list(state.containers, args), stderr: "" };
    if (sub === "network" && args[1] === "ls") return { code: 0, stdout: list(state.networks, args), stderr: "" };
    if (sub === "rm") {
      state.containers = state.containers.filter((item) => !args.includes(item.id));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (sub === "network" && args[1] === "rm") {
      state.networks = state.networks.filter((item) => item.id !== args[2]);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, state };
}
const NOW = 1_800_000_000_000;
const OLD = String(Math.floor((NOW - 10 * 60_000) / 1000));
const browserContainer = (id, agent, { session = `bp-sb-${agent}-s`, pid = "100", role = "browser", instance = INSTANCE, created = OLD } = {}) => ({
  id,
  labels: {
    [CONTAINER_LABEL]: role,
    [CONTAINER_AGENT_LABEL]: agent,
    [SESSION_LABEL]: session,
    [LAUNCHER_PID_LABEL]: pid,
    ...(instance ? { [INSTANCE_LABEL]: instance } : {}),
    ...(created ? { [CREATED_LABEL]: created } : {}),
  },
});

const quiet = () => {};
/** Waits until the browser's build has finished (polls; no fixed sleep). */
async function settled(browser) {
  for (let i = 0; i < 500; i++) {
    const current = await browser.status();
    if (current.state !== "building") return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("build did not finish");
}
const makeBrowser = (docker, extra = {}) =>
  createServerBrowser({
    run: docker.run,
    env: {},
    buildRoot: "/tmp/browser-prompt-test-build",
    log: quiet,
    cacheMs: 0,
    findDocker: async () => "/usr/bin/docker",
    findNode: async () => "/usr/bin/node",
    runtimeRoot: mkdtempSync(join(tmpdir(), "bp-sb-runtime-")),
    alive: () => true,
    instanceId: INSTANCE,
    now: () => NOW,
    dockerHost: async () => "unix:///run/user/1001/docker.sock",
    interfaces: () => ({ eth0: [{ address: "152.53.114.172" }] }),
    random: (() => {
      let n = 0;
      return () => `r${++n}`.padEnd(32, "0");
    })(),
    ...extra,
  });

test("status: Docker missing, unreachable, no image, building, ready", async () => {
  const missing = makeBrowser(fakeDocker(), { findDocker: async () => null });
  assert.equal((await missing.status()).state, "docker-missing");
  const down = makeBrowser(fakeDocker({ info: 1 }));
  const downStatus = await down.status();
  assert.equal(downStatus.state, "docker-unavailable");
  assert.match(downStatus.detail, /Cannot connect/);
  const docker = fakeDocker();
  const browser = makeBrowser(docker);
  const first = await browser.status();
  assert.deepEqual({ state: first.state, rootless: first.rootless }, { state: "no-image", rootless: true });
  assert.equal(first.image, browser.image);
  assert.equal((await browser.status({ build: true })).state, "building");
  assert.equal((await browser.status({ build: true })).state, "building");
  await settled(browser);
  assert.equal((await browser.status()).state, "ready");
  assert.equal(docker.calls.filter((call) => call[1] === "build").length, 1, "one build at a time");
  const build = docker.calls.find((call) => call[1] === "build");
  assert.deepEqual(build.slice(0, 6), ["/usr/bin/docker", "build", "--label", "browser-prompt.server-browser=image", "-t", browser.image]);
});

test("a failed build is reported without credentials, and Build tries again", async () => {
  const docker = fakeDocker({ build: 1 });
  const browser = makeBrowser(docker);
  await browser.status({ build: true });
  await settled(browser);
  const failed = await browser.status();
  assert.equal(failed.state, "build-failed");
  assert.match(failed.detail, /pull access denied/);
  assert.doesNotMatch(failed.detail, /abc123/);
  assert.equal((await browser.status({ build: true })).state, "building");
  assert.equal(shortError("x".repeat(500)).length, 301);
});

test("prepare issues a ticket only when the image is ready; the ticket opens the session once", async () => {
  const docker = fakeDocker();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "bp-sb-runtime-"));
  const browser = makeBrowser(docker, { runtimeRoot });
  const notYet = await browser.prepare({ sourceId: "chat", cardId: "card" });
  assert.deepEqual(notYet, { ok: false, state: "no-image", detail: "" }, "a missing image is reported, never built from a run");
  assert.equal(docker.calls.filter((c) => c[1] === "build").length, 0, "prepare downloads nothing");
  await browser.status({ build: true });
  await settled(browser);
  const ready = await browser.prepare({ sourceId: "chat", cardId: "card" });
  assert.equal(ready.ok, true);
  assert.equal(browser.consumeTicket(ready.ticket, { sourceId: "chat", cardId: "card" }), true);
  assert.equal(browser.consumeTicket(ready.ticket, { sourceId: "chat", cardId: "card" }), false);
  const mcp = await browser.mcpServer("run-1");
  assert.equal(mcp.server.command, "/usr/bin/node");
  assert.deepEqual(mcp.server.env, { DOCKER_HOST: "unix:///run/user/1001/docker.sock" });
  const launcher = mcp.server.args[0];
  assert.ok(launcher.startsWith(runtimeRoot) && launcher.endsWith("/launch.mjs"));
  assert.equal(readFileSync(launcher, "utf8"), SERVER_BROWSER_RUNTIME_FILES["launch.mjs"], "the launcher is written to the state directory");
  const plan = JSON.parse(Buffer.from(mcp.server.args[1], "base64").toString("utf8"));
  assert.equal(plan.docker, "/usr/bin/docker");
  assert.equal(plan.browser.run.at(-1), browser.image);
  assert.ok(plan.browser.run.includes("BP_BLOCKED_IPS=152.53.114.172"));
  const seccomp = plan.browser.run.find((arg) => arg.startsWith("seccomp="))?.slice("seccomp=".length);
  assert.equal(readFileSync(seccomp, "utf8"), SERVER_BROWSER_RUNTIME_FILES["seccomp.json"], "the seccomp profile is written next to it");
  assert.equal(mcp.session, plan.browser.name);
});

test("at most three runs have a browser at once; the card is told why", async () => {
  assert.equal(MAX_SERVER_BROWSER_RUNS, 3);
  const docker = fakeDocker({ image: true, containers: [browserContainer("a1a1a1", "run-a"), browserContainer("b2b2b2", "run-b"), browserContainer("c3c3c3", "run-b", { role: "proxy" })] });
  const browser = makeBrowser(docker);
  assert.equal(await browser.activeRuns(), 2, "two runs; a proxy is not a run");
  const third = await browser.prepare({ sourceId: "chat", cardId: "card-3" });
  assert.equal(third.ok, true, "the third run may start");
  assert.deepEqual(await browser.prepare({ sourceId: "chat", cardId: "card-4" }), { ok: false, state: "busy", detail: "" }, "a ticket not used yet counts");
  assert.match(SERVER_BROWSER_STATE_MESSAGES.busy, /3 Server browser runs already have a browser/);
  assert.match(SERVER_BROWSER_STATE_MESSAGES.busy, /Archive or close/);
  docker.state.containers = docker.state.containers.filter((item) => item.labels[CONTAINER_AGENT_LABEL] !== "run-a");
  browser.consumeTicket(third.ticket, { sourceId: "chat", cardId: "card-3" });
  assert.equal((await browser.prepare({ sourceId: "chat", cardId: "card-4" })).ok, true, "a slot frees up when a run ends");
});

test("the cap holds for every session open, and a run counts from admission until its container exists", async () => {
  const docker = fakeDocker({ image: true, containers: [browserContainer("a1a1a1", "run-a"), browserContainer("b2b2b2", "run-b")] });
  let now = NOW;
  const browser = makeBrowser(docker, { now: () => now });
  const c = await browser.mcpServer("run-c");
  assert.ok(c && "server" in c, "the third run is admitted (on resume as on create)");
  assert.equal(await browser.activeRuns(), 3, "run-c counts before its container is up");
  assert.deepEqual(await browser.mcpServer("run-d"), { refused: "busy" }, "a resume or refresh of a fourth run gets no browser");
  assert.ok("server" in (await browser.mcpServer("run-a")), "a run that already has a browser may reopen (its old container is replaced)");
  docker.state.containers.push(browserContainer("c3c3c3", "run-c"));
  assert.equal(await browser.activeRuns(), 3, "run-c once, now by its container");
  docker.state.containers = docker.state.containers.filter((item) => item.labels[CONTAINER_AGENT_LABEL] !== "run-c");
  assert.equal(await browser.activeRuns(), 2, "its container is gone and it was seen up: no longer counted");
  const e = await browser.mcpServer("run-e");
  assert.ok("server" in e);
  now += STARTING_WINDOW_MS + 1;
  assert.equal(await browser.activeRuns(), 2, "an admitted run whose container never appeared stops counting after the window");
});

test("counting fails closed when docker ps fails", async () => {
  const docker = fakeDocker({ image: true });
  const browser = makeBrowser(docker);
  docker.state.psFails = true;
  assert.deepEqual(await browser.mcpServer("run-x"), { refused: "unavailable" });
  const prepared = await browser.prepare({ sourceId: "chat", cardId: "card" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.state, "docker-unavailable");
  assert.equal(await browser.sweep(), 0, "and nothing is removed");
});

test("the sweep removes only this instance's resources whose launcher is gone, once they are old enough", async () => {
  const young = String(Math.floor((NOW - SWEEP_MIN_AGE_MS / 2) / 1000));
  const docker = fakeDocker({
    containers: [
      browserContainer("aaaaaa", "run-a", { pid: "100" }),
      browserContainer("bbbbbb", "run-a", { pid: "100", role: "proxy" }),
      browserContainer("cccccc", "run-b", { pid: "200" }),
      browserContainer("dddddd", "run-c", { pid: "300", instance: "other-daemon-1234" }),
      browserContainer("eeeeee", "run-d", { pid: "400", instance: "" }),
      browserContainer("ffffff", "run-e", { pid: "500", created: young }),
      browserContainer("abcabc", "run-f", { pid: "600", created: "" }),
      { id: "0a0a0a", labels: { [CONTAINER_LABEL]: "browser" } },
    ],
    networks: [browserContainer("e0e0e0", "run-a", { pid: "100", role: "network" }), browserContainer("f0f0f0", "run-b", { pid: "200", role: "network" })],
  });
  const browser = makeBrowser(docker, { alive: (pid) => pid === 100 });
  assert.equal(await browser.sweep(), 2, "only run-b's container and network");
  assert.deepEqual(
    docker.state.containers.map((item) => item.id),
    ["aaaaaa", "bbbbbb", "dddddd", "eeeeee", "ffffff", "abcabc", "0a0a0a"],
    "live launcher, another instance, no instance label (started by hand), too young, no creation time: all kept",
  );
  assert.deepEqual(docker.state.networks.map((item) => item.id), ["e0e0e0"]);
  const listed = docker.calls.filter((call) => call[1] === "ps" || call[2] === "ls");
  assert.ok(listed.length > 0 && listed.every((call) => call.includes(`label=${INSTANCE_LABEL}=${INSTANCE}`)), "docker is asked for this instance only");
  const rm = docker.calls.filter((call) => call[1] === "rm" || call[2] === "rm").map((call) => call.slice(1));
  assert.deepEqual(rm, [["rm", "-f", "cccccc"], ["network", "rm", "f0f0f0"]], "containers first, then their networks");
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(Number.NaN), false);
});

test("the instance id is the host name and a uuid, made once and kept in the state directory", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "bp-sb-instance-")), "server-browser", "instance-id");
  const first = await loadInstanceId(file, "paseo box!", () => "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d");
  assert.equal(first, "paseo-box--0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d");
  assert.equal(await loadInstanceId(file, "other", () => "never-used"), first, "kept across restarts");
  writeFileSync(file, "bad id; rm\n");
  const fresh = await loadInstanceId(file, "paseo-box", () => "11111111-2222-4333-8444-555555555555");
  assert.equal(fresh, "paseo-box-11111111-2222-4333-8444-555555555555", "a damaged file is never used in a label; a new id replaces it");
  assert.equal(readFileSync(file, "utf8").trim(), fresh);
  const docker = fakeDocker({ image: true });
  const browser = makeBrowser(docker);
  const mcp = await browser.mcpServer("run-1");
  const plan = JSON.parse(Buffer.from(mcp.server.args[1], "base64").toString("utf8"));
  for (const run of [plan.browser.run, plan.proxy.run, plan.network.create]) assert.ok(run.includes(`${INSTANCE_LABEL}=${INSTANCE}`));
});

test("checkPlan refuses plans that would weaken the isolation", () => {
  const good = serverBrowserPlan("/usr/bin/docker", input());
  const browserWith = (mutate) => ({ ...good, browser: { ...good.browser, run: mutate([...good.browser.run]) } });
  const proxyWith = (mutate) => ({ ...good, proxy: { ...good.proxy, run: mutate([...good.proxy.run]) } });
  const insert = (extra) => (run) => [run[0], ...extra, ...run.slice(1)];
  const cases = [
    ["a host mount", browserWith(insert(["-v", "/:/host"])), /-v is not allowed/],
    ["--volume=", browserWith(insert(["--volume=/:/host"])), /--volume is not allowed/],
    ["--mount", browserWith(insert(["--mount", "type=bind,src=/,dst=/h"])), /--mount/],
    ["--privileged", proxyWith(insert(["--privileged"])), /--privileged/],
    ["--device", browserWith(insert(["--device", "/dev/kvm"])), /--device/],
    ["--pid host", browserWith(insert(["--pid", "host"])), /--pid/],
    ["--ipc=host", browserWith(insert(["--ipc=host"])), /--ipc/],
    ["--network host", proxyWith((run) => run.map((arg) => (arg === "bridge" ? "host" : arg))), /network must be bridge/],
    ["a second network", browserWith(insert(["--network", "bridge"])), /network must be/],
    ["the browser on bridge", browserWith((run) => run.map((arg) => (arg === good.network.name ? "bridge" : arg))), /network must be bp-sb/],
    ["--cap-add SYS_ADMIN", browserWith(insert(["--cap-add", "SYS_ADMIN"])), /--cap-add is limited/],
    ["--cap-add on the proxy", proxyWith(insert(["--cap-add", "SYS_CHROOT"])), /--cap-add is limited/],
    ["seccomp=unconfined", browserWith(insert(["--security-opt", "seccomp=unconfined"])), /not allowed/],
    ["apparmor=unconfined", proxyWith(insert(["--security-opt", "apparmor=unconfined"])), /not allowed/],
    ["no --read-only", browserWith((run) => run.filter((arg) => arg !== "--read-only")), /--read-only is required/],
    ["no --cap-drop ALL", proxyWith((run) => run.map((arg) => (arg === "ALL" ? "NET_RAW" : arg))), /--cap-drop ALL is required/],
    ["no no-new-privileges", browserWith((run) => run.map((arg) => (arg === "no-new-privileges" ? "label=type:x" : arg))), /no-new-privileges is required/],
    ["another image", browserWith((run) => [...run.slice(0, -1), "alpine:3"]), /pinned Server browser image/],
    ["latest", browserWith((run) => [...run.slice(0, -1), "browser-prompt-server-browser:latest"]), /pinned/],
    ["another proxy command", proxyWith((run) => [...run.slice(0, -1), "/bin/sh"]), /proxy entry point/],
    ["a network that is not internal", { ...good, network: { ...good.network, create: good.network.create.filter((arg) => arg !== "--internal") } }, /--internal/],
  ];
  for (const [what, plan, error] of cases) assert.throws(() => checkPlan(plan), error, what);
  assert.equal(checkPlan(good), good);
  assert.doesNotThrow(() => checkRun(good.browser.run, "browser", good.network.name));
});

test("the seccomp profile is pinned to its upstream hash and the plugin refuses another", async () => {
  const profile = readFileSync(new URL("../server-browser/seccomp.json", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(profile).digest("hex"), SECCOMP_PROFILE_SHA256);
  assert.equal(SECCOMP_PROFILE_SHA256, "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849");
  assert.match(SECCOMP_PROFILE_SOURCE, /microsoft\/playwright v1\.65\.1 utils\/docker\/seccomp_profile\.json/);
  const shared = readFileSync(new URL("../shared/server-browser.ts", import.meta.url), "utf8");
  assert.match(shared, /raw\.githubusercontent\.com\/microsoft\/playwright\/v1\.65\.1\/utils\/docker\/seccomp_profile\.json/, "the source is named");
  const tampered = makeBrowser(fakeDocker({ image: true }), { runtimeFiles: { ...SERVER_BROWSER_RUNTIME_FILES, "seccomp.json": profile.replace("SCMP_ACT_ERRNO", "SCMP_ACT_ALLOW") } });
  await assert.rejects(tampered.mcpServer("run-1"), /not the pinned one/);
});

/** A host with addHook, recording registrations. */
function fakeHost({ addHook = true, before = false } = {}) {
  const hooks = new Map();
  const host = {
    on: (name, handler) => (hooks.set(name, handler), () => hooks.delete(name)),
  };
  if (addHook) host.addHook = function (name, handler) {
    assert.equal(this, host);
    hooks.set(name, handler);
    return () => hooks.delete(name);
  };
  if (before) host.before = (name, handler) => (hooks.set(name, handler), () => hooks.delete(name));
  return { host, hooks };
}

const settingsWith = (runs) => ({ read: async () => ({ status: "ready", values: { runs }, revision: "1" }) });

test("the session-open hook adds the server-browser MCP server only for the run it gated in", async () => {
  const docker = fakeDocker({
    image: true,
    containers: [browserContainer("abc123def456", "run-1", { session: "bp-sb-run-1-old", pid: "999" })],
    networks: [browserContainer("0e0e0e7", "run-1", { session: "bp-sb-run-1-old", pid: "999", role: "network" })],
  });
  const browser = makeBrowser(docker);
  const { host, hooks } = fakeHost();
  const reg = registerServerBrowser(host, settingsWith([]), browser, { log: quiet });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(docker.calls.some((call) => call[1] === "ps"), "the start sweep ran");
  assert.equal(docker.state.containers.length, 1, "a live launcher's container is kept by the sweep");
  docker.calls.length = 0;
  assert.equal(reg.supported, true);
  const open = hooks.get("agent.open.before");
  assert.equal(typeof open, "function");
  const prepared = await browser.prepare({ sourceId: "chat", cardId: "card" });
  const request = { ...sessionOpen({ labels: { ...runLabels("chat", "card"), ...serverRunLabels(prepared.ticket) } }), mcpServers: { mine: { type: "http", url: "https://x" } }, tools: [], env: {} };
  const result = await open({ request }, {});
  assert.deepEqual(Object.keys(result.mcpServers), ["mine", SERVER_BROWSER_MCP_NAME]);
  assert.equal(result.mcpServers[SERVER_BROWSER_MCP_NAME].type, "stdio");
  assert.equal(result.env, request.env, "nothing else changes");
  assert.equal(reg.attached("run-1"), true);
  // The same ticket again (another agent copying the labels) gets nothing.
  assert.equal(await open({ request: { ...request, agentId: "run-2" } }, {}), undefined);
  assert.equal(docker.calls.some((call) => call[1] === "rm"), false, "a new run has no earlier containers to remove");
  // Later opens of the same run in this process keep the browser and remove the earlier session's
  // container and network (a killed launcher can leave them), never the new session's.
  const reopened = await open({ request: { ...request, reason: "resume" } }, {});
  assert.ok(reopened?.mcpServers[SERVER_BROWSER_MCP_NAME]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(docker.calls.filter((call) => call[1] === "rm" || call[2] === "rm").map((call) => call.slice(1)), [["rm", "-f", "abc123def456"], ["network", "rm", "0e0e0e7"]]);
  const plan = JSON.parse(Buffer.from(reopened.mcpServers[SERVER_BROWSER_MCP_NAME].args[1], "base64").toString("utf8"));
  docker.calls.length = 0;
  const keep = makeBrowser(fakeDocker({ containers: [browserContainer("fff000fff000", "run-1", { session: plan.browser.name })] }));
  assert.equal(await keep.removeContainers("run-1", plan.browser.name), 0, "the current session's container stays");
  docker.state.containers.push(browserContainer("abc123def456", "run-1", { session: "bp-sb-run-1-old2" }));
  assert.equal(await open({ request: { ...request, agentId: "other", reason: "resume" } }, {}), undefined);
  assert.equal(await open({ request: { ...request, labels: {}, agentId: "plain" } }, {}), undefined);
  // Closing the run removes its containers.
  await hooks.get("agent.close.after")({ agent: { id: "run-1" } }, {});
  assert.deepEqual(docker.calls.find((call) => call[1] === "rm"), ["/usr/bin/docker", "rm", "-f", "abc123def456"]);
  docker.calls.length = 0;
  await hooks.get("agent.archive.after")({ agent: { id: "never-attached" } }, {});
  assert.equal(docker.calls.length, 0, "agents without a Server browser are left alone");
  reg.dispose();
  assert.equal(hooks.size, 0);
});

test("after a daemon restart the run record decides; old hosts use before(), very old ones have none", async () => {
  const browser = makeBrowser(fakeDocker({ image: true }));
  const { host, hooks } = fakeHost({ addHook: false, before: true });
  const settings = settingsWith([["chat:card", "run-1", SERVER_RUN_MARKER]]);
  const reg = registerServerBrowser(host, settings, browser, { log: quiet });
  assert.equal(reg.supported, true);
  const open = hooks.get("agent.session_open");
  const base = { ...sessionOpen({ reason: "resume" }), mcpServers: {}, tools: [], env: {} };
  assert.ok((await open({ request: base }, {}))?.mcpServers[SERVER_BROWSER_MCP_NAME]);
  assert.equal(await open({ request: { ...base, agentId: "run-9" } }, {}), undefined, "not recorded");
  const none = registerServerBrowser({ on: () => () => {} }, settings, browser, { log: quiet });
  assert.equal(none.supported, false);
});

test("docker discovery: PATH first, and the rootless socket when DOCKER_HOST is unset", async () => {
  const found = await findDocker({ PATH: "/nope:/opt/bin", HOME: "/home/u" }, async (path) => path === "/opt/bin/docker" || path === "/usr/bin/docker");
  assert.equal(found, "/opt/bin/docker");
  assert.equal(await findDocker({ PATH: "" }, async () => false), null);
  assert.equal(await resolveDockerHost({ DOCKER_HOST: " unix:///x.sock " }, 1001, async () => false), "unix:///x.sock");
  assert.equal(await resolveDockerHost({ XDG_RUNTIME_DIR: "/run/user/1001" }, 1001, async (p) => p === "/run/user/1001/docker.sock"), "unix:///run/user/1001/docker.sock");
  assert.equal(await resolveDockerHost({}, 1001, async (p) => p === "/run/user/1001/docker.sock"), "unix:///run/user/1001/docker.sock");
  assert.equal(await resolveDockerHost({}, 1001, async () => false), null);
});

test("every state has a message for the card, and the RPC lists the same states", () => {
  for (const state of SERVER_BROWSER_STATES) assert.ok(SERVER_BROWSER_STATE_MESSAGES[state], state);
  assert.match(SERVER_BROWSER_STATE_MESSAGES["docker-missing"], /needs Docker/);
  const rpc = readFileSync(new URL("../shared/server-browser-rpc.ts", import.meta.url), "utf8");
  assert.match(rpc, /name: "server-browser\.status"/);
  assert.match(rpc, /name: "server-browser\.prepare"/);
  assert.match(rpc, /z\.enum\(SERVER_BROWSER_STATES\)/);
});

const AUTO = { provider: "claude/claude-sonnet-5-5", modeId: "auto" };

test("the Server browser prompt: its own tools by their prefixed names, not signed in, no tab cleanup", () => {
  const prompt = buildAgentPrompt("T", "1. open example.com", AUTO, { sourceAgentId: "chat", maxQuestions: 3 }, { totalSteps: 1 }, true, true, true, "server");
  assert.ok(prompt.startsWith(SERVER_SAFETY_PREAMBLE));
  for (const tool of SERVER_BROWSER_TOOLS) assert.ok(prompt.includes(`mcp__server-browser__${tool}`), tool);
  assert.match(prompt, /Never use the Paseo browser_\* tools \(mcp__paseo__browser_\*\)/);
  assert.match(prompt, /NOT signed in to any of the owner's accounts/);
  assert.match(prompt, /never ask for, type, guess or create credentials/);
  assert.match(prompt, /run these steps with the Paseo browser instead/);
  assert.match(prompt, /do not run shell commands, and do not read or edit files/);
  assert.match(prompt, /blocked on purpose; do not try to get around the block/);
  for (const rule of ["3. HARD RULE", "4. When the page differs", "5. Never read out", "6. When finished", "7. You run in Auto mode", "8. Questions for the chat", "9. Progress", "12. Success line"]) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.ok(prompt.includes(SERVER_SCREENSHOT_RULE));
  assert.ok(!prompt.includes(SCREENSHOT_RULE), "no Paseo screenshot or 'not painted' rule");
  assert.ok(!prompt.includes(CLOSE_TABS_RULE) && !prompt.includes("11. Closing tabs"), "the container is discarded: no close-tabs rule");
  assert.ok(prompt.includes(RUN_SUCCESS_RULE));
  assert.doesNotMatch(prompt, /browser_list_tabs|browser_new_tab|has not painted|claude-in-chrome__/);
  assert.match(SERVER_SCREENSHOT_RULE, /mcp__server-browser__browser_take_screenshot/);
  const quiet = buildAgentPrompt("T", "1. x", AUTO, undefined, undefined, false, true, false, "server");
  assert.ok(!quiet.includes("10. Screenshots"), "screenshots off: no rule");
  assert.ok(AGENT_SAFETY_PREAMBLE.includes("browser_list_tabs"), "the Paseo browser prompt is unchanged");
  for (const tool of SERVER_BROWSER_DENIED_TOOLS) assert.ok(prompt.includes(`mcp__server-browser__${tool}`) && !SERVER_BROWSER_TOOLS.includes(tool), tool);
  assert.match(prompt, /are turned off\./);
  assert.match(prompt, /mcp__server-browser__browser_install/, "every denied tool is named, browser_install too");
  assert.match(prompt, /stopped after 2 hours without use and after 12 hours in total/);
  assert.match(prompt, /do not try to restart it: end your turn with a report that quotes the error and names the last step you completed/);
});

test("rule 3 is consistent per browser: the owner types secrets in the Paseo browser and Chrome, never in the Server browser", () => {
  const typeIt = /Ask them to type it into the page themselves and reply "done"/;
  assert.match(AGENT_SAFETY_PREAMBLE, typeIt);
  assert.match(CHROME_SAFETY_PREAMBLE, typeIt);
  assert.doesNotMatch(SERVER_SAFETY_PREAMBLE, typeIt);
  assert.doesNotMatch(SERVER_SAFETY_PREAMBLE, /type it into the page/);
  assert.match(SERVER_SAFETY_PREAMBLE, /3\. HARD RULE[^]*any step that needs a password, token, API key, 2FA code or other secret\. In this browser the owner cannot type it in, so do not ask for it: stop at that step/);
  for (const preamble of [AGENT_SAFETY_PREAMBLE, CHROME_SAFETY_PREAMBLE, SERVER_SAFETY_PREAMBLE]) {
    assert.match(preamble, /confirming anything destructive or irreversible/);
    assert.match(preamble, /Never ask the owner to paste a secret into the chat/);
  }
});

test("the launch says where a Server browser run works, and the browser setting parses", () => {
  const text = describeLaunch(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "server" }), "server");
  assert.match(text, /headless browser on the Paseo server/);
  assert.match(text, /not signed in to any of your accounts/);
  assert.match(text, /cannot reach your tailnet/);
  assert.equal(parseBrowserAgent("server"), "server");
  assert.equal(parseBrowserAgent("chrome"), "chrome");
  assert.equal(parseBrowserAgent("firefox"), "paseo");
  assert.equal(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "server" }).options, undefined, "no Chrome flag");
});

test("Playwright tools: screenshots reach the card, typed keys are masked, form fills never offer Allow", () => {
  assert.equal(isScreenshotTool("mcp__server-browser__browser_take_screenshot"), true);
  assert.equal(isScreenshotTool("mcp__paseo__browser_screenshot"), true);
  assert.equal(isScreenshotTool("mcp__server-browser__browser_take_screenshots"), false);
  const typed = permissionDetails({ name: "mcp__server-browser__browser_press_key", input: { key: "hunter2" } });
  assert.equal(typed.lines.find((line) => line.label === "Key")?.masked, true, "more than one key is masked like typed text");
  const key = permissionDetails({ name: "mcp__server-browser__browser_press_key", input: { key: "Enter" } });
  assert.equal(key.lines.find((line) => line.label === "Key")?.masked, undefined, "a single key name is shown");
  const text = permissionDetails({ name: "mcp__server-browser__browser_type", input: { element: "Search", ref: "e2", text: "secret words" } });
  assert.equal(text.lines.find((line) => line.label === "Text")?.masked, true);
  const form = permissionDetails({ name: "mcp__server-browser__browser_fill_form", input: { fields: [{ name: "q", type: "textbox", ref: "e1", value: "x" }] } });
  assert.equal(form.complete, false);
  const click = permissionDetails({ name: "mcp__server-browser__browser_click", input: { element: "Search button", ref: "e5" } });
  assert.equal(click.complete, true);
});

test("settings: the Server browser is a usual way on desktop and phones without a version bump, so a rollback keeps reading them", () => {
  const v18 = { startMode: "paseo", mobileStartMode: "copy-only", runs: [["a:c", "r", "browser:chrome"]], done: [] };
  assert.deepEqual(migratePreferences(v18, 17), { ...v18 });
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /version: 18,/, "an older plugin refuses any document saved by a newer settings version");
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(changelog.slice(0, changelog.indexOf("## 0.20.5")), /[Rr]ollback/);
  const launch = readFileSync(new URL("../client/launch.ts", import.meta.url), "utf8");
  assert.match(launch, /way !== "server"/, "the Command Center opens ChatGPT when the usual way is the Server browser");
});

test("the card checks Docker before a Server browser run and starts it only with a ticket", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  // Run uses the default way; "Run once in…" offers the clean Server browser on every platform.
  assert.match(card, /onRun=\{\(\) => void onRunPress\(runWay\)\}/);
  assert.match(card, /onPress=\{\(\) => runOnceIn\(item\.way\)\}/);
  assert.match(card, /serverStatus\(\{\}\)/);
  assert.doesNotMatch(card, /build: true/, "the card never starts a download or build");
  assert.match(card, /if \(status\.state !== "ready"\) reason =/);
  assert.match(card, /prepareServerRun\(\{ sourceAgentId: agentId, cardId \}\)/);
  assert.match(card, /extraLabels = serverRunLabels\(prepared\.ticket\)/);
  assert.match(card, /in a browser on the Paseo server\? It is not signed in to your accounts\./);
  assert.doesNotMatch(card, /runMenuItems\([^)]*mobile/, "the menu does not depend on the platform: shown on phones too");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /labels: \{ \.\.\.input\.extraLabels, \.\.\.runLabels\(input\.sourceAgentId, input\.cardId\) \}/, "the run labels always win");
  const entry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(entry, /registerServerBrowser\(/);
  assert.match(entry, /server\.handle\(serverBrowserStatus/);
  assert.match(entry, /server\.handle\(prepareServerBrowserRun/);
  assert.ok(TICKET_LABEL.startsWith("browser-prompt"));
});

test("the image is downloaded only after two presses in the settings", () => {
  const settings = readFileSync(new URL("../client/server-browser-settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /"Confirm download \(2\.6 GB\)"/);
  assert.match(settings, /useEffect\(\(\) => setConfirmBuild\(false\), \[info\?\.state\]\)/, "a state change drops an armed confirmation");
  assert.match(settings, /setTimeout\(\(\) => setConfirmBuild\(false\), 10_000\)/, "and so do 10 seconds");
  assert.match(settings, /if \(!confirmBuild\) \{\s*setConfirmBuild\(true\);\s*return;/);
  assert.match(settings, /about 2\.6 GB/);
});

test("status without build never starts a download", async () => {
  const docker = fakeDocker();
  const browser = makeBrowser(docker, {});
  assert.equal((await browser.status()).state, "no-image");
  assert.equal((await browser.status({})).state, "no-image");
  assert.equal(docker.calls.filter((c) => c[1] === "build").length, 0);
});
