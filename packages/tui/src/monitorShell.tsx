/**
 * Shared chrome for the bottom-region panels.
 *
 * The swarm board and the /sdd kanban each drew their own border, their own
 * header, their own key legend and their own empty state, and they drifted:
 * different glyphs for the same state, a legend on one and not the other, a
 * header that truncated its counts on a narrow terminal. This is the one frame
 * they both wear, so a panel added later inherits the conventions instead of
 * inventing them.
 *
 * The conventions, in one place:
 *
 * - Header: `icon TITLE / kicker` on the left, aggregates on the right. The
 *   title is bold in the panel's accent so two open panels are tellable apart.
 * - **Overflow is counted, never silent.** A panel that quietly shows the first
 *   eight of twelve reads as a complete list; `↓ 4 more` is the whole
 *   difference between a view and a lie.
 * - The key legend gets its own row. Sharing the header's row, it was the half
 *   that got truncated on a 100-column terminal — and a legend nobody can
 *   finish reading is not one.
 */

import type React from "react";
import { Box, Text } from "./ink.js";
import { theme } from "./theme.js";

/**
 * The slice of `rows` to draw, always containing `selected`.
 *
 * A panel in the bottom region has a fixed row budget — exceed it and Ink's
 * repaint pushes the transcript off the screen. Cutting the tail is the obvious
 * implementation and the wrong one: the selected row scrolls out of view and
 * the arrow keys appear to stop working. The window follows the selection
 * instead, and reports what it left on both sides so the caller can say so.
 */
export function panelWindow<T>(
  rows: T[],
  selected: number,
  capacity: number,
): { window: T[]; before: number; after: number; offset: number } {
  if (capacity >= rows.length || capacity <= 0) {
    return { window: rows, before: 0, after: 0, offset: 0 };
  }
  const sel = Math.max(0, Math.min(rows.length - 1, selected));
  // Keep the selection roughly centred, then clamp so the window never runs
  // off either end (which would show fewer rows than the budget allows).
  let start = sel - Math.floor(capacity / 2);
  start = Math.max(0, Math.min(rows.length - capacity, start));
  return {
    window: rows.slice(start, start + capacity),
    before: start,
    after: rows.length - (start + capacity),
    offset: start,
  };
}

/**
 * The frame every bottom-region panel wears.
 *
 * `right` is the aggregates slot — the numbers that answer "is anything
 * happening" without reading a single row. `footer` is the key legend, on its
 * own row by construction.
 */
export function MonitorShell({
  glyph,
  title,
  kicker,
  accent,
  right,
  footer,
  children,
}: {
  glyph: string;
  title: string;
  kicker?: string;
  /** Per-panel accent, so two panels are never mistaken for each other. */
  accent: string;
  right?: React.ReactNode;
  footer?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={accent} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={accent} bold>
          {glyph} {title}
        </Text>
        {kicker ? (
          <Text color={theme.textMuted} dimColor>
            {"  / "}
            {kicker}
          </Text>
        ) : null}
        {right}
      </Text>
      {children}
      {footer ? (
        <Text color={theme.textMuted} dimColor wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}
