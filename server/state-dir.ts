import { homedir } from "node:os";
import { join } from "node:path";

/** Plugin state lives outside the install directory, which an update replaces. */
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "paseo-plugin-browser-prompt");
}
