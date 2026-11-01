// Run: npm test. Self-update core with mocked `paseo plugin ls`, `git ls-remote` and spawn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHECK_INTERVAL_MS,
  createUpdater,
  DEFAULT_UPDATE_STATE,
  hasConsent,
  migrateUpdateSettings,
  inferTrackedRef,
  isHttpsRemote,
  isThrottled,
  parseInstallInfo,
  parseLsRemote,
  sanitizeError,
} from "../shared/updater.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REMOTE = "https://github.com/acme/paseo-plugin-browser-prompt.git";
// Built at runtime so no token-shaped literal sits in the source.
const FAKE_TOKEN = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz"].join("");

const lsJson = (revision = A) => [
  { id: "other", installation: { identity: { kind: "git", remote: "x" }, currentRevision: B } },
  {
    id: "browser-prompt",
    installation: { identity: { kind: "git", remote: REMOTE, pluginPath: "." }, currentRevision: revision },
    source: "git",
  },
];

const lsRemote = (heads, head = "refs/heads/main") =>
  [`ref: ${head}\tHEAD`, `${heads[head] ?? C}\tHEAD`, ...Object.entries(heads).map(([ref, sha]) => `${sha}\t${ref}`)].join("\n");

// The owner enabled auto-update for REMOTE, unless a test says otherwise.
const CONSENTED = { autoUpdate: true, consentRemote: REMOTE };

function harness({ install = { kind: "git", remote: REMOTE, revision: A }, remote, state = {}, lock = true, spawnError, fastForward = true, saveError, loadError, consent = CONSENTED } = {}) {
  const calls = { lsRemote: 0, spawn: [], logs: [], lock: 0, release: 0, ff: [], listInstall: 0 };
  let now = 1_000_000_000;
  let stored = { ...DEFAULT_UPDATE_STATE, ...consent, ...state };
  const updater = createUpdater({
    now: () => now,
    listInstall: async () => {
      calls.listInstall++;
      return install;
    },
    lsRemote: async (url) => {
      calls.lsRemote++;
      assert.equal(url, install.remote);
      if (remote instanceof Error) throw remote;
      return remote;
    },
    isFastForward: async (url, ref, installed, latest) => {
      assert.equal(url, install.remote);
      calls.ff.push([ref, installed, latest]);
      if (fastForward instanceof Error) throw fastForward;
      return fastForward;
    },
    acquireLock: async () => {
      calls.lock++;
      return lock;
    },
    releaseLock: async () => {
      calls.release++;
    },
    spawnUpdate: async (rev) => {
      if (spawnError) throw spawnError;
      calls.spawn.push(rev);
    },
    loadState: async () => {
      if (loadError) throw loadError;
      return stored;
    },
    saveState: async (patch) => {
      if (saveError && patch.lastResult === "updating") throw saveError;
      stored = { ...stored, ...patch };
    },
    log: (m) => calls.logs.push(m),
  });
  return {
    updater,
    calls,
    advance: (ms) => (now += ms),
    get stored() {
      return stored;
    },
  };
}

test("parses this plugin's git install from paseo plugin ls --json", () => {
  assert.deepEqual(parseInstallInfo(lsJson()), { kind: "git", remote: REMOTE, revision: A });
  assert.equal(parseInstallInfo({ plugins: lsJson(B) }).revision, B);
  assert.equal(parseInstallInfo([{ id: "browser-prompt", source: "/srv/plugins/browser-prompt", path: "/srv/plugins/browser-prompt" }]).kind, "local");
  assert.equal(parseInstallInfo([{ id: "browser-prompt", installation: { identity: { kind: "npm" } } }]).kind, "other");
  assert.equal(parseInstallInfo([]).kind, "other");
});

test("parses ls-remote with symref", () => {
  const refs = parseLsRemote(lsRemote({ "refs/heads/main": A, "refs/heads/feat/x": B }));
  assert.equal(refs.defaultBranch, "refs/heads/main");
  assert.equal(refs.heads.get("refs/heads/feat/x"), B);
  assert.equal(refs.heads.has("HEAD"), false);
});

test("tracked ref follows the branch the install was made from", () => {
  const refs = parseLsRemote(lsRemote({ "refs/heads/main": A, "refs/heads/feat/x": B }));
  assert.equal(inferTrackedRef(refs, A, null), "refs/heads/main");
  assert.equal(inferTrackedRef(refs, B, null), "refs/heads/feat/x");
  // the branch moved on since the install: keep following it
  assert.equal(inferTrackedRef(refs, C, "refs/heads/feat/x"), "refs/heads/feat/x");
  // installed commit is the tip of several branches: previous wins, then the default branch
  const both = parseLsRemote(lsRemote({ "refs/heads/main": A, "refs/heads/feat/x": A }));
  assert.equal(inferTrackedRef(both, A, "refs/heads/feat/x"), "refs/heads/feat/x");
  assert.equal(inferTrackedRef(both, A, null), "refs/heads/main");
  // after `paseo plugin update --ref main` the install sits on main again
  assert.equal(inferTrackedRef(refs, A, "refs/heads/feat/x"), "refs/heads/main");
  // unknown commit and no history: default branch; an override always wins
  assert.equal(inferTrackedRef(refs, C, null), "refs/heads/main");
  assert.equal(inferTrackedRef(refs, A, null, "feat/x"), "refs/heads/feat/x");
});

