// Run: npm test  (Node 22+, uses --experimental-strip-types to load the shared TypeScript module)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composePrompt,
  explodeMessage,
  findBrowserPrompts,
  planChatGptLaunch,
  MAX_URL_LENGTH,
  buildAppLink,
  DEFAULT_APP_LINK_TEMPLATE,
  renderTrampolinePage,
  trampolineHeaders,
  validateAppLinkTemplate,
  isSafeLinkHref,
} from "../shared/browser-prompt.ts";

const FENCE = "```";
const message = [
  "Before deploying, please do this:",
  "",
  `${FENCE}browser-prompt Set DEPLOY_TOKEN`,
  "1. Open https://github.com/acme/webshop/settings/secrets/actions",
  "2. Click New repository secret, name it DEPLOY_TOKEN.",
  FENCE,
  "",
  "Then this one:",
  "",
  `${FENCE}browser-prompt`,
  "1. Open https://dns.example.com",
  FENCE,
  "",
  "Tell me when done.",
].join("\n");

test("finds blocks with and without titles", () => {
  const blocks = findBrowserPrompts(message);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, "Set DEPLOY_TOKEN");
  assert.match(blocks[0].body, /^1\. Open https:\/\/github\.com/);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[1].title, "");
});

test("explodes into markdown + card per block without losing text", () => {
  const items = explodeMessage(message, "complete");
  assert.ok(items);
  const scope = /^md-(h[0-9a-f]{8}-)0$/.exec(items[0].id)?.[1];
  assert.ok(scope, "ids name the message (no message id: a hash of its text up to the first block)");
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), [
    `browser-prompt-markdown:md-${scope}0`,
    `browser-prompt-card:card-${scope}0`,
    `browser-prompt-markdown:md-${scope}1`,
    `browser-prompt-card:card-${scope}1`,
    `browser-prompt-markdown:md-${scope}2`,
  ]);
  assert.deepEqual(
    explodeMessage(message, "complete", "msg-7").map((i) => i.id),
    ["md-msg-7-0", "card-msg-7-0", "md-msg-7-1", "card-msg-7-1", "md-msg-7-2"],
  );
  const rebuilt = items.filter((i) => i.kind === "browser-prompt-markdown").map((i) => i.data.text).join("");
  assert.equal(rebuilt, message, "markdown segments concatenate back to the original text");
  assert.doesNotThrow(() => JSON.stringify(items));
});

test("is deterministic", () => {
  assert.deepEqual(explodeMessage(message, "complete"), explodeMessage(message, "complete"));
});

