import type { PluginHostProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import * as hostUi from "@getpaseo/plugin/client/ui";
import { type ComponentType, useState } from "react";
import { type LayoutChangeEvent, Pressable, Text, View } from "react-native";
import {
  screenshotMarkdown,
  type StepScreenshot,
  THUMB_GAP,
  thumbnailFrame,
  thumbnailLayout,
  type ThumbnailMode,
} from "../shared/screenshot";

// Paseo 0.13+ ships a host Markdown component, the same renderer Paseo uses for the image messages
// in an agent's own chat. Older hosts have none, and no other plugin API shows a daemon-side image,
// so there the thumbnails are simply not shown.
const HostMarkdown = (hostUi as unknown as { Markdown?: ComponentType<{ children: string }> }).Markdown;

type Theme = PluginHostProps["theme"];

function Thumbnail({
  shot,
  size,
  latest,
  theme,
  onOpen,
}: {
  shot: StepScreenshot;
  size: number;
  latest: boolean;
  theme: Theme;
  onOpen: () => void;
}) {
  const [measured, setMeasured] = useState<number | null>(null);
  if (!HostMarkdown) return null;
  const label = shot.step ? `Step ${shot.step}` : "Screenshot";
  const border = latest ? 2 : 1;
  // A window onto the host's tall image box, so the screenshot fills the tile (see thumbnailFrame).
  const frame = thumbnailFrame(size - 2 * border, measured);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={shot.step ? `Screenshot after step ${shot.step}` : "Latest browser screenshot"}
      accessibilityHint="Opens the Paseo agent"
      onPress={onOpen}
      style={{ width: size, gap: 4 }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: latest ? theme.colors.accent : theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: latest ? "600" : "400",
        }}
      >
        {label}
      </Text>
      <View
        pointerEvents="none"
        style={{
          width: size,
          ...(frame ? { height: frame.height + 2 * border } : {}),
          borderRadius: 8,
          borderWidth: border,
          borderColor: latest ? theme.colors.accent : theme.colors.border,
          overflow: "hidden",
        }}
      >
        <View
          onLayout={(event: LayoutChangeEvent) => setMeasured(Math.round(event.nativeEvent.layout.height))}
          style={frame ? { marginTop: -frame.offset } : undefined}
        >
          <HostMarkdown>{screenshotMarkdown(shot.source, shot.step || undefined)}</HostMarkdown>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The run's screenshots under the progress bar: one per step with its step number, the latest
 * highlighted. The card's width (onLayout) picks the layout (see `thumbnailLayout`): a row when all
 * fit, a horizontal scroll strip when only some do, the latest alone when narrow or when the
 * setting asks for it. Pressing a thumbnail opens the run.
 */
export function ScreenshotStrip({
  shots,
  latestStep,
  mode,
  theme,
  onOpen,
}: {
  shots: StepScreenshot[];
  latestStep: number | null;
  mode: ThumbnailMode;
  theme: Theme;
  onOpen: () => void;
}) {
  const [width, setWidth] = useState(0);
  if (!HostMarkdown || shots.length === 0) return null;
  const onLayout = (event: LayoutChangeEvent) => setWidth(Math.floor(event.nativeEvent.layout.width));
  const layout = thumbnailLayout(width, shots.length, mode);
  const latest = shots.find((shot) => shot.step === latestStep) ?? shots[shots.length - 1]!;

  if (layout.kind === "latest") {
    return (
      <View onLayout={onLayout} style={{ alignSelf: "stretch" }}>
        {width > 0 ? <Thumbnail shot={latest} size={layout.size} latest theme={theme} onOpen={onOpen} /> : null}
      </View>
    );
  }
  const items = shots.map((shot) => (
    <Thumbnail key={shot.step} shot={shot} size={layout.size} latest={shot === latest} theme={theme} onOpen={onOpen} />
  ));
  if (layout.kind === "row") {
    return (
      <View onLayout={onLayout} style={{ alignSelf: "stretch", flexDirection: "row", gap: THUMB_GAP }}>
        {items}
      </View>
    );
  }
  return (
    <View onLayout={onLayout} style={{ alignSelf: "stretch" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: THUMB_GAP, paddingBottom: 4 }}>
        {items}
      </ScrollView>
    </View>
  );
}
