import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_UPDATE_STATE, migrateUpdateSettings } from "./updater";

/**
 * Owner choices for self-update, kept apart from `preferences`. The daemon can only read host
 * settings, so the check state (last check, revisions, result) lives in a state file on the daemon
 * and reaches the settings screen through `update.status`.
 */
export const updateSettings = defineSettings({
  id: "updates",
  scope: "host",
  version: 2,
  schema: z.object({
    /**
     * Off until the owner enables it after being told which repository supplies the updates and that
     * newer plugin code will be downloaded and installed. Then: check for a newer commit when the
     * plugin is used, and install it.
     */
    autoUpdate: z.boolean().default(DEFAULT_UPDATE_STATE.autoUpdate),
    /** The Git remote shown when the owner enabled auto-update; a different install remote voids it. */
    consentRemote: z.string().default(DEFAULT_UPDATE_STATE.consentRemote),
    /** Branch to follow instead of the inferred one; empty = infer from the install. */
    trackRefOverride: z.string().default(DEFAULT_UPDATE_STATE.trackRefOverride),
  }),
  migrate: migrateUpdateSettings,
});

const updateInfo = z.object({
  installedRevision: z.string(),
  latestRevision: z.string(),
  trackedRef: z.string(),
  lastCheckAt: z.number(),
});

export const getUpdateStatus = defineRpc({
  name: "update.status",
  input: z.object({}),
  output: updateInfo.extend({
    lastResult: z.string(),
    /** How the plugin is installed (read locally from `paseo plugin ls`, no network). */
    installKind: z.enum(["git", "local", "other"]),
    /** The Git remote updates would come from; empty for other installs. */
    remote: z.string(),
  }),
});

export const checkForUpdate = defineRpc({
  name: "update.check",
  input: z.object({
    /** Bypass the 30-minute throttle ("Check now"). */
    force: z.boolean().default(false),
  }),
  output: updateInfo.extend({
    status: z.enum([
      "not-consented",
      "changed",
      "throttled",
      "local",
      "unsupported",
      "up-to-date",
      "update-available",
      "not-fast-forward",
      "updating",
      "busy",
      "failed",
    ]),
    applied: z.boolean(),
    message: z.string(),
  }),
});

/**
 * "Update now": installs `revision` from `remote`, both as shown to the owner, and only if the install
 * still uses that remote and the commit is still the newest fast-forward of the followed branch.
 */
export const installUpdate = defineRpc({
  name: "update.install",
  input: z.object({ remote: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{40}$/) }),
  output: checkForUpdate.output,
});
