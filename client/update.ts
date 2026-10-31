import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback } from "react";
import { checkForUpdate, updateSettings } from "../shared/update";

export const UPDATED_TOAST = "Browser prompts updated — reload Paseo to use the new version";

let checkedThisSession = false;
let toastShown = false;

/**
 * Self-update on use. Returns a trigger the card calls on first render in a session and on
 * Start, Copy and Run. The daemon throttles remote checks to one per 30 minutes; failures stay
 * silent here and show up in the settings screen and plugin log.
 */
export function useUpdateOnUse(): { onUse(): void; onFirstRender(): void } {
  const check = useRpc(checkForUpdate);
  const settings = useSettings(updateSettings);
  const toast = useToast();
  const enabled = settings.status === "ready" ? settings.values.autoUpdate : null;

  const onUse = useCallback(() => {
    // Wait for the toggle to load; an explicit "off" means no automatic checks at all.
    if (enabled !== true) return;
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
    if (checkedThisSession || enabled !== true) return;
    checkedThisSession = true;
    onUse();
  }, [enabled, onUse]);

  return { onUse, onFirstRender };
}
