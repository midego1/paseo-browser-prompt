import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  isComplete,
  type OwnerPrompt,
  ownerPrompts,
  type PermissionResponse,
  permissionResponse,
  questionResponse,
  selectOption,
  type Selections,
  type PromptAction,
  type SummaryLine,
  verifiedRun,
} from "../shared/owner-prompt";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

type Theme = PluginHostProps["theme"];

/** When the stream announced a request the snapshot does not show yet, read once more after this. */
const PENDING_RETRY_MS = 1000;

/**
 * The run's pending questions and permission requests, read from its snapshot while the run is
 * active (`watch`): when the card opens it, whenever `version` changes (its status, and each
 * permission request or resolution in the live stream), and after an answer. `pending` is the
 * snapshot's count of pending requests: how the card knows a running run needs its owner. They are
 * offered for answering only when that same snapshot shows this card's run (`verifiedRun`).
 * `answer` sends the owner's choice with the SDK's respondToPermission; the card calls it only from
 * the owner's own click.
 */
export function useOwnerPrompts(
  agentId: string | null,
  watch: boolean,
  version: string | null,
  card: { sourceAgentId: string; cardId: string },
  expectPending = false,
) {
  const paseo = usePaseo();
  const [prompts, setPrompts] = useState<OwnerPrompt[]>([]);
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!agentId || !watch) {
      setPrompts([]);
      setVerified(false);
      setPending(0);
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (again: boolean) =>
      void paseo.agents
        .ref(agentId)
        .refresh()
        .then(
          (result) => {
            if (cancelled) return;
            const requests = result?.agent.pendingPermissions ?? [];
            const ok = verifiedRun(result?.agent.labels, card.sourceAgentId, card.cardId);
            setVerified(ok);
            setPending(requests.length);
            setPrompts(ok ? ownerPrompts(requests) : []);
            if (again && expectPending && requests.length === 0) retry = setTimeout(() => read(false), PENDING_RETRY_MS);
          },
          () => undefined,
        );
    read(true);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [agentId, watch, version, reload, expectPending, paseo, card.sourceAgentId, card.cardId]);

  async function answer(requestId: string, response: PermissionResponse) {
    if (!agentId) return;
    try {
      await paseo.agents.ref(agentId).respondToPermission({ requestId, response });
      setPrompts((current) => current.filter((prompt) => prompt.requestId !== requestId));
    } finally {
      setReload((value) => value + 1);
    }
  }
  return { prompts, verified, pending, answer };
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
                onPress={() => setSelections(selectOption(prompt, selections, index, option.label))}
              />
            ))}
          </View>
        </View>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {/* A tap only selects; Send confirms, so a mis-tap never answers. */}
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
        <Button label={allowOther ? "Other answer: open run" : "Open run"} theme={theme} onPress={onOpen} />
      </View>
    </View>
  );
}

function MonoBlock({ text, theme, maxHeight }: { text: string; theme: Theme; maxHeight: number }) {
  return (
    <ScrollView
      nestedScrollEnabled
      style={{ maxHeight, backgroundColor: theme.colors.surface1, borderRadius: 6 }}
      contentContainerStyle={{ padding: 8 }}
    >
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17, fontFamily: MONO }}>
        {text}
      </Text>
    </ScrollView>
  );
}

function DetailLine({ line, theme }: { line: SummaryLine; theme: Theme }) {
  const [revealed, setRevealed] = useState(false);
  if (line.block) {
    return (
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{line.label}</Text>
        <MonoBlock text={line.value} theme={theme} maxHeight={240} />
      </View>
    );
  }
  if (line.masked && !revealed) {
    const length = [...line.value].length;
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>{line.label}: </Text>
          {`•••• (${length} char${length === 1 ? "" : "s"})`}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Show ${line.label.toLowerCase()}`} onPress={() => setRevealed(true)}>
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Show</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{line.label}: </Text>
      {line.value}
      {line.masked ? (
        <Text accessibilityRole="button" onPress={() => setRevealed(false)} style={{ color: theme.colors.accent }}>
          {"  Hide"}
        </Text>
      ) : null}
    </Text>
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
  // Allowing takes a second, explicit tap; denying does not.
  const [confirming, setConfirming] = useState<PromptAction | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{prompt.title}</Text>
      {prompt.description ? (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          {prompt.description}
        </Text>
      ) : null}
      {prompt.summary.map((line) => (
        <DetailLine key={`${line.label}:${line.value}`} line={line} theme={theme} />
      ))}
      {prompt.plan ? <MonoBlock text={prompt.plan} theme={theme} maxHeight={320} /> : null}
      {!prompt.canAllow ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          The card cannot show everything this would allow, so only Deny is offered here. Open the run to see it.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {confirming ? (
          <>
            <Button
              label={`Confirm allow: ${confirming.label}`}
              primary
              disabled={busy}
              theme={theme}
              onPress={() => {
                const action = confirming;
                setConfirming(null);
                onAnswer(permissionResponse(action));
              }}
            />
            <Button label="Cancel" disabled={busy} theme={theme} onPress={() => setConfirming(null)} />
          </>
        ) : (
          prompt.actions.map((action) => (
            <Button
              key={`${action.id ?? action.behavior}:${action.label}`}
              label={action.label}
              primary={action.behavior === "allow"}
              disabled={busy}
              theme={theme}
              onPress={() => (action.behavior === "allow" ? setConfirming(action) : onAnswer(permissionResponse(action)))}
            />
          ))
        )}
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
  verified,
  theme,
  onAnswer,
  onOpen,
}: {
  prompts: OwnerPrompt[];
  /** The snapshot the requests came from shows this card's run; otherwise no answer buttons. */
  verified: boolean;
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
      {!verified || prompts.length === 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>It is waiting for your answer in the run.</Text>
          <Button label="Answer in run" primary theme={theme} onPress={onOpen} />
        </View>
      ) : null}
      {(verified ? prompts : []).map((prompt) =>
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
