import { Box, Text } from "ink";
import type React from "react";
import type { SessionMetaState } from "./sessionMeta.js";

export interface SessionPanelEntry {
  id: string;
  /** First user prompt, clipped — or a placeholder for a fresh session. */
  title: string;
  meta: SessionMetaState;
  /** Last few user prompts, oldest first (shown under the selected row). */
  recentPrompts: string[];
  awaitingPermission: boolean;
  /** Active autonomous goal, when one is running. */
  goal?: string;
}

/** Truncate to a max display length, marking the cut with an ellipsis. */
function clip(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function statusGlyph(entry: SessionPanelEntry): React.ReactElement {
  if (entry.awaitingPermission) return <Text color="yellow">⏳</Text>;
  if (entry.meta.status !== "idle" || entry.meta.autonomyRunning)
    return <Text color="yellow">●</Text>;
  return <Text color="green">●</Text>;
}

function activityLabel(entry: SessionPanelEntry): string {
  if (entry.awaitingPermission) return "izin bekliyor";
  if (entry.meta.status === "tool") return `⚙ ${entry.meta.activeTool ?? "tool"}`;
  if (entry.meta.status === "thinking") return "✎ yazıyor";
  if (entry.meta.autonomyRunning && entry.goal) return `🎯 ${entry.goal}`;
  return "boşta";
}

/**
 * Session switcher overlay (opened with ←): every session with its live
 * activity, the selected one's recent prompts, and a create-input line that
 * starts a NEW session from whatever is typed into it.
 */
export function SessionPanel({
  entries,
  activeId,
  selected,
  input,
  canCreate,
  columns,
}: {
  entries: SessionPanelEntry[];
  activeId: string;
  selected: number;
  input: string;
  canCreate: boolean;
  columns: number;
}): React.ReactElement {
  const titleW = Math.max(12, Math.min(48, columns - 34));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          ── OTURUMLAR ──
        </Text>
        <Text color="gray" dimColor>
          {"   ↑↓ seç · Enter geç · ^X oturumu kapat · Esc kapat"}
        </Text>
      </Box>
      {entries.map((entry, i) => {
        const sel = i === selected;
        return (
          <Box key={entry.id} flexDirection="column">
            <Box>
              <Text
                color={sel ? "black" : "white"}
                backgroundColor={sel ? "cyan" : undefined}
                bold={sel}
              >
                {sel ? " ❯ " : "   "}
                {statusGlyph(entry)}
                <Text> {clip(entry.title, titleW).padEnd(titleW)}</Text>
              </Text>
              <Text color="gray">
                {"  "}
                {clip(activityLabel(entry), 28)}
                {entry.meta.rounds > 0 ? ` · ${entry.meta.rounds} tur` : ""}
                {entry.id === activeId ? "  ← aktif" : ""}
              </Text>
            </Box>
            {sel &&
              entry.recentPrompts.map((prompt, j) => (
                <Text key={`${entry.id}-p${j}`} color="gray" dimColor wrap="truncate">
                  {"       › "}
                  {clip(prompt, Math.max(16, columns - 12))}
                </Text>
              ))}
          </Box>
        );
      })}
      {canCreate ? (
        <Box marginTop={1}>
          <Text color="cyan">{" › "}</Text>
          <Text>{input}</Text>
          <Text color="cyan">▏</Text>
          <Text color="gray" dimColor>
            {"  yaz + Enter = yeni oturum"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
