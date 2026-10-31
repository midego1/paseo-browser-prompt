// Captures the README screenshots (docs/screenshots/) from the real Paseo app with the real plugin,
// against the isolated demo daemon record.sh --stills starts. Run record.sh --stills, not this file.
//
// As in the tour, the agent text is a stand-in (stand-in-model/) and the run's screenshots are
// stand-ins (real example.com and iana.org pages rendered by the recorder's own Chromium, see
// stand-ins.mjs). The run holds each state long enough to capture it. Light theme, plus one dark.
import { mkdirSync } from "node:fs";
import { openDefaultSettings, openDemo } from "./setup.mjs";

const OUT = "out/stills-raw";
const VIEWPORT = { width: 1280, height: 1600 };
const PAD = 16;
mkdirSync(OUT, { recursive: true });

const { browser, page, pause, settingsUrl } = await openDemo({ viewport: VIEWPORT, overlay: false });
const title = () => page.getByText("Check what example.com says", { exact: true }).first();
/** The card: the nearest ancestor of its title that also holds its buttons. */
const card = () => title().locator("xpath=ancestor::*[.//*[text()='Copy']][1]");

/**
 * Scrolls `scroll` (the first part) to the top, then captures the union of the parts' boxes plus
 * padding. `top` and `bottom` (locators) narrow it to start or end at an element inside the parts.
 */
async function still(name, parts, { scroll = parts[0], top, bottom, topPad = PAD, bottomPad = PAD } = {}) {
  await scroll.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await pause(700);
  const boxes = [];
  for (const part of parts) {
    const box = await part.boundingBox();
    if (!box) throw new Error(`${name}: a part is not on screen`);
    boxes.push(box);
  }
  const topBox = top ? await top.boundingBox() : null;
  const bottomBox = bottom ? await bottom.boundingBox() : null;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - PAD);
  const y = Math.max(0, (topBox ? topBox.y : Math.min(...boxes.map((b) => b.y))) - topPad);
  const right = Math.min(VIEWPORT.width, Math.max(...boxes.map((b) => b.x + b.width)) + PAD);
  const end = Math.min(VIEWPORT.height, (bottomBox ? bottomBox.y + bottomBox.height : Math.max(...boxes.map((b) => b.y + b.height))) + bottomPad);
  await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x, y, width: right - x, height: end - y } });
  console.log(`  ${name}`);
}

try {
  // 1. The card, before anything runs.
  await still("card", [card()]);

  await page.getByRole("button", { name: /Run .* with a Paseo agent/ }).click();
  await page.getByRole("button", { name: "Start the Paseo agent" }).click();

  // 3. The browser agent asks the chat; the card waits for the chat's answer.
  const question = page.getByText(/asks this chat a question/).first();
  await question.waitFor();
  await page.getByText("Waiting for the chat's answer").first().waitFor();
  const bubble = question.locator("xpath=ancestor::*[.//*[text()='Show more']][1]");
  const waiting = page.getByText("Waiting for the chat's answer").first();
  await still("asking", [card(), bubble], { scroll: waiting, top: waiting, topPad: 10 });

  // 2. Running in the background: step progress and a screenshot per step (and 7, the dark theme).
  await page.getByText("Step 3", { exact: true }).first().waitFor({ timeout: 90_000 });
  await page.getByText(/Step 3 of 4/).first().waitFor();
  await pause(1500);
  await still("running", [card()]);
  await page.emulateMedia({ colorScheme: "dark" });
  await pause(1200);
  await still("running-dark", [card()]);
  await page.emulateMedia({ colorScheme: "light" });
  await pause(800);

  // 4. The run needs its owner: a question answered on the card, then a permission with its details.
  await page.getByText("Yes, check it").first().waitFor({ timeout: 60_000 });
  await page.getByText("Yes, check it").first().click();
  await pause(500);
  await still("needs-you-question", [card()]);
  await page.getByText("Send answer").first().click();
  await page.getByText("Browser navigate").first().waitFor();
  await page.getByText("Allow", { exact: true }).first().click();
  await page.getByText(/^Confirm allow/).first().waitFor();
  await pause(500);
  await still("needs-you-permission", [card()]);
  await page.getByText(/^Confirm allow/).first().click();

  // 5. Done, and the report back in the chat.
  await page.getByText(/done ✓/).first().waitFor({ timeout: 60_000 });
  const thanks = page.getByText(/^Thanks!/).first();
  await thanks.waitFor();
  const notice = page.getByText(/finished\. Run agent id/).first().locator("xpath=ancestor::*[.//*[text()='Show more']][1]");
  await pause(1000);
  const doneLabel = page.getByText("Paseo agent done ✓").first();
  await still("done", [card(), notice, thanks], { scroll: doneLabel, top: doneLabel, topPad: 10 });

  // 6. The plugin's settings, at their defaults: the run options, then the agent's provider and mode.
  await openDefaultSettings(page, settingsUrl);
  const section = page.getByText("Run with Paseo agent", { exact: true }).first();
  const group = (label) => page.getByText(label, { exact: true }).first().locator(`xpath=ancestor::*[.//*[text()='Agent links on cards']][1]`);
  await still("settings-run", [section, group("Confirm before starting")], {
    bottom: page.getByText(/^When the agent finishes or fails/).first(),
    bottomPad: 20,
  });
  const provider = page.getByText("Provider", { exact: true }).first();
  await still("settings-agent", [group("Provider")], { scroll: provider, top: provider, topPad: 20 });
} finally {
  await browser.close();
}
