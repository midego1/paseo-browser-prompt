import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import * as hostUi from "@getpaseo/plugin/client/ui";
import { type ComponentType, type ReactNode, useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { isSafeLinkHref } from "../shared/browser-prompt";

// Paseo 0.13+ ships a host Markdown component. Older hosts (0.11/0.12) do not, so detect it at
// runtime and fall back to the small renderer below.
const HostMarkdown = (hostUi as unknown as { Markdown?: ComponentType<{ children: string }> }).Markdown;

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

type Block =
  | { kind: "code"; info: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: { marker: string; text: string }[] }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const t = lines[i]!.trim();
        if (t.length >= marker.length && [...t].every((c) => c === marker[0])) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", info: fence[2]!.trim(), text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const m = listItem.exec(lines[i]!);
        if (m) {
          const indent = m[1]!.length;
          const marker = ordered && /\d/.test(m[2]!) ? m[2]! : "•";
          items.push({ marker: indent > 1 ? `  ${marker}` : marker, text: m[3]! });
          i++;
          continue;
        }
        const next = lines[i]!;
        // Lazy continuation line of the previous item.
        if (next.trim() !== "" && /^\s+/.test(next) && !/^\s*(`{3,}|~{3,})/.test(next) && items.length > 0) {
          items[items.length - 1]!.text += ` ${next.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^\s*(`{3,}|~{3,})/.test(lines[i]!) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]!) &&
      !/^\s{0,3}>/.test(lines[i]!) &&
      !listItem.test(lines[i]!)
    ) {
      body.push(lines[i]!.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderInline(text: string, theme: PluginTheme, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;
    if (match[1]) {
      out.push(
        <Text key={key} style={{ fontFamily: MONO, backgroundColor: theme.colors.surface2, color: theme.colors.foreground }}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (match[2]) {
      out.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          {renderInline(token.slice(2, -2), theme, key)}
        </Text>,
      );
    } else if (match[3]) {
      out.push(
        <Text key={key} style={{ fontStyle: "italic" }}>
          {renderInline(token.slice(1, -1), theme, key)}
        </Text>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link ? link[1]! : token;
      const href = link ? link[2]! : token;
      if (!isSafeLinkHref(href)) {
        // Only http(s) links are opened; anything else (javascript:, file:, app schemes) stays text.
        out.push(link ? `${label} (${href})` : token);
        last = index + token.length;
        continue;
      }
      out.push(
        <Text
          key={key}
          accessibilityRole="link"
          style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
          onPress={() => {
            void openExternalUrl(href).catch(() => undefined);
          }}
        >
          {label}
        </Text>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function FallbackMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const body = { color: theme.colors.foreground, fontSize: 15, lineHeight: 22 };
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "code":
            return (
              <View
                key={key}
                style={{
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 10,
                  gap: 4,
                }}
              >
                {block.info ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{block.info}</Text>
                ) : null}
                <Text selectable style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: theme.colors.foreground }}>
                  {block.text}
                </Text>
              </View>
            );
          case "heading":
            return (
              <Text key={key} selectable style={{ ...body, fontWeight: "700", fontSize: block.level <= 2 ? 18 : 16 }}>
                {renderInline(block.text, theme, key)}
              </Text>
            );
          case "quote":
            return (
              <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 }}>
                <Text selectable style={{ ...body, color: theme.colors.foregroundMuted }}>
                  {renderInline(block.text, theme, key)}
                </Text>
              </View>
            );
          case "list":
            return (
              <View key={key} style={{ gap: 4 }}>
                {block.items.map((item, k) => (
                  <View key={`${key}-${k}`} style={{ flexDirection: "row", gap: 6 }}>
                    <Text style={{ ...body, color: theme.colors.foregroundMuted }}>{item.marker}</Text>
                    <Text selectable style={{ ...body, flex: 1 }}>
                      {renderInline(item.text, theme, `${key}-${k}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "rule":
            return <View key={key} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          default:
            return (
              <Text key={key} selectable style={body}>
                {renderInline(block.text, theme, key)}
              </Text>
            );
        }
      })}
    </View>
  );
}

/** Renders assistant markdown with the host component when available, otherwise a compact fallback. */
export function MessageMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  if (HostMarkdown) return <HostMarkdown>{text}</HostMarkdown>;
  return <FallbackMarkdown text={text} theme={theme} />;
}
