// Run: npm test. The Server browser: the docker arguments and their isolation flags, the network
// policy of the in-container proxy (also end to end on 127.0.0.1), which agent sessions get the MCP
// server (labels, one-time ticket, run record), status and build handling, the prompt variant, and
// that the embedded build context matches server-browser/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import {
  AGENT_SAFETY_PREAMBLE,
  buildAgentPrompt,
  CLOSE_TABS_RULE,
  describeLaunch,
  parseBrowserAgent,
  resolveAgentConfig,
  runBrowserOf,
  RUN_SUCCESS_RULE,
  SCREENSHOT_RULE,
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
  PLAYWRIGHT_MCP_VERSION,
  SERVER_BROWSER_MCP_NAME,
  SERVER_BROWSER_STATE_MESSAGES,
  SERVER_BROWSER_STATES,
  SERVER_RUN_MARKER,
  serverBrowserDockerArgs,
  serverBrowserImageTag,
  serverBrowserMcpServer,
  serverRunLabels,
  serverRunRecorded,
  shouldAttachServerBrowser,
  TICKET_LABEL,
} from "../shared/server-browser.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import {
  contextHash,
  createServerBrowser,
  currentImageTag,
  findDocker,
  registerServerBrowser,
  resolveDockerHost,
  shortError,
} from "../server/server-browser.ts";
import { SERVER_BROWSER_FILES } from "../server/server-browser-files.ts";
import { renderEmbedded, SERVER_BROWSER_FILE_NAMES } from "../scripts/embed-server-browser.mjs";
import {
  BLOCKED_HOST_SUFFIXES,
  createPolicy,
  normalizeAddress,
  parseAuthority,
  resolveTarget,
  startProxy,
} from "../server-browser/proxy.mjs";

const IMAGE = serverBrowserImageTag("ab".repeat(32));
const argsFor = (extra = {}) => serverBrowserDockerArgs({ image: IMAGE, agentId: "agent-1", nonce: "n0nce", blockedIps: ["100.96.145.38", "152.53.114.172"], ...extra });
const flagValues = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

test("docker arguments: every isolation flag, the pinned image last", () => {
  const args = argsFor();
  assert.deepEqual(args.slice(0, 4), ["run", "-i", "--rm", "--init"]);
  assert.equal(args.at(-1), IMAGE, "the image comes last, nothing after it");
  assert.deepEqual(flagValues(args, "--pull"), ["never"]);
  assert.deepEqual(flagValues(args, "--network"), ["bridge"]);
  assert.deepEqual(flagValues(args, "--dns"), ["1.1.1.1", "9.9.9.9"]);
  assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(flagValues(args, "--tmpfs"), ["/tmp:rw,nosuid,nodev,size=512m"]);
  assert.deepEqual(flagValues(args, "--memory"), ["1536m"]);
  assert.deepEqual(flagValues(args, "--memory-swap"), ["1536m"], "no swap on top");
  assert.deepEqual(flagValues(args, "--cpus"), ["1.5"]);
  assert.deepEqual(flagValues(args, "--pids-limit"), ["512"]);
  assert.deepEqual(flagValues(args, "--user"), ["pwuser"]);
  assert.deepEqual(flagValues(args, "--log-driver"), ["none"]);
  assert.deepEqual(flagValues(args, "--name"), ["bp-sb-agent-1-n0nce"]);
  assert.deepEqual(flagValues(args, "--label"), [`${CONTAINER_LABEL}=1`, `${CONTAINER_AGENT_LABEL}=agent-1`]);
  const env = flagValues(args, "--env");
  assert.ok(env.includes("BP_BLOCKED_IPS=100.96.145.38,152.53.114.172"));
  assert.ok(env.includes("BP_MAX_LIFETIME_S=43200"));
  assert.ok(env.includes("BP_IDLE_TIMEOUT_S=7200"));
  // Nothing that reaches the host: no mounts, devices, host namespaces or extra privileges.
  for (const forbidden of ["-v", "--volume", "--mount", "--device", "--privileged", "--cap-add", "--pid", "--ipc", "--userns", "-p", "--publish", "-t", "--add-host"]) {
    assert.ok(!args.includes(forbidden), forbidden);
  }
  assert.ok(!args.some((arg) => /host|unconfined|docker\.sock/.test(arg) && !arg.startsWith("--hostname") && arg !== "server-browser"), "no host network, no unconfined profile, no socket");
});

test("docker arguments refuse other images, odd agent ids and non-addresses", () => {
  assert.throws(() => argsFor({ image: "browser-prompt-server-browser:latest" }), /pinned image/);
  assert.throws(() => argsFor({ image: "mcr.microsoft.com/playwright:v1.56.0-noble" }), /pinned image/);
  assert.throws(() => argsFor({ agentId: "a; rm -rf /" }), /agent id/);
  assert.throws(() => argsFor({ agentId: "" }), /agent id/);
  const env = flagValues(argsFor({ blockedIps: ["10.0.0.1", "x,y", "1.2.3.4 --privileged"] }), "--env");
  assert.ok(env.includes("BP_BLOCKED_IPS=10.0.0.1"), env.join(" "));
  assert.equal(containerName("a".repeat(100), "zz-99!"), `bp-sb-${"a".repeat(36)}-zz99`);
});