test("throttle: one remote check per 30 minutes unless forced", () => {
  assert.equal(isThrottled(0, 5, false), false);
  assert.equal(isThrottled(1000, 1000 + CHECK_INTERVAL_MS - 1, false), true);
  assert.equal(isThrottled(1000, 1000 + CHECK_INTERVAL_MS, false), false);
  assert.equal(isThrottled(1000, 1001, true), false);
});

test("newer commit on the tracked branch: spawns one detached update for that commit", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), state: { trackedRef: "refs/heads/main" } });
  const result = await h.updater.check();
  assert.equal(result.status, "updating");
  assert.equal(result.applied, true);
  assert.deepEqual(h.calls.spawn, [B]);
  assert.equal(h.stored.lastResult, "updating");
  assert.equal(h.stored.latestRevision, B);
  const again = await h.updater.check({ force: true });
  assert.equal(again.status, "busy");
  assert.equal(h.calls.spawn.length, 1);
});

test("a remembered branch is ignored after the install was changed by hand", async () => {
  // Simulated: the updater last followed feat/x (A -> B), then someone ran `update --ref main` (C),
  // and main has moved on to D since. Following feat/x again would downgrade to B.
  const D = "d".repeat(40);
  const h = harness({
    install: { kind: "git", remote: REMOTE, revision: C },
    remote: lsRemote({ "refs/heads/main": D, "refs/heads/feat/x": B }),
    state: { trackedRef: "refs/heads/feat/x", installedRevision: A, latestRevision: B },
  });
  const result = await h.updater.check({ force: true });
  assert.equal(result.trackedRef, "refs/heads/main");
  assert.deepEqual(h.calls.spawn, [D]);
});

test("a remembered branch is kept after the updater's own update", async () => {
  const D = "d".repeat(40);
  const h = harness({
    install: { kind: "git", remote: REMOTE, revision: B },
    remote: lsRemote({ "refs/heads/main": A, "refs/heads/feat/x": D }),
    state: { trackedRef: "refs/heads/feat/x", installedRevision: A, latestRevision: B },
  });
  const result = await h.updater.check({ force: true });
  assert.equal(result.trackedRef, "refs/heads/feat/x");
  assert.deepEqual(h.calls.spawn, [D]);
});

test("up to date: no spawn; a second call within 30 minutes is throttled without a remote call", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": A }) });
  assert.equal((await h.updater.check()).status, "up-to-date");
  assert.equal((await h.updater.check()).status, "throttled");
  assert.equal(h.calls.lsRemote, 1);
  assert.equal((await h.updater.check({ force: true })).status, "up-to-date");
  assert.equal(h.calls.lsRemote, 2);
  h.advance(CHECK_INTERVAL_MS + 1);
  await h.updater.check();
  assert.equal(h.calls.lsRemote, 3);
  assert.equal(h.calls.spawn.length, 0);
});

test("persisted last-check time throttles a fresh process", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), state: { lastCheckAt: 1_000_000_000 - 60_000 } });
  assert.equal((await h.updater.check()).status, "throttled");
  assert.equal(h.calls.lsRemote, 0);
});

test("concurrent checks share one remote call", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }) });
  const [a, b] = await Promise.all([h.updater.check(), h.updater.check()]);
  assert.deepEqual(a, b);
  assert.equal(h.calls.lsRemote, 1);
  assert.equal(h.calls.spawn.length, 1);
});

test("lock held by another process: no spawn", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), lock: false });
  assert.equal((await h.updater.check()).status, "busy");
  assert.equal(h.calls.spawn.length, 0);
});

test("local install: never updates", async () => {
  const h = harness({ install: { kind: "local" }, remote: lsRemote({ "refs/heads/main": B }) });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "local");
  assert.match(result.message, /Local install, no auto-update/);
  assert.equal(h.calls.lsRemote, 0);
  assert.equal(h.calls.spawn.length, 0);
});

test("auto-update off: reports the update, does not apply it", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), state: { autoUpdate: false } });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "update-available");
  assert.equal(h.calls.lock, 0);
  assert.equal(h.calls.spawn.length, 0);
});

