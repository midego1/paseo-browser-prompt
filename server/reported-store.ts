import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportedStore } from "./report-back.ts";
import { stateDir } from "./state-dir.ts";

/**
 * Run ids that already reported, in a small JSON file in the plugin's state directory. The server
 * cannot write host settings (its settings handle is read-only), so this keeps "once per run" across
 * plugin reloads and daemon restarts. Holds agent ids only.
 */
export function fileReportedStore(dir = stateDir()): ReportedStore {
  const path = join(dir, "reported-runs.json");
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      } catch {
        return [];
      }
    },
    async save(ids) {
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(ids)}\n`);
      await rename(tmp, path);
    },
  };
}
