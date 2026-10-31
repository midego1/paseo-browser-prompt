import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { consumeOpenToken } from "./agent-run";

/**
 * Hand-off screen for an agent started from a card. Timeline renderers get no navigation, so the
 * card opens this screen, which opens Paseo's own agent view once and keeps an "Open agent" button
 * for Back navigation and older hosts.
 *
 * Screens get no plugin client-state provider on Paseo 0.11, so useAgent/useWorkspace throw
 * "Plugin state hooks must run inside a workspace panel" here. Everything this screen shows comes
 * from its params; the live status lives on the card. test/screen-hooks.test.mjs guards this.
 */
export function AgentRunScreen({ params, navigation, theme, layout }: PluginScreenProps) {
  const agentId = params.agentId ?? "";
  const title = params.title || "Paseo agent";
  const openAgent = navigation?.openAgent;

  useEffect(() => {
    if (agentId && openAgent && consumeOpenToken(params.open)) openAgent({ agentId });
  }, [agentId, openAgent, params.open]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 10 : 14,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 17 : 20, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      button: {
        alignSelf: "flex-start" as const,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const, fontSize: 14 },
    }),
    [theme, layout.compact],
  );

  if (!agentId) {
    return (
      <View style={styles.screen}>
        <Text style={styles.hint}>No agent selected.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.hint}>The card shows whether the agent is running, needs your approval, or finished.</Text>
      <Text style={styles.hint}>
        The agent runs on the Paseo daemon and drives the browser tabs in your Paseo desktop app. Keep that app
        open. Tool use asks for your approval in the agent view.
      </Text>
      {openAgent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open agent ${title}`}
          onPress={() => openAgent({ agentId })}
          style={styles.button}
        >
          <Icon name="Bot" size={16} color={theme.colors.accentForeground} />
          <Text style={styles.buttonText}>Open agent</Text>
        </Pressable>
      ) : (
        <Text style={styles.hint}>Find it in the workspace's agent list (this app version cannot open it directly).</Text>
      )}
    </View>
  );
}
