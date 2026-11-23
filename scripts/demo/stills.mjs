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

const { browser, page, pause, settingsUrl, workspacePage } = await openDemo({ viewport: VIEWPORT, overlay: false });
const title = () => page.getByText("Check what example.com says", { exact: true }).first();
/** The card: the nearest ancestor of its title that also holds its quiet row (Copy steps, in every state). */
const card = () => title().locator("xpath=ancestor::*[.//*[text()='Copy steps']][1]");

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

  // The Run split button's chevron: Run once in… with every browser; Change the default… at its end.
  await page.getByRole("button", { name: "Run once in another browser" }).click();
  const menuItem = page.getByRole("menuitem", { name: /Run .* in the Paseo browser/ });
  await menuItem.waitFor();
  await pause(500);
  // The open menu: its header, rows and Change the default….
  const sheet = [page.getByText("Run once in…", { exact: true }).first(), page.getByText("Change the default…", { exact: true }).first(), ...(await page.getByRole("menuitem").all())];
  const real = (await Promise.all(sheet.map((item) => item.boundingBox()))).filter(Boolean);
  const left = Math.max(0, Math.min(...real.map((b) => b.x)) - 40);
  const top = Math.max(0, Math.min(...real.map((b) => b.y)) - 28);
  const right = Math.min(VIEWPORT.width, Math.max(...real.map((b) => b.x + b.width)) + 40);
  const bottom = Math.min(VIEWPORT.height, Math.max(...real.map((b) => b.y + b.height)) + 28);
  await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4);
  await page.screenshot({ path: `${OUT}/run-once.png`, clip: { x: left, y: top, width: right - left, height: bottom - top } });
  await menuItem.click();
  await page.getByRole("button", { name: "Start the Paseo agent" }).click();

  // 3. The browser agent asks the chat; the card waits for the chat's answer.
  const question = page.getByText(/asks this chat a question/).first();
  await question.waitFor();
  await page.getByText("Waiting for the chat's answer").first().waitFor();
  const bubble = question.locator("xpath=ancestor::*[.//*[text()='Show more']][1]");
  const waiting = page.getByText("Waiting for the chat's answer").first();
  await still("asking", [card(), bubble]);

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
  const doneLabel = card().getByText("Done", { exact: true });
  await doneLabel.waitFor({ timeout: 60_000 });
  const thanks = page.getByText(/^Thanks!/).first();
  await thanks.waitFor();
  const notice = page.getByText(/finished\. Run agent id/).first().locator("xpath=ancestor::*[.//*[text()='Show more']][1]");
  await pause(1000);
  await still("done", [card(), notice, thanks]);

  // 6. Repeated blocks: the same steps three times in another chat. Done on the first card; the
  // second copy opened with Show (full card, "Also shown earlier in this chat"), the third collapsed.
  if (process.env.DEMO_REPEAT_WORKSPACE_ID) {
    await page.goto(workspacePage(process.env.DEMO_REPEAT_WORKSPACE_ID), { waitUntil: "networkidle" });
    await page.getByText("Also shown earlier in this chat").nth(1).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: /^Mark .* done$/ }).first().click();
    await page.getByText("Already done", { exact: true }).nth(1).waitFor();
    await page.getByText("Show", { exact: true }).first().click();
    const hint = page.getByText("Also shown earlier in this chat").first();
    await hint.waitFor();
    const copy = hint.locator("xpath=ancestor::*[.//*[text()='Copy steps']][1]");
    const collapsed = page.getByText("Already done", { exact: true }).first().locator("xpath=ancestor::*[.//*[text()='Show']][1]");
    await still("repeat-done", [copy, collapsed]);
  }

  // 7. The plugin's settings, at their defaults (Advanced open): Run and Send to at the top, then
  // the Card and Run details groups and the agent's provider and mode under Advanced.
  await openDefaultSettings(page, settingsUrl);
  const group = (label) => page.getByText(label, { exact: true }).first().locator(`xpath=ancestor::*[.//*[text()='Agent links on cards']][1]`);
  /** The settings card (full width) that holds `label`'s row and `other`'s. */
  const settingsCard = (label, other) => page.getByText(label, { exact: true }).first().locator(`xpath=ancestor::*[.//*[text()='${other}']][1]`);
  const runTitle = page.getByText("Run", { exact: true }).first();
  await still("settings-run", [runTitle, settingsCard("Report back to chat", "The Run button uses"), settingsCard("Claude", "ChatGPT")], {
    bottom: page.getByText(/^Where .Send to Claude. opens/).first(),
    bottomPad: 40,
  });
  const agentTitle = page.getByText("Agent", { exact: true }).first();
  await still("settings-agent", [agentTitle, group("Provider")], { scroll: agentTitle });
  const cardTitle = page.getByText("Card", { exact: true }).first();
  await still("settings-general", [cardTitle, settingsCard("Done marks", "Collapse repeated blocks that are done"), settingsCard("Show live screenshot", "Open the agent when started")], {
    bottom: page.getByText(/^The agent takes a screenshot of the visible page/).first(),
    bottomPad: 20,
  });
  // A Git install (record.sh with DEMO_PLUGIN_GIT) shows its repository and the consent text.
  const updates = page.getByText("Updates", { exact: true }).last();
  const updatesGroup = page.getByText("Follow branch", { exact: true }).first().locator("xpath=ancestor::*[.//*[text()='Save branch']][1]");
  await still("settings-updates", [updates, updatesGroup], { scroll: updates });
} catch (error) {
  // For debugging a failed run: the page as it was (not copied to docs/screenshots).
  await page.screenshot({ path: "out/error.png" }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
