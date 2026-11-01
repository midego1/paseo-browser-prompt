import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback } from "react";
import { checkForUpdate, updateSettings } from "../shared/update";

export const UPDATED_TOAST = "Browser prompts updated — reload Paseo to use the new version";

let checkedThisSession = false;
let toastShown = false;

/**
 * Self-update on use, only after the owner enabled it in settings. Returns a trigger the card calls
 * on first render in a session and on Start, Copy and Run. Without consent (the default, or settings
 * still loading or unreadable) it does nothing at all; the daemon checks the consent's remote again
 * before contacting anything, throttles checks to one per 30 minutes, and keeps failures for the
 * settings screen and plugin log.
 */
export function useUpdateOnUse(): { onUse(): void; onFirstRender(): void } {
  const check = useRpc(checkForUpdate);
  const settings = useSettings(updateSettings);
  const toast = useToast();
  const enabled = settings.status === "ready" && settings.values.autoUpdate === true && settings.values.consentRemote !== "";

  const onUse = useCallback(() => {
    // No consent (or not loaded): no automatic check at all.
    if (!enabled) return;
    check({ force: false })
      .then((result) => {
        if (result.applied && !toastShown) {
          toastShown = true;
          toast.show(UPDATED_TOAST, { variant: "success", durationMs: 8000 });
        }
      })
      .catch(() => undefined);
  }, [check, enabled, toast]);

  const onFirstRender = useCallback(() => {
    if (checkedThisSession || !enabled) return;
    checkedThisSession = true;
    onUse();
  }, [enabled, onUse]);

  return { onUse, onFirstRender };
}
