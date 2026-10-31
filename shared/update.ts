import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_UPDATE_STATE } from "./updater";

/**
 * Owner choices for self-update, kept apart from `preferences`. The daemon can only read host
 * settings, so the check state (last check, revisions, result) lives in a state file on the daemon
 * and reaches the settings screen through `update.status`.
 */
export const updateSettings = defineSettings({
  id: "updates",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Check for a newer commit when the plugin is used, and install it. */
    autoUpdate: z.boolean().default(DEFAULT_UPDATE_STATE.autoUpdate),
    /** Branch to follow instead of the inferred one; empty = infer from the install. */
    trackRefOverride: z.string().default(DEFAULT_UPDATE_STATE.trackRefOverride),
  }),
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
  output: updateInfo.extend({ lastResult: z.string() }),
});

export const checkForUpdate = defineRpc({
  name: "update.check",
  input: z.object({
    /** Bypass the 30-minute throttle ("Check now"). */
    force: z.boolean().default(false),
  }),
  output: updateInfo.extend({
    status: z.enum([
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
