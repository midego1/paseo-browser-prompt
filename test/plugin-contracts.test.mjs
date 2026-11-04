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
