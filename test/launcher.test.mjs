// Run: npm test. Per-machine launcher address: detection, fallbacks, and the launcher staying off.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLauncher, LAUNCHER_RETRY_MIN_MS } from "../server/launcher.ts";
import {
  chooseTrampolineHost,
  isTailscaleIPv4,
  LAUNCHER_UNAVAILABLE_MESSAGES,
  parseTailscaleIp,
  pickTailscaleInterface,
  validateConfiguredHost,
  validatePort,
} from "../shared/trampoline-host.ts";

const iface = (address, extra = {}) => ({ address, family: "IPv4", internal: false, ...extra });
const noTailscale = { tailscaleIp: async () => Promise.reject(new Error("ENOENT")), interfaces: () => ({}) };

test("100.64.0.0/10 detection", () => {
  for (const ip of ["100.64.0.1", "100.101.2.3", "100.127.255.254"]) assert.equal(isTailscaleIPv4(ip), true, ip);
  for (const ip of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.5", "100.101.2", "100.101.2.300", "fd7a::1"]) {
    assert.equal(isTailscaleIPv4(ip), false, ip);
  }
});

test("parses tailscale ip -4 output", () => {
  assert.equal(parseTailscaleIp("100.101.2.3\n"), "100.101.2.3");
  assert.equal(parseTailscaleIp("\n  100.101.2.3  \n100.64.0.9\n"), "100.101.2.3");
  assert.equal(parseTailscaleIp("Tailscale is stopped.\n"), null);
  assert.equal(parseTailscaleIp(""), null);
});

test("interface scan prefers Tailscale-named interfaces and skips internal/IPv6", () => {
  const table = {
    eth0: [iface("192.168.1.10"), iface("100.70.0.1")],
    tailscale0: [{ address: "fd7a:115c::1", family: "IPv6", internal: false }, iface("100.101.2.3")],
    lo: [iface("100.80.0.1", { internal: true })],
  };
  assert.equal(pickTailscaleInterface(table), "100.101.2.3");
  assert.equal(pickTailscaleInterface({ utun4: [iface("100.100.1.1", { family: 4 })], en0: [iface("192.168.0.2")] }), "100.100.1.1");
  assert.equal(pickTailscaleInterface({ en0: [iface("192.168.0.2")], lo0: [iface("127.0.0.1", { internal: true })] }), null);
  // CGNAT/VPN addresses on other interfaces are never chosen
  assert.equal(pickTailscaleInterface({ eth0: [iface("100.70.0.1")], wg0: [iface("100.80.0.2")], ppp0: [iface("100.90.0.3")] }), null);
  assert.equal(pickTailscaleInterface({ utun3: [iface("100.70.0.1")], tailscale0: [iface("100.99.0.1")] }), "100.99.0.1");
});