test("the image tag is pinned and versioned, never latest", () => {
  assert.equal(IMAGE, `browser-prompt-server-browser:pw1.56.0-mcp${PLAYWRIGHT_MCP_VERSION}-abababababab`);
  assert.throws(() => serverBrowserImageTag(""), /hash/);
  const tag = currentImageTag();
  assert.match(tag, /^browser-prompt-server-browser:pw1\.56\.0-mcp0\.0\.41-[0-9a-f]{12}$/);
  assert.equal(currentImageTag({ ...SERVER_BROWSER_FILES }), tag, "same files, same tag");
  assert.notEqual(currentImageTag({ ...SERVER_BROWSER_FILES, "proxy.mjs": "changed" }), tag, "any change rebuilds");
  assert.equal(contextHash({ b: "2", a: "1" }), contextHash({ a: "1", b: "2" }), "order does not matter");
});

test("the build context is pinned: base image digest, exact Playwright MCP version, lock file", () => {
  const dockerfile = readFileSync(new URL("../server-browser/Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(`FROM ${BASE_IMAGE}`), "FROM by digest");
  assert.match(BASE_IMAGE, /@sha256:[0-9a-f]{64}$/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER pwuser$/m);
  const pkg = JSON.parse(readFileSync(new URL("../server-browser/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@playwright/mcp"], PLAYWRIGHT_MCP_VERSION, "exact version, no range");
  const lock = JSON.parse(readFileSync(new URL("../server-browser/package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages["node_modules/@playwright/mcp"].version, PLAYWRIGHT_MCP_VERSION);
  assert.match(lock.packages["node_modules/@playwright/mcp"].integrity, /^sha512-/);
  assert.equal(lock.packages["node_modules/playwright-core"].version, "1.56.0-alpha-2025-10-01");
});

test("the embedded build context matches server-browser/ (run scripts/embed-server-browser.mjs)", () => {
  const generated = readFileSync(new URL("../server/server-browser-files.ts", import.meta.url), "utf8");
  assert.equal(generated, renderEmbedded());
  assert.deepEqual(Object.keys(SERVER_BROWSER_FILES).sort(), [...SERVER_BROWSER_FILE_NAMES].sort());
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("server-browser/"), "the Dockerfile ships with the plugin");
});

test("the entrypoint keeps Chromium headless, isolated, proxied, and its files in the container", () => {
  const entry = readFileSync(new URL("../server-browser/entrypoint.mjs", import.meta.url), "utf8");
  for (const flag of ['"--headless"', '"--isolated"', '"--output-dir"', '"--block-service-workers"']) assert.ok(entry.includes(flag), flag);
  assert.match(entry, /proxy: \{ server: `http:\/\/127\.0\.0\.1:\$\{proxy\.port\}` \}/);
  assert.match(entry, /disable_non_proxied_udp/);
  assert.match(entry, /acceptDownloads: false/);
  assert.match(entry, /const work = "\/tmp\/browser-prompt";/, "output only under the container's tmpfs");
  assert.match(entry, /stdio: \["pipe", "inherit", "inherit"\]/, "stdout straight through; stdin through the idle timer");
  assert.match(entry, /BP_IDLE_TIMEOUT_S/);
  assert.match(entry, /process\.stdin\.on\("end", \(\) => child\.stdin\.end\(\)\)/, "a closed session ends Playwright MCP");
  assert.doesNotMatch(entry, /console\.log/, "stdout stays JSON-RPC");
});

test("the MCP server is docker over stdio, with DOCKER_HOST only when known", () => {
  assert.deepEqual(serverBrowserMcpServer("/usr/bin/docker", ["run"], null), { type: "stdio", command: "/usr/bin/docker", args: ["run"] });
  assert.deepEqual(serverBrowserMcpServer("/usr/bin/docker", ["run"], "unix:///run/user/1001/docker.sock"), {
    type: "stdio",
    command: "/usr/bin/docker",
    args: ["run"],
    env: { DOCKER_HOST: "unix:///run/user/1001/docker.sock" },
  });
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
  assert.deepEqual(await resolveTarget(policy, "example.com", dns({ "example.com": ["93.184.215.14"] })), { address: "93.184.215.14", family: 4 });
  assert.deepEqual(await resolveTarget(policy, "rebind.example", dns({ "rebind.example": ["127.0.0.1"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "mixed.example", dns({ "mixed.example": ["93.184.215.14", "10.0.0.5"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "mapped.example", dns({ "mapped.example": ["::ffff:192.168.0.10"] })), { refused: "blocked address" });
  assert.deepEqual(await resolveTarget(policy, "gone.example", dns({})), { refused: "not found" });
  assert.deepEqual(await resolveTarget(policy, "empty.example", dns({ "empty.example": [] })), { refused: "not found" });
  assert.deepEqual(await resolveTarget(policy, "x.tail1234.ts.net", dns({ "x.tail1234.ts.net": ["93.184.215.14"] })), { refused: "blocked host" });
  assert.deepEqual(await resolveTarget(policy, "100.96.145.38", dns({})), { refused: "blocked host" });
  assert.deepEqual(await resolveTarget(policy, "[2606:4700::1111]", dns({})), { address: "2606:4700::1111", family: 6 });
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
function fakeDocker({ info = 0, image = false, build = 0, ps = "" } = {}) {
  const calls = [];
  const state = { image };
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
    if (sub === "ps") return { code: 0, stdout: ps, stderr: "" };
    if (sub === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, state };
}

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
  const browser = makeBrowser(docker);
  const notYet = await browser.prepare({ sourceId: "chat", cardId: "card" });
  assert.deepEqual(notYet, { ok: false, state: "building", detail: "" }, "a missing image starts building");
  await settled(browser);
  const ready = await browser.prepare({ sourceId: "chat", cardId: "card" });
  assert.equal(ready.ok, true);
  assert.equal(browser.consumeTicket(ready.ticket, { sourceId: "chat", cardId: "card" }), true);
  assert.equal(browser.consumeTicket(ready.ticket, { sourceId: "chat", cardId: "card" }), false);
  const mcp = await browser.mcpServer("run-1");
  assert.equal(mcp.command, "/usr/bin/docker");
  assert.deepEqual(mcp.env, { DOCKER_HOST: "unix:///run/user/1001/docker.sock" });
  assert.equal(mcp.args.at(-1), browser.image);
  assert.ok(mcp.args.includes("BP_BLOCKED_IPS=152.53.114.172"));
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
  const docker = fakeDocker({ image: true, ps: "abc123def456 bp-sb-run-1-old\n" });
  const browser = makeBrowser(docker);
  const { host, hooks } = fakeHost();
  const reg = registerServerBrowser(host, settingsWith([]), browser, { log: quiet });
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
  // container (a killed docker client can leave it running), never the new one.
  const reopened = await open({ request: { ...request, reason: "resume" } }, {});
  assert.ok(reopened?.mcpServers[SERVER_BROWSER_MCP_NAME]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(docker.calls.filter((call) => call[1] === "rm"), [["/usr/bin/docker", "rm", "-f", "abc123def456"]]);
  const newName = reopened.mcpServers[SERVER_BROWSER_MCP_NAME].args[reopened.mcpServers[SERVER_BROWSER_MCP_NAME].args.indexOf("--name") + 1];
  docker.calls.length = 0;
  const keep = makeBrowser(fakeDocker({ ps: `fff000fff000 ${newName}\n` }));
  assert.equal(await keep.removeContainers("run-1", newName), 0, "the current session's container stays");
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

test("settings v19: the Server browser is a usual way on desktop and phones; older documents stay as they are", () => {
  const v18 = { startMode: "paseo", mobileStartMode: "copy-only", runs: [["a:c", "r", "browser:chrome"]], done: [] };
  assert.deepEqual(migratePreferences(v18, 18), v18);
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /version: 19,/);
  const launch = readFileSync(new URL("../client/launch.ts", import.meta.url), "utf8");
  assert.match(launch, /way !== "server"/, "the Command Center opens ChatGPT when the usual way is the Server browser");
});

test("the card checks Docker before a Server browser run and starts it only with a ticket", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /onRunPress\("server"\)/);
  assert.match(card, /"Again: Server browser" : "Server browser"/);
  assert.match(card, /serverStatus\(\{ build: true \}\)/);
  assert.match(card, /if \(status\.state !== "ready"\) reason =/);
  assert.match(card, /prepareServerRun\(\{ sourceAgentId: agentId, cardId \}\)/);
  assert.match(card, /extraLabels = serverRunLabels\(prepared\.ticket\)/);
  assert.match(card, /in a browser on the Paseo server\? It is not signed in to your accounts\./);
  const paseoGroup = card.slice(card.indexOf('accessibilityLabel="Paseo">'), card.indexOf('accessibilityLabel="ChatGPT">'));
  assert.ok(paseoGroup.includes('onRunPress("server")'), "in the Paseo group, next to Paseo browser");
  assert.ok(!/\{mobile \? null : \(\s*<WayButton\s+label=\{runAgentId \? "Again: Server browser"/.test(card), "shown on phones too");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /labels: \{ \.\.\.input\.extraLabels, \.\.\.runLabels\(input\.sourceAgentId, input\.cardId\) \}/, "the run labels always win");
  const entry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(entry, /registerServerBrowser\(/);
  assert.match(entry, /server\.handle\(serverBrowserStatus/);
  assert.match(entry, /server\.handle\(prepareServerBrowserRun/);
  assert.ok(TICKET_LABEL.startsWith("browser-prompt"));
});
