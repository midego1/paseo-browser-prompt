// Builds the Server browser image by hand, with the same tag the plugin uses:
//   npm run server-browser:image
// The plugin builds it on first use too (Settings > Server browser > Build). Needs Docker on this
// host; the base image (pinned by digest) is pulled when it is not there yet.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentImageTag } from "../server/server-browser.ts";
import { CONTAINER_LABEL } from "../shared/server-browser.ts";

const tag = currentImageTag();
const context = fileURLToPath(new URL("../server-browser/", import.meta.url));
console.log(`docker build -t ${tag} ${context}`);
const result = spawnSync("docker", ["build", "--label", `${CONTAINER_LABEL}=image`, "-t", tag, context], { stdio: "inherit" });
process.exit(result.status ?? 1);
