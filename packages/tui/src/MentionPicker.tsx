import type React from "react";
import { Box, Text } from "./ink.js";
import { theme } from "./theme.js";

/** How many rows the box draws before it starts counting instead. */
export const MENTION_ROWS = 8;

/**
 * The file list `@` opens over the composer.
 *
 * Drawn ABOVE the prompt rather than below it. The composer sits at the bottom
 * of the screen, so a list under it would either be off-screen or push the
 * prompt up on every keystroke — and a prompt that moves while you type is the
 * one thing a composer must never do.
 *
 * The overflow count is printed rather than the list silently stopping at eight,
 * the rule `evidenceBlock` and `roundClaim` already follow: a list that quietly
 * ends reads as a complete one, and here that would mean "your file is not in
 * the project" when it is simply the ninth match.
 */
export function MentionPicker({
  matches,
  index,
  query,
  total,
}: {
  matches: readonly string[];
  index: number;
  query: string;
  /** Matches before the row budget, so the count can say what is not shown. */
  total: number;
}): React.ReactElement {
  const shown = matches.slice(0, MENTION_ROWS);
  return (
    <Box flexDirection="column" marginBottom={0}>
      {shown.length === 0 ? (
        <Text color={theme.textMuted}>
          {"  "}
          {query ? `no file matches “${query}”` : "no files here to attach"}
        </Text>
      ) : (
        shown.map((path, i) => {
          const sel = i === index;
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
      {total > shown.length ? (
        <Text color={theme.textMuted}>{`  …${total - shown.length} more — keep typing`}</Text>
      ) : null}
      {shown.length > 0 ? (
        <Text color={theme.textMuted}>{"  ↑↓ pick · ⇥/⏎ attach · esc cancel"}</Text>
      ) : null}
    </Box>
  );
}
