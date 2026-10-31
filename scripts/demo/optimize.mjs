// Turns the raw captures from stills.mjs into docs/screenshots/*.png: palette-reduced with pngquant,
// recompressed with optipng, all metadata chunks stripped, each at most MAX_BYTES. Writes a metadata
// dump (out/stills-metadata.txt) to check that nothing but the image itself is left.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const RAW = "out/stills-raw";
const OUT = "out/stills";
const MAX_BYTES = 250 * 1024;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !(command === "pngquant" && result.status === 99)) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return result;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dump = [];
for (const name of readdirSync(RAW).filter((file) => file.endsWith(".png")).sort()) {
  const target = path.join(OUT, name);
  // Fewer colors until it fits; UI screenshots keep their look with a 256-color palette.
  for (const colors of [256, 192, 128]) {
    run("pngquant", ["--force", "--strip", "--speed", "1", "--quality", "65-95", String(colors), "--output", target, path.join(RAW, name)]);
    run("optipng", ["-quiet", "-o2", "-strip", "all", target]);
    if (statSync(target).size <= MAX_BYTES) break;
  }
  const size = statSync(target).size;
  if (size > MAX_BYTES) throw new Error(`${name} is ${Math.round(size / 1024)} KB, over ${MAX_BYTES / 1024} KB`);
  const meta = run("exiftool", ["-s", "-a", "-G1", "-PNG:all", "-XMP:all", "-EXIF:all", target]).stdout.trim();
  dump.push(`${name} ${Math.round(size / 1024)} KB${meta ? `\n${meta}` : ""}`);
  console.log(`  ${name}: ${Math.round(size / 1024)} KB`);
}
writeFileSync("out/stills-metadata.txt", `${dump.join("\n")}\n`);
