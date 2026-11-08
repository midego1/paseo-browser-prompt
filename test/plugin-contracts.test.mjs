// Run: npm test. What Paseo's plugin loader checks when it installs the plugin: every RPC name passes
// the SDK's rule. A bad name stops the whole install, and nothing else in the suite loads these files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { archivedAfterSuccess } from "../shared/archive-rpc.ts";

const shared = new URL("../shared/", import.meta.url);
const rpcNames = readdirSync(shared)
  .filter((file) => file.endsWith(".ts"))
  .flatMap((file) => {
    const source = readFileSync(new URL(file, shared), "utf8");
    return [...source.matchAll(/defineRpc\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]);
  });

test("every RPC name in shared/ is accepted by the SDK", () => {
  assert.ok(rpcNames.length >= 8, `found ${rpcNames.join(", ")}`);
  assert.equal(new Set(rpcNames).size, rpcNames.length, "names are unique");
  for (const name of rpcNames) assert.doesNotThrow(() => defineRpc({ name, input: z.object({}), output: z.object({}) }), name);
});

test("the check catches a bad name, and the archive RPC really loads", () => {
  assert.throws(() => defineRpc({ name: "run.archivedAfterSuccess", input: z.object({}), output: z.object({}) }), /Invalid plugin RPC method/);
  assert.equal(archivedAfterSuccess.name, "run.archived");
});

test("package files exist and the descriptions name every way to start", async () => {
  const { existsSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of pkg.files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is listed but missing`);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
  for (const description of [manifest.description, pkg.description]) {
    for (const way of ["ChatGPT", "Claude desktop", "Paseo browser", "Claude in Chrome"]) assert.ok(description.includes(way), `${way}: ${description}`);
  }
});

test("OVERVIEW.md describes the 0.20 card and settings", () => {
  const overview = readFileSync(new URL("../OVERVIEW.md", import.meta.url), "utf8");
  assert.doesNotMatch(overview.split("\n")[0], /Chrome extension/, "ChatGPT has no extension button since 0.20");
  assert.doesNotMatch(overview, /\*\*Chrome\*\* button|ChatGPT app button/);
  assert.match(overview, /Chrome tab/);
  const screen = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  const ways = [...screen.matchAll(/\{ label: "([^"]+)", value: "(app|web-agent|claude-desktop|paseo|chrome|copy-only)" \}/g)].map((m) => m[1]);
  const settings = overview.slice(overview.indexOf("## Settings"));
  for (const way of new Set(ways)) assert.ok(settings.includes(way.replace("Copy only", "copy only")), `usual way ${way}`);
  for (const label of ["Close tabs after a successful run", "Archive the agent after a successful run", "Claude in Chrome provider"]) {
    assert.match(screen, new RegExp(`label="${label}"`));
    assert.ok(settings.toLowerCase().includes(label.toLowerCase()), label);
  }
});
