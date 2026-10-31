// Turns the frames capture.mjs recorded into docs/assets/browser-prompt-tour.mp4 (H.264), the X cut
// browser-prompt-tour-x.mp4 (1280x720, H.264 High, yuv420p, faststart, no audio) and the README GIF,
// with all container and encoder metadata stripped. Adapted from midego1/kite's encode-demo.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = process.env.DEMO_OUT ?? "out/demo";
const MP4 = process.env.DEMO_MP4 ?? "out/browser-prompt-tour.mp4";
const X_MP4 = process.env.DEMO_X_MP4 ?? "out/browser-prompt-tour-x.mp4";
const GIF = process.env.DEMO_GIF ?? "out/browser-prompt-tour.gif";
/** GIF sizes to try, largest first, until one is at most MAX_GIF_BYTES. */
const GIF_TRIES = [
  { width: 960, fps: 12 },
  { width: 880, fps: 10 },
  { width: 800, fps: 10 },
  { width: 720, fps: 8 },
];
const MAX_GIF_BYTES = 5 * 1024 * 1024;
// X's limits for an uploaded video, with room to spare.
const MAX_X_BYTES = 15 * 1024 * 1024;
const MAX_X_SECONDS = 140;
const HOLD_END_SECONDS = 1.2;

const { frames, cuts, marks = [], endedAt } = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8"));
if (!frames.length) throw new Error("No frames were recorded.");

function onCamera(from, to) {
  let seconds = Math.max(0, to - from);
  for (const cut of cuts) seconds -= Math.max(0, Math.min(to, cut.to) - Math.max(from, cut.from));
  return seconds;
}

const lines = ["ffconcat version 1.0"];
let total = 0;
frames.forEach((frame, index) => {
  const until = index + 1 < frames.length ? frames[index + 1].at : endedAt;
  let duration = onCamera(frame.at, until);
  if (index === frames.length - 1) duration += HOLD_END_SECONDS;
  if (duration < 0.001) return;
  total += duration;
  lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
});
lines.push(lines.at(-2));
writeFileSync(path.join(DIR, "frames.ffconcat"), `${lines.join("\n")}\n`);
console.log(`${frames.length} frames, ${total.toFixed(1)} s on camera`);
for (const { label, at } of marks) console.log(`  ${onCamera(frames[0].at, at).toFixed(1).padStart(5)} s  ${label}`);

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(DIR, "frames.ffconcat"), ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg failed");
}
const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`;

// No metadata: no creation time, encoder string or handler names in the file.
const STRIP = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-metadata", "encoder="];
// filter_units removes the SEI units, where x264 writes its version and encoding settings.
ffmpeg(["-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "animation", "-movflags", "+faststart", "-an", "-bsf:v", "filter_units=remove_types=6", ...STRIP, MP4]);
console.log(`${MP4}: ${size(MP4)}`);

// X: 16:9 at 1280x720. The 16:10 recording is scaled to 720 high and centered on the app's
// background color, so nothing is cropped.
if (total > MAX_X_SECONDS) throw new Error(`The tour is ${total.toFixed(1)} s; X allows ${MAX_X_SECONDS} s.`);
ffmpeg([
  "-vf",
  "fps=30,scale=-2:720:flags=lanczos,pad=1280:720:(ow-iw)/2:0:color=0xf8f8f8,format=yuv420p",
  "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.0", "-preset", "slow", "-crf", "20", "-tune", "animation",
  "-movflags", "+faststart", "-an", "-bsf:v", "filter_units=remove_types=6", ...STRIP, X_MP4,
]);
console.log(`${X_MP4}: ${size(X_MP4)}`);
if (statSync(X_MP4).size > MAX_X_BYTES) throw new Error("The X cut is over 15 MB.");

let gifOk = false;
for (const { width, fps } of GIF_TRIES) {
  ffmpeg([
    "-vf",
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop",
    "0",
    ...STRIP,
    GIF,
  ]);
  console.log(`${GIF}: ${size(GIF)} (${width} px, ${fps} fps)`);
  if (statSync(GIF).size <= MAX_GIF_BYTES) {
    gifOk = true;
    break;
  }
}
if (!gifOk) throw new Error("The GIF is over 5 MB at every size tried.");
