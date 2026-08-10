import type React from "react";
import { Box, Text } from "./ink.js";
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

/**
 * A compact "how long ago" — the panel's rightmost column. Coarse on purpose:
 * the question it answers is "which of these did I touch recently", and
 * seconds-precision past the first minute is churn the eye has to re-read on
 * every repaint.
 */
export function age(sinceMs: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - sinceMs) / 1000));
  if (s < 60) return `${s}sn`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}dk`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}sa`;
  return `${Math.round(h / 24)}g`;
}

/** One of the header's three buckets. A fresh session has completed nothing. */
export function bucketOf(entry: SessionPanelEntry): "awaiting" | "working" | "completed" | "new" {
  if (entry.awaitingPermission) return "awaiting";
  if (entry.meta.status !== "idle" || entry.meta.autonomyRunning) return "working";
  return entry.meta.rounds > 0 ? "completed" : "new";
}

function statusGlyph(entry: SessionPanelEntry): React.ReactElement {
  switch (bucketOf(entry)) {
    case "awaiting":
      return <Text color="yellow">⏳</Text>;
    case "working":
      return <Text color="yellow">●</Text>;
    case "completed":
      return <Text color="green">●</Text>;
    case "new":
      return <Text color="gray">○</Text>;
  }
}

/**
 * The row's right-hand summary: what the session is DOING while busy, what it
 * last SAID once idle. The idle half is the column the panel existed without —
 * every finished row read "boşta", which says a session stopped and nothing
 * about what came of it.
 */
function summaryLabel(entry: SessionPanelEntry): string {
  if (entry.awaitingPermission) return "izin bekliyor";
  if (entry.meta.status === "tool") return `⚙ ${entry.meta.activeTool ?? "tool"}`;
  if (entry.meta.status === "thinking") return "✎ yazıyor";
  if (entry.meta.autonomyRunning && entry.goal) return `🎯 ${entry.goal}`;
  if (entry.meta.lastAssistantSnippet) return entry.meta.lastAssistantSnippet;
  return entry.meta.rounds > 0 ? "tamamlandı" : "yeni";
}

/**
 * Session dashboard (opened with ←): counts up top, one row per session with
 * its live status, last result and age, the selected row's recent prompts, and
 * a composer that starts a new session working IN THE BACKGROUND.
 *
 * `fill` (fullscreen) makes it the whole surface — list at the top, a flexible
 * void in the middle, the composer and the key hints pinned to the BOTTOM,
 * where every other full-screen surface in this UI keeps its prompt. Without
 * it the dashboard was a small box floating over nine-tenths of empty screen,
 * which reads as a rendering accident rather than a place.
 */
export function SessionPanel({
  entries,
  activeId,
  selected,
  input,
  canCreate,
  columns,
  fill = false,
}: {
  entries: SessionPanelEntry[];
  activeId: string;
  selected: number;
  input: string;
  canCreate: boolean;
  columns: number;
  fill?: boolean;
}): React.ReactElement {
  const counts = { awaiting: 0, working: 0, completed: 0, new: 0 };
  for (const e of entries) counts[bucketOf(e)] += 1;
  const titleW = Math.max(12, Math.min(44, columns - 46));
  const summaryW = Math.max(10, Math.min(36, columns - titleW - 18));
  const composer = canCreate ? (
    <Box>
      <Text color="cyan">{" › "}</Text>
      {input ? (
        <Text>{input}</Text>
      ) : (
        <Text color="gray" dimColor>
          yeni oturum için görev tanımla…
        </Text>
      )}
      <Text color="cyan">▏</Text>
      <Text color="gray" dimColor>
        {"  Enter = arka planda başlat"}
      </Text>
    </Box>
  ) : null;
  const hints = (
    <Text color="gray" dimColor>
      {" ↑↓ seç · Enter aç · Esc geri · ^X kapat · ^C çıkış"}
    </Text>
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      {...(fill ? { flexGrow: 1 } : {})}
    >
      <Box>
        <Text color="cyan" bold>
          ── OTURUMLAR ──
        </Text>
        <Text color="gray">
          {`  ${counts.awaiting} onay bekliyor · ${counts.working} çalışıyor · ${counts.completed} tamamlandı`}
          {counts.new > 0 ? ` · ${counts.new} yeni` : ""}
        </Text>
      </Box>
      <Box height={1} />
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
              <Text color="gray" wrap="truncate">
                {"  "}
                {clip(summaryLabel(entry), summaryW).padEnd(summaryW)}
                {"  "}
                <Text dimColor>{age(entry.meta.lastActivityAt).padStart(4)}</Text>
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
      {fill ? (
        <>
          <Box flexGrow={1} />
          {composer}
          {hints}
        </>
      ) : (
        <>
          {composer ? <Box marginTop={1}>{composer}</Box> : null}
          {hints}
        </>
      )}
    </Box>
  );
}
