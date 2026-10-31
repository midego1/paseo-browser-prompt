// Shared by capture.mjs and stills.mjs: opens the demo app in Playwright's Chromium, points the
// plugin at the stand-in model and opens the demo chat. Not filmed.
import { chromium } from "playwright";
import { OVERLAY_SCRIPT } from "./overlay.mjs";

export const BASE = "http://127.0.0.1:6767";

export async function openDemo({ viewport, overlay = true }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "light" });
  if (overlay) await context.addInitScript(OVERLAY_SCRIPT);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pause = (ms) => page.waitForTimeout(ms);

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
  await setSwitch("Show live screenshot", true);
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
  await page.getByText("Check what example.com says", { exact: true }).first().waitFor();
  // Close the "Set up worktree scripts" tip so it does not cover the sidebar.
  await page
    .getByText("Set up worktree scripts")
    .locator("xpath=ancestor::*[.//*[@role='button']][1]")
    .getByRole("button")
    .first()
    .click()
    .catch(() => {});
  await page.mouse.move(viewport.width - 100, viewport.height - 160);
  await pause(1500);
  return { browser, page, pause, settingsUrl };
}

/** The plugin's settings, reset to its defaults (not the stand-in provider this recording used). */
export async function openDefaultSettings(page, settingsUrl) {
  await page.goto(settingsUrl, { waitUntil: "networkidle" });
  await page
    .getByText("Reset agent settings to default")
    .locator("xpath=ancestor::*[.//*[text()='Reset']][1]")
    .getByText("Reset", { exact: true })
    .click();
  await page.waitForTimeout(1000);
}