test("ls-remote failure is recorded without credentials", async () => {
  const h = harness({ remote: new Error(`git ls-remote https://user:${FAKE_TOKEN}@github.com/x timed out after 10s`) });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "failed");
  assert.match(h.stored.lastResult, /^failed: /);
  for (const text of [result.message, h.stored.lastResult, ...h.calls.logs]) {
    assert.ok(!text.includes(FAKE_TOKEN), "token removed");
    assert.ok(!text.includes("user:"), "userinfo removed");
  }
  assert.equal(sanitizeError("https://x-access-token:abc@github.com/a"), "https://***@github.com/a");
});

test("spawn failure releases the lock", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), spawnError: new Error("paseo CLI not found") });
  const result = await h.updater.check();
  assert.equal(result.status, "failed");
  assert.equal(h.calls.release, 1);
  assert.match(h.stored.lastResult, /paseo CLI not found/);
});

test("only https:// remotes update themselves", async () => {
  assert.equal(isHttpsRemote(REMOTE), true);
  for (const remote of ["git@github.com:acme/x.git", "ssh://git@github.com/acme/x", "http://github.com/acme/x", "file:///srv/x", "/srv/x", "git://h/x"]) {
    assert.equal(isHttpsRemote(remote), false, remote);
  }
  const h = harness({ install: { kind: "git", remote: "git@github.com:acme/x.git", revision: A }, remote: lsRemote({ "refs/heads/main": B }) });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "unsupported");
  assert.equal(h.calls.lsRemote, 0);
  assert.equal(h.calls.spawn.length, 0);
});

test("a newer tip that is not a fast-forward is never installed", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), fastForward: false });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "not-fast-forward");
  assert.deepEqual(h.calls.ff, [["refs/heads/main", A, B]]);
  assert.equal(h.calls.lock, 0);
  assert.equal(h.calls.spawn.length, 0);
  assert.equal(h.stored.lastResult, "not-fast-forward");
});

test("history fetch failure: no update", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), fastForward: new Error("git timed out after 60s") });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "failed");
  assert.equal(h.calls.spawn.length, 0);
});

test("a state-file failure after starting the update still reports it and stays busy", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), saveError: new Error("EACCES") });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "updating");
  assert.deepEqual(h.calls.spawn, [B]);
  assert.ok(h.calls.logs.some((line) => /could not record the update/.test(line)));
  assert.equal((await h.updater.check({ force: true })).status, "busy");
});

test("a failed spawn resets the in-process flag so a later check can retry", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), spawnError: new Error("paseo CLI not found") });
  assert.equal((await h.updater.check({ force: true })).status, "failed");
  assert.equal((await h.updater.check({ force: true })).status, "failed", "not stuck on busy");
  assert.equal(h.calls.lock, 2);
  assert.equal(h.calls.release, 2);
});

const NO_CONSENT = { autoUpdate: false, consentRemote: "" };

test("auto-update is off by default", () => {
  assert.equal(DEFAULT_UPDATE_STATE.autoUpdate, false);
  assert.equal(DEFAULT_UPDATE_STATE.consentRemote, "");
  assert.match(readFileSync(new URL("../shared/update.ts", import.meta.url), "utf8"), /autoUpdate: z\.boolean\(\)\.default\(DEFAULT_UPDATE_STATE\.autoUpdate\)/);
});

test("without consent an automatic check (a card shown or used) touches nothing: no install read, no network, no update", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), consent: NO_CONSENT });
  const result = await h.updater.check();
  assert.equal(result.status, "not-consented");
  assert.equal(result.applied, false);
  assert.deepEqual([h.calls.listInstall, h.calls.lsRemote, h.calls.ff.length, h.calls.lock, h.calls.spawn.length], [0, 0, 0, 0, 0]);
  assert.equal(h.stored.lastCheckAt, 0, "nothing recorded either");
});

test("unreadable settings or state never install", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), loadError: new Error("settings invalid") });
  assert.equal((await h.updater.check()).status, "not-consented", "reads as no consent");
  const forced = await h.updater.check({ force: true });
  assert.equal(forced.status, "update-available", "Check now still only reports");
  assert.equal(h.calls.spawn.length, 0);
  const server = readFileSync(new URL("../server/updater.ts", import.meta.url), "utf8");
  assert.match(server, /const prefs = current\?\.status === "ready" \? current\.values : DEFAULT_UPDATE_STATE;/);
  assert.match(server, /await settings\.read\(\)\.catch\(\(\) => null\)/);
});

