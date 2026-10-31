import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  answersOnClick,
  isComplete,
  type OwnerPrompt,
  ownerPrompts,
  type PermissionResponse,
  permissionResponse,
  questionResponse,
  selectOption,
  type Selections,
} from "../shared/owner-prompt";

type Theme = PluginHostProps["theme"];

/**
 * The run's pending questions and permission requests, read from its snapshot while the card says
 * "needs you" (again whenever the agent changes). `answer` sends the owner's choice with the SDK's
 * respondToPermission; the card calls it only from the owner's own click.
 */
export function useOwnerPrompts(agentId: string | null, needsYou: boolean, version: string | null) {
  const paseo = usePaseo();
  const [prompts, setPrompts] = useState<OwnerPrompt[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!agentId || !needsYou) {
      setPrompts([]);
      return;
    }
    let cancelled = false;
    void paseo.agents
      .ref(agentId)
      .refresh()
      .then(
        (result) => {
          if (!cancelled) setPrompts(ownerPrompts(result?.agent.pendingPermissions ?? []));
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [agentId, needsYou, version, reload, paseo]);

  async function answer(requestId: string, response: PermissionResponse) {
    if (!agentId) return;
    try {
      await paseo.agents.ref(agentId).respondToPermission({ requestId, response });
      setPrompts((current) => current.filter((prompt) => prompt.requestId !== requestId));
    } finally {
      setReload((value) => value + 1);
    }
  }
  return { prompts, answer };
}

function Chip({
  label,
  description,
  selected,
  disabled,
  theme,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  theme: Theme;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={description ? `${label}: ${description}` : label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        maxWidth: 320,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      {description ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{description}</Text> : null}
    </Pressable>
  );
}

function Button({
  label,
  primary,
  disabled,
  theme,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  theme: Theme;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface1,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function QuestionPrompt({
  prompt,
  theme,
  busy,
  onAnswer,
  onOpen,
}: {
  prompt: Extract<OwnerPrompt, { kind: "question" }>;
  theme: Theme;
  busy: boolean;
  onAnswer: (response: PermissionResponse) => void;
  onOpen: () => void;
}) {
  const [selections, setSelections] = useState<Selections>({});
  const immediate = answersOnClick(prompt);
  const allowOther = prompt.questions.some((question) => question.allowOther || question.options.length === 0);
  return (
    <View style={{ gap: 10 }}>
      {prompt.questions.map((question, index) => (
        <View key={`${prompt.requestId}:${index}`} style={{ gap: 6 }}>
          {question.header ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{question.header}</Text>
          ) : null}
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
            {question.text}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {question.options.map((option) => (
              <Chip
                key={option.label}
                label={option.label}
                description={option.description}
                selected={(selections[index] ?? []).includes(option.label)}
                disabled={busy}
                theme={theme}
                onPress={() => {
                  const next = selectOption(prompt, selections, index, option.label);
                  setSelections(next);
                  if (immediate) {
                    const response = questionResponse(prompt, next);
                    if (response) onAnswer(response);
                  }
                }}
              />
            ))}
          </View>
        </View>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {!immediate ? (
          <Button
            label="Send answer"
            primary
            disabled={busy || !isComplete(prompt, selections)}
            theme={theme}
            onPress={() => {
              const response = questionResponse(prompt, selections);
              if (response) onAnswer(response);
            }}
          />
        ) : null}
        <Button label={allowOther ? "Other answer: open run" : "Open run"} theme={theme} onPress={onOpen} />
      </View>
    </View>
  );
}

function PermissionPrompt({
  prompt,
  theme,
  busy,
  onAnswer,
  onOpen,
}: {
  prompt: Extract<OwnerPrompt, { kind: "permission" }>;
  theme: Theme;
  busy: boolean;
  onAnswer: (response: PermissionResponse) => void;
  onOpen: () => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{prompt.title}</Text>
      {prompt.description ? (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          {prompt.description}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {prompt.actions.map((action) => (
          <Button
            key={`${action.id ?? action.behavior}:${action.label}`}
            label={action.label}
            primary={action.behavior === "allow"}
            disabled={busy}
            theme={theme}
            onPress={() => onAnswer(permissionResponse(action))}
          />
        ))}
        <Button label="Open run" theme={theme} onPress={onOpen} />
      </View>
    </View>
  );
}

/**
 * "The agent needs you" on the card, in the theme's warning color, with the run's pending question
 * or permission and buttons to answer it right here. Only the owner's click answers; nothing is
 * sent to the chat.
 */
export function OwnerPromptBox({
  prompts,
  theme,
  onAnswer,
  onOpen,
}: {
  prompts: OwnerPrompt[];
  theme: Theme;
  onAnswer: (requestId: string, response: PermissionResponse) => Promise<void>;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (requestId: string, response: PermissionResponse) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAnswer(requestId, response);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderWidth: 1.5,
        borderColor: theme.colors.statusWarning,
        borderRadius: 10,
        padding: 12,
        gap: 10,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="CircleAlert" size={16} color={theme.colors.statusWarning} />
        <Text style={{ color: theme.colors.statusWarning, fontSize: 14, fontWeight: "700" }}>The agent needs you</Text>
      </View>
      {prompts.length === 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>It is waiting for your answer in the run.</Text>
          <Button label="Answer in run" primary theme={theme} onPress={onOpen} />
        </View>
      ) : null}
      {prompts.map((prompt) =>
        prompt.kind === "question" ? (
          <QuestionPrompt
            key={prompt.requestId}
            prompt={prompt}
            theme={theme}
            busy={busy}
            onAnswer={(response) => void run(prompt.requestId, response)}
            onOpen={onOpen}
          />
        ) : (
          <PermissionPrompt
            key={prompt.requestId}
            prompt={prompt}
            theme={theme}
            busy={busy}
            onAnswer={(response) => void run(prompt.requestId, response)}
            onOpen={onOpen}
          />
        ),
      )}
    </View>
  );
}