test("host choice: setting, then tailscale CLI, then interfaces, then none", async () => {
  const cli = { tailscaleIp: async () => "100.101.2.3\n", interfaces: () => ({ tailscale0: [iface("100.99.0.1")] }) };
  // a setting is used only when it is one of this machine's addresses
  assert.deepEqual(await chooseTrampolineHost("100.99.0.1", cli), { host: "100.99.0.1", source: "setting" });
  assert.deepEqual(await chooseTrampolineHost("100.101.2.3", cli), { host: "100.101.2.3", source: "setting" });
  assert.deepEqual(await chooseTrampolineHost("100.88.1.2", cli), { host: null, source: "none", reason: "not-local" });
  assert.deepEqual(await chooseTrampolineHost("192.168.1.10", cli), { host: null, source: "none", reason: "not-local" });
  assert.deepEqual(await chooseTrampolineHost("printer.local", cli), { host: null, source: "none", reason: "not-local" });
  // a CGNAT address on a non-Tailscale interface is not accepted as a setting
  const vpn = { tailscaleIp: noTailscale.tailscaleIp, interfaces: () => ({ wg0: [iface("100.70.0.1")] }) };
  assert.deepEqual(await chooseTrampolineHost("100.70.0.1", vpn), { host: null, source: "none", reason: "not-local" });
  assert.deepEqual(await chooseTrampolineHost("", vpn), { host: null, source: "none", reason: "no-tailscale" });
  assert.deepEqual(await chooseTrampolineHost("127.0.0.1", noTailscale), { host: "127.0.0.1", source: "setting" });
  assert.deepEqual(await chooseTrampolineHost("", cli), { host: "100.101.2.3", source: "tailscale" });
  const cliFails = { tailscaleIp: async () => Promise.reject(new Error("timed out")), interfaces: cli.interfaces };
  assert.deepEqual(await chooseTrampolineHost("  ", cliFails), { host: "100.99.0.1", source: "interfaces" });
  assert.deepEqual(await chooseTrampolineHost("", noTailscale), { host: null, source: "none", reason: "no-tailscale" });
  // a wildcard setting is refused, never bound
  assert.deepEqual(await chooseTrampolineHost("0.0.0.0", cli), { host: null, source: "none", reason: "not-local" });
  const throwingInterfaces = { tailscaleIp: noTailscale.tailscaleIp, interfaces: () => { throw new Error("x"); } };
  assert.deepEqual(await chooseTrampolineHost("", throwingInterfaces), { host: null, source: "none", reason: "no-tailscale" });
});

test("setting validation", () => {
  assert.equal(validateConfiguredHost(""), null);
  assert.equal(validateConfiguredHost("100.101.2.3"), null);
  assert.equal(validateConfiguredHost("127.0.0.1"), null);
  assert.ok(validateConfiguredHost("0.0.0.0"));
  assert.ok(validateConfiguredHost("192.168.1.10"));
  assert.ok(validateConfiguredHost("8.8.8.8"));
  assert.ok(validateConfiguredHost("host.example.com"));
  assert.ok(validateConfiguredHost("::"));
  assert.ok(validateConfiguredHost("a b"));
  assert.equal(validatePort(5299), null);
  assert.ok(validatePort(80));
  assert.ok(validatePort(70000));
  assert.ok(validatePort(52.5));
});

test("no Tailscale address: launcher stays off and stash reports it", async () => {
  let started = 0;
  const launcher = createLauncher(noTailscale, () => {
    started++;
    throw new Error("must not start");
  });
  await launcher.configure({ trampolineHost: "", trampolinePort: 5299 });
  assert.equal(started, 0);
  assert.deepEqual(launcher.status(), { state: "no-tailscale", host: null, port: 5299, source: "none" });
  assert.deepEqual(launcher.stash("prompt", ""), { unavailable: "no-tailscale" });
  assert.equal(LAUNCHER_UNAVAILABLE_MESSAGES["no-tailscale"], "ChatGPT launcher needs Tailscale on this host");
  await launcher.close();
});

test("a bind address that is not this machine's keeps the launcher off", async () => {
  let started = 0;
  const probes = { tailscaleIp: async () => "100.101.2.3\n", interfaces: () => ({}) };
  const launcher = createLauncher(probes, () => {
    started++;
    throw new Error("must not start");
  });
  await launcher.configure({ trampolineHost: "100.88.1.2", trampolinePort: 5299 });
  assert.equal(started, 0);
  assert.equal(launcher.status().state, "not-local");
  assert.deepEqual(launcher.stash("prompt", ""), { unavailable: "not-local" });
  await launcher.close();
});

test("listens on the chosen host, restarts on a new port, reports EADDRINUSE", async () => {
  const port = 16299 + Math.floor(Math.random() * 1000);
  // 127.0.0.1 (allowed as an explicit setting) stands in for the Tailscale address in tests.
  const launcher = createLauncher(noTailscale);
  await launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: port });
  assert.deepEqual(launcher.status(), { state: "listening", host: "127.0.0.1", port, source: "setting" });
  const outcome = launcher.stash("secret-free prompt", "");
  assert.ok("url" in outcome && outcome.url.startsWith(`http://127.0.0.1:${port}/open?id=`));
  assert.equal((await fetch(outcome.url)).status, 200);

  // same config again: no restart
  await launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: port });
  assert.equal(launcher.status().state, "listening");

  // occupied port
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(port + 1, "127.0.0.1", resolve));
  await launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: port + 1 });
  assert.equal(launcher.status().state, "port-in-use");
  assert.deepEqual(launcher.stash("x", ""), { unavailable: "port-in-use" });
  await new Promise((resolve) => blocker.close(resolve));

  // the old port was released when the config changed
  await assert.rejects(fetch(`http://127.0.0.1:${port}/open?id=x`));
  await launcher.close();
});

