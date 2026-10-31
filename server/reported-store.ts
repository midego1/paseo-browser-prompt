import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportedStore } from "./report-back.ts";
import { stateDir } from "./state-dir.ts";

/**
 * Run ids that already reported, in a small JSON file in the plugin's state directory. The server
 * cannot write host settings (its settings handle is read-only), so this keeps "once per run" across
 * plugin reloads and daemon restarts. Holds agent ids only; the file is private to the daemon user.
 */
export function fileReportedStore(
  dir = stateDir(),
  log: (message: string) => void = (message) => console.log(`[browser-prompt] ${message}`),
): ReportedStore {
  const path = join(dir, "reported-runs.json");
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") log("reported-runs.json could not be read; starting empty");
        return [];
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("not a list");
        const ids = parsed.filter((id): id is string => typeof id === "string");
        if (ids.length !== parsed.length) log(`reported-runs.json had ${parsed.length - ids.length} invalid entries; ignored`);
        return ids;
      } catch {
        log("reported-runs.json is corrupt; starting empty");
        return [];
      }
    },
    async save(ids) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(ids)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
  };
}
