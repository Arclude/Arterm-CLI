/**
 * The model's work list, on screen.
 *
 * The list exists so a long run's plan survives compaction, but there is a
 * second reason to render it: it is the only honest answer to "what is this
 * thing doing". A transcript says what already happened; the todo list says
 * what the model believes is left, in its own words, updated by the same call
 * that changes its behaviour.
 *
 * Deliberately a strip and not a panel. It sits above the status bar for the
 * whole run, so it has to cost few rows: the item in progress, its neighbours,
 * and a count. A run with fourteen steps does not get fourteen rows of chrome
 * — it gets a window around the one that matters, and the rest is counted.
 */

import type { TodoItem } from "@arterm/core";
import type React from "react";
import { Box, Text } from "./ink.js";
import { truncateDisplay } from "./terminalWidth.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

/** Rows of list drawn at once, including the one in progress. */
const WINDOW = 3;

const MARK: Record<TodoItem["status"], string> = {
  pending: glyphs.pending,
  in_progress: glyphs.running,
  done: glyphs.success,
};

function color(status: TodoItem["status"], current: boolean): string {
  if (status === "done") return theme.success;
  if (current) return theme.warn;
  return theme.textMuted;
}

export function TodoStrip({
  items,
  columns,
}: {
  items: TodoItem[];
  columns: number;
}): React.ReactElement {
  const done = items.filter((i) => i.status === "done").length;
  const activeIdx = items.findIndex((i) => i.status === "in_progress");
  // Window on the item in progress; with none (all pending, or all done) show
  // the head of the list, which is what will be worked on next.
  const centre = activeIdx >= 0 ? activeIdx : 0;
  const start = Math.max(0, Math.min(items.length - WINDOW, centre - 1));
  const shown = items.slice(start, start + WINDOW);
  const hidden = items.length - shown.length;

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.accent} bold>
          {glyphs.plan} TODO
        </Text>
        <Text color={theme.textMuted}>
          {"  "}
          {done}/{items.length}
        </Text>
        {hidden > 0 ? (
          <Text color={theme.textMuted} dimColor>
            {" "}
            · {hidden} more
          </Text>
        ) : null}
      </Text>
      {shown.map((item, i) => {
        const current = start + i === activeIdx;
        return (
          <Text
            key={item.id}
            wrap="truncate-end"
            color={color(item.status, current)}
            bold={current}
          >
            {"  "}
            {MARK[item.status]} {truncateDisplay(item.text, Math.max(10, columns - 6))}
          </Text>
        );
      })}
    </Box>
  );
}