test("an off launcher is set up again before a stash, with a bounded backoff", async () => {
  let now = 0;
  let probes = 0;
  let tailscale = false;
  const flaky = {
    tailscaleIp: async () => {
      probes++;
      if (!tailscale) throw new Error("ENOENT");
      return "100.101.2.3\n";
    },
    interfaces: () => ({}),
  };
  const started = [];
  const fake = (host, port) => {
    started.push(`${host}:${port}`);
    return { ready: Promise.resolve(), state: () => ({ listening: true }), stash: () => "http://x/open?id=1", close: async () => {} };
  };
  const launcher = createLauncher(flaky, fake, { now: () => now });
  await launcher.configure({ trampolineHost: "", trampolinePort: 5299 });
  assert.equal(launcher.status().state, "no-tailscale");
  const first = probes;
  await launcher.retry();
  assert.equal(probes, first + 1, "a stash re-probes Tailscale");
  await launcher.retry();
  assert.equal(probes, first + 1, "not again within the backoff");
  // Tailscale comes up; the next retry after the backoff starts the launcher.
  tailscale = true;
  now += LAUNCHER_RETRY_MIN_MS - 1;
  await launcher.retry();
  assert.equal(launcher.status().state, "no-tailscale", "the backoff holds");
  now += LAUNCHER_RETRY_MIN_MS * 2;
  await launcher.retry();
  assert.equal(launcher.status().state, "listening");
  assert.deepEqual(started, ["100.101.2.3:5299"]);
  await launcher.retry();
  assert.equal(started.length, 1, "a listening launcher is left alone");
  await launcher.close();
});

test("a port that was in use is tried again after the backoff", async () => {
  const port = 17299 + Math.floor(Math.random() * 1000);
  let now = 0;
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  const launcher = createLauncher(noTailscale, undefined, { now: () => now });
  await launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: port });
  assert.equal(launcher.status().state, "port-in-use");
  await new Promise((resolve) => blocker.close(resolve));
  await launcher.retry();
  assert.equal(launcher.status().state, "listening", "the freed port is picked up without a setting change");
  const outcome = launcher.stash("prompt", "");
  assert.ok("url" in outcome);
  await launcher.close();

  const index = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(index, /server\.handle\(stashPrompt, async \(\{ prompt, target \}\) => \{\s*\/\/[^\n]*\n\s*await launcher\.retry\(\);/);
});

test("a retry queued behind a setting change applies the new setting, never the old one", async () => {
  const started = [];
  // Port 6001 is taken; 6002 listens.
  const fake = (host, port) => {
    started.push(port);
    const listening = port !== 6001;
    return { ready: Promise.resolve(), state: () => ({ listening, failure: listening ? undefined : "EADDRINUSE" }), stash: () => "http://x/open?id=1", close: async () => {} };
  };
  const launcher = createLauncher(noTailscale, fake, { now: () => 0 });
  await launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: 6001 });
  assert.equal(launcher.status().state, "port-in-use");
  // The owner moves to port 6002; before that change applies, a stash asks for a retry.
  const change = launcher.configure({ trampolineHost: "127.0.0.1", trampolinePort: 6002 });
  const retried = launcher.retry();
  await Promise.all([change, retried]);
  assert.deepEqual(launcher.status(), { state: "listening", host: "127.0.0.1", port: 6002, source: "setting" }, "the retry did not bring back port 6001");
  assert.deepEqual(started, [6001, 6002], "and did not start the old port again");
  await launcher.close();
});