test("consent is tied to the remote it was given for", async () => {
  assert.equal(hasConsent({ autoUpdate: true, consentRemote: REMOTE }, REMOTE), true);
  assert.equal(hasConsent({ autoUpdate: true, consentRemote: REMOTE }, "https://github.com/other/fork.git"), false);
  assert.equal(hasConsent({ autoUpdate: true, consentRemote: "" }, REMOTE), false);
  assert.equal(hasConsent({ autoUpdate: false, consentRemote: REMOTE }, REMOTE), false);
  assert.equal(hasConsent({ autoUpdate: true, consentRemote: REMOTE }, undefined), false);
  const moved = harness({
    install: { kind: "git", remote: "https://github.com/other/fork.git", revision: A },
    remote: lsRemote({ "refs/heads/main": B }),
  });
  const auto = await moved.updater.check();
  assert.equal(auto.status, "not-consented", "the install moved to another remote: consent is void");
  assert.equal(moved.calls.lsRemote, 0, "neither remote is contacted");
  const forced = await moved.updater.check({ force: true });
  assert.equal(forced.status, "update-available", "Check now reports but does not install");
  assert.equal(moved.calls.spawn.length, 0);
});

test("Check now without consent reads the remote but installs nothing", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), consent: NO_CONSENT });
  const result = await h.updater.check({ force: true });
  assert.equal(result.status, "update-available");
  assert.equal(result.latestRevision, B);
  assert.equal(h.calls.lsRemote, 1);
  assert.equal(h.calls.spawn.length, 0);
});

test("Update now installs only the commit and remote the owner was shown, only on that click", async () => {
  const h = harness({ remote: lsRemote({ "refs/heads/main": B }), consent: NO_CONSENT });
  const result = await h.updater.check({ install: { remote: REMOTE, revision: B } });
  assert.equal(result.status, "updating");
  assert.equal(result.applied, true);
  assert.deepEqual(h.calls.spawn, [B]);

  const newer = harness({ remote: lsRemote({ "refs/heads/main": C }), consent: NO_CONSENT });
  const moved = await newer.updater.check({ install: { remote: REMOTE, revision: B } });
  assert.equal(moved.status, "changed", "a newer commit than the one shown");
  assert.equal(newer.calls.spawn.length, 0);

  const other = harness({ remote: lsRemote({ "refs/heads/main": B }), consent: NO_CONSENT });
  const elsewhere = await other.updater.check({ install: { remote: "https://github.com/other/fork.git", revision: B } });
  assert.equal(elsewhere.status, "changed", "the install's remote is not the one shown");
  assert.equal(other.calls.lsRemote, 0);
  assert.equal(other.calls.spawn.length, 0);

  const sideways = harness({ remote: lsRemote({ "refs/heads/main": B }), consent: NO_CONSENT, fastForward: false });
  assert.equal((await sideways.updater.check({ install: { remote: REMOTE, revision: B } })).status, "not-fast-forward");
  assert.equal(sideways.calls.spawn.length, 0);
});

test("settings migration: auto-update stored before 0.10.0 starts off and asks", () => {
  assert.deepEqual(migrateUpdateSettings({ autoUpdate: true, trackRefOverride: "main" }, 1), { autoUpdate: false, consentRemote: "", trackRefOverride: "main" });
  assert.deepEqual(migrateUpdateSettings({ autoUpdate: false }, 1), { autoUpdate: false, consentRemote: "" });
  assert.deepEqual(migrateUpdateSettings(null, 1), { autoUpdate: false, consentRemote: "" });
  const current = { autoUpdate: true, consentRemote: REMOTE, trackRefOverride: "" };
  assert.equal(migrateUpdateSettings(current, 2), current, "a consent given in 0.10.0 or later stays");
  const settings = readFileSync(new URL("../shared/update.ts", import.meta.url), "utf8");
  assert.match(settings, /version: 2,/);
  assert.match(settings, /migrate: migrateUpdateSettings,/);
});

test("the card's first render and use never check or install without consent", () => {
  const client = readFileSync(new URL("../client/update.ts", import.meta.url), "utf8");
  assert.match(client, /const enabled = settings\.status === "ready" && settings\.values\.autoUpdate === true && settings\.values\.consentRemote !== "";/);
  assert.match(client, /if \(checkedThisSession \|\| !enabled\) return;/);
  assert.match(client, /if \(!enabled\) return;/);
});

test("the consent text names the repository and says code will be installed", () => {
  const ui = readFileSync(new URL("../client/update-settings.tsx", import.meta.url), "utf8");
  assert.match(ui, /newer plugin code from \$\{remote\} will be downloaded and installed automatically/);
  assert.match(ui, /Nothing is downloaded or installed until you enable it\./);
  assert.match(ui, /consentRemote: remote \}, revision\)/, "consent stores the remote it was given for");
  assert.match(ui, /actionLabel="Enable auto-update"/);
  assert.match(ui, /actionLabel="Not now"/);
  assert.match(ui, /Downloads commit \$\{shortSha\(revision\)\} from \$\{remote\} and installs it as this plugin/);
  assert.match(ui, /install\(\{ remote, revision \}\)/, "Update now sends what was shown");
});
