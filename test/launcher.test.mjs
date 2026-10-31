// Run: npm test. Per-machine launcher address: detection, fallbacks, and the launcher staying off.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { createLauncher } from "../server/launcher.ts";
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