test("streaming: no card until the closing fence arrives", () => {
  const partial = message.slice(0, message.indexOf("2. Click"));
  assert.equal(explodeMessage(partial, "streaming"), undefined);
  const firstClosed = message.slice(0, message.indexOf("Then this one"));
  const items = explodeMessage(firstClosed, "streaming");
  assert.equal(items.filter((i) => i.kind === "browser-prompt-card").length, 1);
  const secondOpen = message.slice(0, message.indexOf("dns.example.com"));
  const items2 = explodeMessage(secondOpen, "streaming");
  assert.equal(items2.filter((i) => i.kind === "browser-prompt-card").length, 1);
  assert.equal(items2.at(-1).data.phase, "streaming");
  assert.match(items2.at(-1).data.text, /```browser-prompt/, "open block stays visible as text");
});

test("ignores plain text and other code blocks, including nested examples", () => {
  assert.equal(explodeMessage("no prompt here", "complete"), undefined);
  assert.equal(explodeMessage("mentions browser-prompt inline only", "complete"), undefined);
  const nested = ["````markdown", `${FENCE}browser-prompt Example`, "1. step", FENCE, "````"].join("\n");
  assert.equal(explodeMessage(nested, "complete"), undefined);
});

test("handles CRLF and indented fences in lists", () => {
  const text = ["1. Do this:", `   ${FENCE}browser-prompt Indented`, "   1. Open x", `   ${FENCE}`].join("\r\n");
  const [block] = findBrowserPrompts(text);
  assert.equal(block.title, "Indented");
  assert.equal(block.body, "1. Open x");
});

test("card id is stable for identical content", () => {
  const a = explodeMessage(message, "complete").find((i) => i.kind === "browser-prompt-card");
  const b = explodeMessage(`Intro\n\n${message}`, "complete").find((i) => i.kind === "browser-prompt-card");
  assert.equal(a.data.cardId, b.data.cardId);
});

test("launch plan: prefilled agent-mode URL when short and secret-free", () => {
  const prompt = composePrompt("Set DEPLOY_TOKEN", "1. Open https://github.com/x/y/settings/secrets/actions");
  assert.match(prompt, /^Use computer use \(@Computer\)/);
  const plan = planChatGptLaunch(prompt);
  assert.equal(plan.prefilled, true);
  assert.ok(plan.url.startsWith("https://chatgpt.com/?hints=agent&q="));
  assert.equal(new URL(plan.url).searchParams.get("q"), prompt);
});

test("launch plan: clipboard only when too long or secret-looking", () => {
  const long = composePrompt("Long", "x ".repeat(MAX_URL_LENGTH));
  assert.deepEqual(planChatGptLaunch(long), { url: "https://chatgpt.com/?hints=agent", prefilled: false, reason: "too-long" });
  const fakeToken = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789";
  assert.equal(planChatGptLaunch(composePrompt("Leak", `Paste ${fakeToken} into the field`)).reason, "possible-secret");
  const longHex = composePrompt("Sha", "Token a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
  assert.equal(planChatGptLaunch(longHex).prefilled, false);
});

test("app deep link: documented codex://new?prompt= with encoded prompt", () => {
  const prompt = composePrompt("T", "1. Open https://github.com/a?b=c&d=e\n2. Say \"hi\" <script>");
  const link = buildAppLink(DEFAULT_APP_LINK_TEMPLATE, prompt);
  assert.ok(link.startsWith("codex://new?prompt="));
  assert.equal(decodeURIComponent(link.slice("codex://new?prompt=".length)), prompt);
  assert.equal(buildAppLink("javascript:alert({prompt})", "x"), "codex://new?prompt=x", "unsafe template falls back");
});

test("template validation", () => {
  assert.equal(validateAppLinkTemplate(DEFAULT_APP_LINK_TEMPLATE), null);
  assert.equal(validateAppLinkTemplate("https://chatgpt.com/?q={prompt}"), null);
  assert.ok(validateAppLinkTemplate("codex://threads/new"));
  // allow-list: only codex: and https:
  for (const bad of ["javascript:{prompt}", "chatgpt://new?prompt={prompt}", "http://x/?q={prompt}", "file:///{prompt}", "vscode://x?{prompt}", "data:text/html,{prompt}"]) {
    assert.ok(validateAppLinkTemplate(bad), bad);
  }
  // an invalid template never reaches the link: the default is used instead
  assert.match(buildAppLink("javascript:alert({prompt})", "x"), /^codex:\/\/new\?prompt=x$/);
  assert.ok(validateAppLinkTemplate("no scheme {prompt}"));
});

test("trampoline page escapes the link and redirects with a nonce'd script", () => {
  const link = buildAppLink(DEFAULT_APP_LINK_TEMPLATE, "</script><b>x</b> & \"q\"");
  const page = renderTrampolinePage(link, "N0NCE");
  assert.ok(!page.includes("</script><b>"), "no raw markup from the prompt");
  assert.match(page, /<script nonce="N0NCE">location\.replace\("codex:\/\/new\?prompt=/);
  assert.match(page, /Open ChatGPT<\/a>/);
  const evil = renderTrampolinePage('codex://new?prompt=</script>"<x>', "N");
  assert.ok(!evil.includes('</script>"<x>'));
  assert.ok(evil.includes("\\u003c/script>"));
  assert.match(trampolineHeaders("N")["Content-Security-Policy"], /script-src 'nonce-N'/);
  assert.equal(trampolineHeaders("N")["Cache-Control"], "no-store");
});

test("message links open only for http(s) URLs", () => {
  for (const ok of ["https://example.com/a?b=c", "http://example.com", "HTTPS://EXAMPLE.COM"]) assert.equal(isSafeLinkHref(ok), true, ok);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "codex://new?prompt=x", "vscode://x", "data:text/html,x", "//example.com", "mailto:a@example.com", "https://"]) {
    assert.equal(isSafeLinkHref(bad), false, bad);
  }
});

test("listing media: GIF first, each file packaged, sizes bounded; the X cut and other stills stay out", async () => {
  const { readFileSync, statSync } = await import("node:fs");
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("paseo-plugin.json", root), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(manifest.media[0], "docs/assets/browser-prompt-tour.gif");
  for (const file of manifest.media) {
    assert.ok(pkg.files.includes(file), `${file} is in package files`);
    const limit = file.endsWith(".gif") ? 5 * 1024 * 1024 : 250 * 1024;
    assert.ok(statSync(new URL(file, root)).size <= limit, `${file} is within ${limit} bytes`);
  }
  const packagedMedia = pkg.files.filter((file) => file.startsWith("docs/"));
  assert.deepEqual(packagedMedia.sort(), [...manifest.media].sort(), "only the listing's media are packaged");
});

test("two messages never share item ids, so each shows its own cards", () => {
  const block = "```browser-prompt Same\n1. Open https://example.com\n```";
  const ids = (text, id) => explodeMessage(text, "complete", id).map((item) => item.id);
  assert.notDeepEqual(ids(block, "msg-1"), ids(block, "msg-2"), "same text, two message ids");
  assert.notDeepEqual(ids(`First\n\n${block}`), ids(`Second\n\n${block}`), "no message ids, different text before the block");
  // Streaming: later text does not change the ids of what is already shown.
  assert.equal(explodeMessage(`${block}\nmore`, "streaming")[0].id, explodeMessage(`${block}\nmore and more`, "streaming")[0].id);
});
