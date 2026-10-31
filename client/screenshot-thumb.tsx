import type { PluginHostProps } from "@getpaseo/plugin/client";
import * as hostUi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { Pressable, View } from "react-native";
import { screenshotMarkdown } from "../shared/screenshot";

// Paseo 0.13+ ships a host Markdown component, the same renderer Paseo uses for the image messages
// in an agent's own chat. Older hosts have none, and no other plugin API shows a daemon-side image,
// so there the thumbnail is simply not shown.
const HostMarkdown = (hostUi as unknown as { Markdown?: ComponentType<{ children: string }> }).Markdown;

export const THUMBNAIL_MAX_WIDTH = 240;

/** The run's latest browser screenshot, small, under the progress bar. Pressing it opens the run. */
export function ScreenshotThumb({
  source,
  step,
  theme,
  onOpen,
}: {
  source: string | null;
  step: number | null;
  theme: PluginHostProps["theme"];
  onOpen: () => void;
}) {
  if (!source || !HostMarkdown) return null;
  const label = step ? `Latest browser screenshot, step ${step}` : "Latest browser screenshot";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the Paseo agent"
      onPress={onOpen}
      style={{
        maxWidth: THUMBNAIL_MAX_WIDTH,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
        alignSelf: "flex-start",
      }}
    >
      <View pointerEvents="none" style={{ maxWidth: THUMBNAIL_MAX_WIDTH }}>
        <HostMarkdown>{screenshotMarkdown(source)}</HostMarkdown>
      </View>
    </Pressable>
  );
}
