// Renders the stand-in screenshots for the demo run: real example.com and iana.org pages, taken with
// the recorder's own headless Chromium (the demo has no Paseo browser host to take them). record.sh
// copies them into the demo daemon's attachment directory under their SHA-256 names, the form Paseo
// gives a tool's image, so the card shows them as it shows a real run's screenshots.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT = "stand-ins";
/** The daemon directory record.sh copies them to (inside its container). */
const DAEMON_DIR = "/tmp/paseo-attachments-demo";
const PAGES = [
  { url: "https://example.com" },
  // Step 2 reads the first paragraph: the same page with that paragraph selected.
  { url: "https://example.com", select: "p" },
  { url: "https://www.iana.org/help/example-domains" },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
const shots = [];
try {
  for (const { url, select } of PAGES) {
    await page.goto(url, { waitUntil: "networkidle" });
    if (select) await page.locator(select).first().selectText();
    const file = path.join(OUT, "shot.png");
    await page.screenshot({ path: file });
    const bytes = readFileSync(file);
    const name = `${createHash("sha256").update(bytes).digest("hex")}.png`;
    writeFileSync(path.join(OUT, name), bytes);
    rmSync(file);
    shots.push(`file://${DAEMON_DIR}/${name}`);
  }
} finally {
  await browser.close();
}
const hold = Number(process.env.DEMO_HOLD ?? 2500);
writeFileSync(path.join(OUT, "stand-ins.json"), `${JSON.stringify({ shots, hold })}\n`);
console.log(`${shots.length} stand-in screenshots`);
