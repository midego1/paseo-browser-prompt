// Turns the frames capture.mjs recorded into docs/assets/browser-prompt-tour.mp4 (H.264) and .gif,
// with all container and encoder metadata stripped. Adapted from midego1/kite's encode-demo.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = process.env.DEMO_OUT ?? "out/demo";
const MP4 = process.env.DEMO_MP4 ?? "out/browser-prompt-tour.mp4";
const GIF = process.env.DEMO_GIF ?? "out/browser-prompt-tour.gif";
const GIF_WIDTH = Number(process.env.DEMO_GIF_WIDTH ?? 960);
const GIF_FPS = Number(process.env.DEMO_GIF_FPS ?? 12);
const MAX_GIF_BYTES = 10 * 1024 * 1024;
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
ffmpeg([
  "-vf",
  `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  "-loop",
  "0",
  ...STRIP,
  GIF,
]);
console.log(`${GIF}: ${size(GIF)}`);
if (statSync(GIF).size > MAX_GIF_BYTES) throw new Error("The GIF is over 10 MB; lower DEMO_GIF_FPS or DEMO_GIF_WIDTH.");
