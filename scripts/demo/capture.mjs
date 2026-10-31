// Records the README tour (docs/assets/browser-prompt-tour.mp4 and .gif) with Playwright against an
// isolated, throwaway Paseo daemon started by record.sh. Run record.sh, not this file directly.
//
// The scenes are the real Paseo app (its bundled web UI) with the real browser-prompt plugin. The
// agent outputs are stand-ins: the chat and the browser run use the demo-only "claude-demo"
// provider in stand-in-model/, which answers with fixed text and makes no model calls. The browser
// run does not drive a real browser (a headless web UI has no Paseo browser host); its step lines,
// tool rows, question and report are scripted. Everything the plugin does with them (the card's
// progress, forwarding the question, delivering the answer, reporting back) is real.
import { chromium } from "playwright";
import { OVERLAY_SCRIPT } from "./overlay.mjs";
import { Screencast } from "./screencast.mjs";

const BASE = "http://127.0.0.1:6767";
const VIEWPORT = { width: 1280, height: 800 };
const OUT = process.env.DEMO_OUT ?? "out/demo";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light" });
await context.addInitScript(OVERLAY_SCRIPT);
const page = await context.newPage();
page.setDefaultTimeout(45_000);

const pause = (ms) => page.waitForTimeout(ms);
const caption = (text) => page.evaluate((value) => window.__demoCaption?.(value), text);
async function pointTo(locator, { click = false, steps = 28 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  if (click) {
    await pause(180);
    await page.mouse.down();
    await pause(90);
    await page.mouse.up();
  }
}
const smoothScroll = (locator, block = "center") =>
  locator.evaluate((element, where) => element.scrollIntoView({ behavior: "smooth", block: where }), block);

// ---- set up (not filmed) ----
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /settings/i }).last().click().catch(() => page.mouse.click(297, 780));
await page.getByText("Plugins", { exact: true }).first().click();
await page.waitForURL(/\/settings\/hosts\/[^/]+\/plugins$/);
const settingsUrl = `${page.url()}/browser-prompt/preferences`;
const hostId = /\/settings\/hosts\/([^/]+)\//.exec(settingsUrl)[1];
const workspaceUrl = `${BASE}/h/${hostId}/workspace/${process.env.DEMO_WORKSPACE_ID}`;
await page.goto(settingsUrl, { waitUntil: "networkidle" });
const setSwitch = async (name, on) => {
  const control = page.getByRole("switch", { name });
  if ((await control.getAttribute("aria-checked")) !== String(on)) {
    await control.click();
    await pause(700);
  }
};
// A headless web UI has no Paseo browser host, so there is nothing to screenshot.
await setSwitch("Show live screenshot", false);
await setSwitch("Auto-update on use", false);
await page.getByRole("textbox", { name: "Provider" }).fill("claude-demo");
await page.getByRole("textbox", { name: "Model" }).fill("stand-in");
await page
  .getByText("Save agent provider, model and mode")
  .locator("xpath=ancestor::*[.//*[text()='Save']][1]")
  .getByText("Save", { exact: true })
  .click();
await pause(1200);

await page.goto(workspaceUrl, { waitUntil: "networkidle" });
const card = page.getByText("Check the example.com heading", { exact: true }).first();
await card.waitFor();
// Close the "Set up worktree scripts" tip so it does not cover the sidebar.
await page
  .getByText("Set up worktree scripts")
  .locator("xpath=ancestor::*[.//*[@role='button']][1]")
  .getByRole("button")
  .first()
  .click()
  .catch(() => {});
await page.mouse.move(900, 640);
await pause(1500);

// ---- film ----
const film = new Screencast(page, OUT);
await film.start(VIEWPORT);
try {
  film.mark("card");
  await caption("Agents write browser steps as a card");
  await pause(900);
  await pointTo(page.getByText("Read the main heading.").last(), { steps: 40 });
  await pause(2600);

  film.mark("run");
  await caption("Run them with a Paseo agent, in the background");
  await pause(700);
  await pointTo(page.getByRole("button", { name: /Run .* with a Paseo agent/ }), { click: true });
  await page.getByRole("button", { name: "Start the Paseo agent" }).waitFor();
  await pause(1600);
  await pointTo(page.getByRole("button", { name: "Start the Paseo agent" }), { click: true });
  await page.getByText(/Step 1 of 4/).waitFor();
  await page.mouse.move(1150, 640, { steps: 20 });

  film.mark("progress");
  await caption("Live step progress on the card");
  await page.getByText(/asking the chat/).waitFor();

  film.mark("question");
  await caption("The browser agent can ask the chat");
  const question = page.getByText(/asks this chat a question/).first();
  await question.waitFor();
  await pause(900);
  await smoothScroll(question, "start");
  await page.getByText(/\[browser-prompt answer\]/).first().waitFor();
  await pause(1800);
  await smoothScroll(page.getByText(/Step \d of 4/).first(), "center");
  await pause(2200);

  film.mark("report");
  const report = page.getByText(/finished\. Run agent id/).first();
  await report.waitFor();
  await caption("Results come back to the chat");
  await smoothScroll(report, "start");
  await page.getByText(/^Thanks! The heading/).first().waitFor();
  await pause(2200);
  await smoothScroll(page.getByText(/Step 4 of 4/).first(), "center");
  await page.getByText(/done ✓/).first().waitFor();
  await pause(2400);

  film.mark("settings");
  film.cut();
  await caption("");
  await page.goto(settingsUrl, { waitUntil: "networkidle" });
  // Show the plugin's own defaults, not the stand-in provider this recording's run used.
  await page
    .getByText("Reset agent settings to default")
    .locator("xpath=ancestor::*[.//*[text()='Reset']][1]")
    .getByText("Reset", { exact: true })
    .click();
  await pause(1000);
  const section = page.getByText("Run with Paseo agent", { exact: true }).first();
  await section.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.mouse.move(1180, 420);
  await pause(600);
  film.resume();
  await caption("Everything is configurable");
  await pause(1600);
  for (const name of ["Talk to the chat", "Report back to chat", "Provider", "Permission mode"]) {
    await smoothScroll(page.getByText(name, { exact: true }).first(), "center");
    await pause(1300);
  }
  await pause(1200);
} finally {
  await film.stop();
  await browser.close();
}
