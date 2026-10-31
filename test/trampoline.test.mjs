// Integration test for the one-time trampoline on a loopback port (the plugin itself binds the tailnet IP).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startTrampoline } from "../server/trampoline.ts";

test("stash -> one fetch -> gone; EADDRINUSE is handled", async () => {
  const port = 15299 + Math.floor(Math.random() * 1000);
  const t = startTrampoline("127.0.0.1", port);
  await new Promise((r) => setTimeout(r, 150));
  const url = t.stash("Use computer use. Step 1 & <b>", "codex://new?prompt={prompt}");
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/open\\?id=[A-Za-z0-9_-]{24}$`));
  assert.ok(!url.includes("computer"), "prompt never in the trampoline URL");
  const first = await fetch(url);
  assert.equal(first.status, 200);
  const html = await first.text();
  assert.ok(html.includes("location.replace(\"codex://new?prompt=Use%20computer%20use.%20Step%201%20%26%20%3Cb%3E"));
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(url)).status, 410, "second fetch is gone");
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);

  const clash = startTrampoline("127.0.0.1", port);
  await new Promise((r) => setTimeout(r, 150));
  assert.throws(() => clash.stash("x", ""), /unavailable \(EADDRINUSE\)/);
  await clash.close();
  await t.close();
});
