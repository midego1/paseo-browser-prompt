// Records a page as JPEG frames through Chromium's screencast (sharper than Playwright's recordVideo).
// Each frame keeps the moment it was painted, so encode.mjs plays the frames back at their real pace;
// stretches marked with cut()/resume() (navigation between scenes) are left out of the film.
// Adapted from midego1/kite's screencast.ts.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class Screencast {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.cuts = [];
    this.marks = [];
    this.session = null;
    this.cutStart = null;
    this.pending = Promise.resolve();
  }

  async start({ width, height }) {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = `frames/${String(this.frames.length).padStart(5, "0")}.jpg`;
      this.frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
      writeFileSync(path.join(this.dir, file), Buffer.from(data, "base64"));
      this.pending = this.pending.then(() => session.send("Page.screencastFrameAck", { sessionId })).catch(() => {});
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: width, maxHeight: height });
  }

  mark(label) {
    this.marks.push({ label, at: Date.now() / 1000 });
  }

  cut() {
    this.cutStart ??= Date.now() / 1000;
  }

  resume() {
    if (this.cutStart === null) return;
    this.cuts.push({ from: this.cutStart, to: Date.now() / 1000 });
    this.cutStart = null;
  }

  async stop() {
    this.resume();
    await this.pending;
    await this.session?.send("Page.stopScreencast").catch(() => {});
    writeFileSync(
      path.join(this.dir, "manifest.json"),
      JSON.stringify({ frames: this.frames, cuts: this.cuts, marks: this.marks, endedAt: Date.now() / 1000 }, null, "\t"),
    );
  }
}
