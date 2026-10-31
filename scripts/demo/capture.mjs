// Records the README tour (docs/assets/browser-prompt-tour.mp4, -x.mp4 and .gif) with Playwright
// against an isolated, throwaway Paseo daemon started by record.sh. Run record.sh, not this file.
//
// The scenes are the real Paseo app (its bundled web UI) with the real browser-prompt plugin. The
// agent outputs are stand-ins: the chat and the browser run use the demo-only "claude-demo"
// provider in stand-in-model/, which answers with fixed text and makes no model calls. The browser
// run does not drive a real browser (a headless web UI has no Paseo browser host); its step lines,
// tool rows, question, owner requests and report are scripted, and its screenshots are stand-ins
// (real example.com and iana.org pages rendered by the recorder's own Chromium, see stand-ins.mjs).
// Everything the plugin does with them (the card's progress and thumbnails, forwarding the question,
// delivering the answer, the owner's answers on the card, reporting back) is real.
import { Screencast } from "./screencast.mjs";
import { openDefaultSettings, openDemo } from "./setup.mjs";

const VIEWPORT = { width: 1280, height: 800 };
const OUT = process.env.DEMO_OUT ?? "out/demo";

const { browser, page, pause, settingsUrl } = await openDemo({ viewport: VIEWPORT });
const caption = (text) => page.evaluate((value) => window.__demoCaption?.(value), text);
/** Brings an element on screen if the chat moved it away (the chat follows new content to the bottom). */
async function ensureVisible(locator) {
  const box = await locator.boundingBox();
  if (box && box.y >= 60 && box.y + box.height <= VIEWPORT.height - 150) return;
  await locator.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await pause(300);
}
async function pointTo(locator, { click = false, steps = 28 } = {}) {
  await ensureVisible(locator);
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
async function smoothScroll(locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ behavior: "smooth", block: where }), block);
  await pause(700);
  // Once more if the chat jumped back to its bottom meanwhile.
  await locator.evaluate((element, where) => element.scrollIntoView({ behavior: "smooth", block: where }), block);
}
const statusLine = () => page.getByText(/^Step \d of 4/).first();
/**
 * Camera work, not app behavior: while on, keeps the card's "Step N of 4" line at the top of the
 * chat. The chat follows its bottom whenever the card changes height (a box appears or goes), which
 * would otherwise jump away from the card mid-scene.
 */
async function pinCard(on) {
  await page.evaluate((enable) => {
    clearInterval(window.__demoPin);
    if (!enable) return;
    const find = () =>
      document.evaluate(
        "(//*[starts-with(normalize-space(text()), 'Step ') and contains(text(), ' of 4')])[1]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
    window.__demoPin = setInterval(() => {
      const line = find();
      if (!line) return;
      const top = line.getBoundingClientRect().top;
      if (top < 50 || top > 140) line.scrollIntoView({ block: "start" });
    }, 80);
  }, on);
}

// ---- film ----
const film = new Screencast(page, OUT);
await film.start(VIEWPORT);
try {
  film.mark("card");
  await caption("Agents write browser steps as a card");
  await pause(900);
  await pointTo(page.getByText("Read the first paragraph.").last(), { steps: 40 });
  await pause(1800);

  film.mark("run");
  await caption("Run them with a Paseo agent, in the background");
  await pause(600);
  await pointTo(page.getByRole("button", { name: /Run .* with a Paseo agent/ }), { click: true });
  await page.getByRole("button", { name: "Start the Paseo agent" }).waitFor();
  await pause(1300);
  await pointTo(page.getByRole("button", { name: "Start the Paseo agent" }), { click: true });
  await page.getByText(/Step 1 of 4/).waitFor();
  await page.mouse.move(1150, 600, { steps: 20 });

  film.mark("progress");
  await caption("Live step progress, with a screenshot per step");
  await smoothScroll(statusLine(), "start");
  await page.getByText("Step 2", { exact: true }).first().waitFor();
  await pause(600);
  await smoothScroll(statusLine(), "start");
  await page.getByText(/asking the chat/).waitFor();

  film.mark("question");
  await caption("The browser agent can ask the chat");
  const question = page.getByText(/asks this chat a question/).first();
  await question.waitFor();
  await pause(600);
  await smoothScroll(question, "start");
  await page.getByText(/^\[browser-prompt answer\]/).first().waitFor();
  await pause(1500);

  film.mark("thumbnails");
  await caption("A screenshot for every step");
  await page.getByText("Step 3", { exact: true }).first().waitFor();
  await smoothScroll(statusLine(), "start");
  await pinCard(true);
  await pause(1700);

  film.mark("owner-question");
  const option = page.getByText("Yes, check it").first();
  await option.waitFor();
  await caption("…or ask you, right on the card");
  await smoothScroll(statusLine(), "start");
  await pause(1400);
  await pointTo(option, { click: true });
  await pause(900);
  await pointTo(page.getByText("Send answer").first(), { click: true });

  film.mark("permission");
  const url = page.getByText("https://www.iana.org/domains/reserved").first();
  await url.waitFor();
  await caption("Permissions show what they would allow");
  await smoothScroll(statusLine(), "start");
  await pause(600);
  await pointTo(url, { steps: 30 });
  await pause(1200);
  await pointTo(page.getByText("Allow", { exact: true }).first(), { click: true });
  const confirm = page.getByText(/^Confirm allow/).first();
  await confirm.waitFor();
  // The box changed height, and the chat may have followed its bottom: back to the card.
  await smoothScroll(statusLine(), "start");
  await pause(900);
  await pointTo(confirm, { click: true });
  await pinCard(false);

  film.mark("report");
  const report = page.getByText(/finished\. Run agent id/).first();
  await report.waitFor();
  await caption("Results come back to the chat");
  await page.mouse.move(1150, 600, { steps: 20 });
  await smoothScroll(report, "start");
  await page.getByText(/^Thanks!/).first().waitFor();
  await pause(1100);
  await smoothScroll(statusLine(), "start");
  await page.getByText(/done ✓/).first().waitFor();
  await pause(1600);

  film.mark("settings");
  film.cut();
  await caption("");
  // Show the plugin's own defaults, not the stand-in provider this recording's run used.
  await openDefaultSettings(page, settingsUrl);
  const section = page.getByText("Run with Paseo agent", { exact: true }).first();
  await section.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.mouse.move(1180, 420);
  await pause(600);
  film.resume();
  await caption("Everything is configurable");
  await pause(1100);
  for (const name of ["Thumbnails", "Talk to the chat", "Report back to chat", "Permission mode"]) {
    await smoothScroll(page.getByText(name, { exact: true }).first(), "center");
    await pause(900);
  }
  await pause(300);
} finally {
  await film.stop();
  await browser.close();
}
