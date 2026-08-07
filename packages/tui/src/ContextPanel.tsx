/**
 * What is in the context window, and what is about to happen to it.
 *
 * The status bar answers "how full" in eight columns, which is the right answer
 * for a bar and the wrong one for a decision. A window at 80% is a different
 * situation when it is 60k of tool output than when it is 60k of conversation:
 * the first is fixed by clearing stale results, the second by compacting, and
 * the third case — a system prompt and a tool roster that alone eat a third of
 * a small local model's window — is not fixed by either, and is invisible until
 * something breaks it down.
 *
 * Everything here is read from the agent, never re-derived from the transcript:
 * the transcript and the context stop matching the moment either compaction or
 * tool-result clearing runs, and a panel that quietly disagreed with the agent
 * would be worse than no panel.
 */

import type { ContextBreakdown } from "@arterm/core";
import type React from "react";
import type { TeamBoardMember } from "./TeamBoard.js";
import { Box, Text } from "./ink.js";
import { MonitorShell } from "./monitorShell.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

/** Compact token count: 1.2k, 34k, 1.1M. */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * A ramp, not a threshold — the same one the swarm board's cells use, so a
 * worker at 70% and the session at 70% are the same colour in both places.
 */
export function fillColor(pct: number): string {
  if (pct >= 80) return theme.error;
  if (pct >= 65) return theme.warn;
  if (pct >= 50) return "peach";
  if (pct >= 25) return theme.success;
  return theme.accent;
}

function meter(pct: number, width: number): string {
  const w = Math.max(1, width);
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return glyphs.meterFull.repeat(filled) + glyphs.meterEmpty.repeat(w - filled);
}

/** One composition row: label, bar, tokens, share. */
function Part({
  label,
  tokens,
  total,
  width,
}: {
  label: string;
  tokens: number;
  total: number;
  width: number;
}): React.ReactElement {
  const share = total > 0 ? Math.round((tokens / total) * 100) : 0;
  return (
    <Text wrap="truncate-end">
      <Text color={theme.textSecondary}>{label.padEnd(14)}</Text>
      <Text color={fillColor(share)}>{meter(share, width)}</Text>
      <Text color={theme.textMuted}>
        {" "}
        {fmtTok(tokens).padStart(6)} {String(share).padStart(3)}%
      </Text>
    </Text>
  );
}

export interface ContextPanelProps {
  /** The agent's own usage — the number the compaction decision uses. */
  used: number;
  window?: number;
  /** True when no provider reported prompt tokens and this is the heuristic. */
  estimated: boolean;
  /** The composition, or undefined while it is still being computed. */
  breakdown?: ContextBreakdown;
  /** Auto-compaction threshold as a fraction (config `compactAtPercent`). */
  compactAt: number;
  /** Compactions so far this session, and the last one's before/after. */
  compactions: { count: number; last?: { before: number; after: number } };
  /** Stale tool results cleared so far this session. */
  cleared: number;
  /** Live workers, so a fan-out's context pressure is visible in one place. */
  members: TeamBoardMember[];
  columns: number;
}

export function ContextPanel({
  used,
  window,
  estimated,
  breakdown,
  compactAt,
  compactions,
  cleared,
  members,
  columns,
}: ContextPanelProps): React.ReactElement {
  const pct = window ? Math.min(100, Math.round((used / window) * 100)) : 0;
  const barW = Math.max(10, Math.min(28, columns - 40));
  // Where auto-compaction will fire, in tokens — a percentage alone does not
  // say how much room is actually left before it does.
  const threshold = window ? Math.round(window * compactAt) : undefined;
  const remaining = threshold !== undefined ? Math.max(0, threshold - used) : undefined;

  return (
    <MonitorShell
      glyph={glyphs.context}
      title="CONTEXT"
      kicker={estimated ? "estimated" : "reported by the provider"}
      accent={theme.monitor.session}
      footer="esc close"
      right={
        <Text color={theme.textMuted}>
          {"   "}
          {window ? `${fmtTok(used)}/${fmtTok(window)}` : `${fmtTok(used)} used`}
        </Text>
      }
    >
      <Box marginTop={1}>
        <Text>
          <Text color={theme.textSecondary}>{"fill".padEnd(14)}</Text>
          <Text color={fillColor(pct)}>{meter(pct, barW)}</Text>
          <Text color={theme.textMuted}>
            {" "}
            {String(pct).padStart(3)}%
            {remaining === undefined
              ? ""
              : remaining === 0
                ? ` · auto-compact due (over ${Math.round(compactAt * 100)}%)`
                : ` · ${fmtTok(remaining)}t until auto-compact (${Math.round(compactAt * 100)}%)`}
          </Text>
        </Text>
      </Box>

      {breakdown ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted} bold>
            COMPOSITION
            <Text color={theme.textMuted} dimColor>
              {" "}
              (estimated {fmtTok(breakdown.total)}, {breakdown.messages} messages)
            </Text>
          </Text>
          <Part label="system" tokens={breakdown.system} total={breakdown.total} width={barW} />
          {breakdown.nativeTools ? (
            <Part
              label="tool schemas"
              tokens={breakdown.tools}
              total={breakdown.total}
              width={barW}
            />
          ) : null}
          <Part
            label="conversation"
            tokens={breakdown.conversation}
            total={breakdown.total}
            width={barW}
          />
          <Part
            label="tool results"
            tokens={breakdown.toolResults}
            total={breakdown.total}
            width={barW}
          />
          {!breakdown.nativeTools ? (
            <Text color={theme.textMuted} dimColor wrap="truncate-end">
              {"  "}this model takes tool schemas in the prompt, so they are part of `system`
            </Text>
          ) : null}
        </Box>
      ) : (
        <Text color={theme.textMuted} dimColor>
          {"  "}measuring…
        </Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted} bold>
          HISTORY
        </Text>
        <Text color={theme.textMuted} wrap="truncate-end">
          {"  "}
          {compactions.count === 0
            ? "no compaction yet this session"
            : `${compactions.count} compaction${compactions.count > 1 ? "s" : ""}${
                compactions.last
                  ? ` · last ${compactions.last.before} → ${compactions.last.after} messages`
                  : ""
              }`}
          {cleared > 0 ? ` · ${cleared} stale tool result${cleared > 1 ? "s" : ""} cleared` : ""}
        </Text>
      </Box>

      {members.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted} bold>
            AGENTS {members.length}
          </Text>
          {members.map((m) => {
            const mp =
              m.ctxWindow && m.ctxUsed
                ? Math.min(100, Math.round((m.ctxUsed / m.ctxWindow) * 100))
                : 0;
            return (
              <Text key={m.id} wrap="truncate-end">
                <Text color={theme.textSecondary}>
                  {"  "}
                  {m.name.slice(0, 12).padEnd(12)}
                </Text>
                <Text color={fillColor(mp)}>{meter(mp, Math.min(12, barW))}</Text>
                <Text color={theme.textMuted}>
                  {" "}
                  {String(mp).padStart(3)}%{m.ctxUsed ? ` ${fmtTok(m.ctxUsed)}` : ""}
                </Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
    </MonitorShell>
  );
}
