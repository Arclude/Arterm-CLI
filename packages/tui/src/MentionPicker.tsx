import type React from "react";
import { Box, Text } from "./ink.js";
import { pickWindow } from "./mentionInput.js";
import { theme } from "./theme.js";

/** How many rows the box draws at once. The list SCROLLS through the rest. */
export const MENTION_ROWS = 8;

/**
 * The file list `@` opens over the composer.
 *
 * Drawn ABOVE the prompt rather than below it. The composer sits at the bottom
 * of the screen, so a list under it would either be off-screen or push the
 * prompt up on every keystroke — and a prompt that moves while you type is the
 * one thing a composer must never do.
 *
 * Eight rows is a VIEWPORT, not the end of the list: `pickWindow` slides it so
 * the highlighted row is always drawn. It used to be a truncation, and the two
 * are indistinguishable on screen for the first eight files — after which the
 * ninth match could not be reached and the highlight left the box entirely,
 * reading as "your file is not in the project" for a file that was in it.
 *
 * The position is printed for the rule `evidenceBlock` and `roundClaim` already
 * follow: a list that quietly ends reads as a complete one, so `3/47` is what
 * says there are forty-four more rows below this box.
 */
export function MentionPicker({
  matches,
  index,
  query,
  capped = false,
}: {
  matches: readonly string[];
  index: number;
  query: string;
  /** The ranking hit its cap, so `total` is a floor and says so with a `+`. */
  capped?: boolean;
}): React.ReactElement {
  const total = matches.length;
  const start = pickWindow(index, total, MENTION_ROWS);
  const shown = matches.slice(start, start + MENTION_ROWS);
  const position = `${Math.min(index + 1, total)}/${total}${capped ? "+" : ""}`;
  return (
    <Box flexDirection="column" marginBottom={0}>
      {shown.length === 0 ? (
        <Text color={theme.textMuted}>
          {"  "}
          {query ? `no file matches “${query}”` : "no files here to attach"}
        </Text>
      ) : (
        shown.map((path, i) => {
          const sel = start + i === index;
          return (
            <Box key={path}>
              <Text color={sel ? theme.accent : theme.textMuted}>{sel ? "▸ " : "  "}</Text>
              <Text
                color={sel ? theme.accent : theme.textSecondary}
                bold={sel}
                wrap="truncate-middle"
              >
                {path}
              </Text>
            </Box>
          );
        })
      )}
      {shown.length > 0 ? (
        <Text color={theme.textMuted}>{`  ${position} · ↑↓ pick · ⇥/⏎ attach · esc cancel`}</Text>
      ) : null}
    </Box>
  );
}
