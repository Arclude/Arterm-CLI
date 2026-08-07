import type { SddTaskState } from "@arterm/core";
import type React from "react";
import { Box, Text } from "./ink.js";
import { MonitorShell } from "./monitorShell.js";
import { STATE_COLOR, stateMark } from "./taskState.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

/** A single task rendered on the /sdd board. */
export interface SddBoardTask {
  id: string;
  title: string;
  dependsOn: string[];
  state: SddTaskState;
}

/** Kanban columns, in flow order left→right. Colours come from the one table. */
const COLUMNS: { state: SddTaskState; label: string }[] = [
  { state: "pending", label: "PENDING" },
  { state: "running", label: "RUNNING" },
  { state: "done", label: "DONE" },
  { state: "failed", label: "FAILED" },
  // A blocked task never ran because a dependency failed — its own column, so it
  // is not mistaken for work still queued.
  { state: "blocked", label: "BLOCKED" },
];

const MAX_PER_COLUMN = 8;

/** How many trailing feed lines the drill-down view shows (matches TeamBoard). */
const DETAIL_LINES = 12;

/**
 * Live kanban board for a /sdd run: one column per task state, updated in place as
 * `sdd_task_state` events arrive. Rendered in the bottom region so the whole DAG
 * stays visible while the fleet works through it.
 *
 * Selection runs over the graph order (t1, t2, …) rather than over the columns: a
 * task moves between columns as it runs, and a selection that jumped with it would
 * be impossible to steer. The marker follows the selected task into whichever
 * column it currently sits in.
 */
export function SddBoard({
  tasks,
  columns,
  selected = -1,
  detailOpen = false,
  feed = [],
}: {
  tasks: SddBoardTask[];
  /** Terminal width, used to size the four columns. */
  columns: number;
  /** Index into `tasks` of the selected row; -1 for no selection. */
  selected?: number;
  /** True when the selected task's activity feed is expanded. */
  detailOpen?: boolean;
  /** The selected task's feed lines (newest last). */
  feed?: string[];
}): React.ReactElement {
  const sel = selected >= 0 ? tasks[Math.min(selected, tasks.length - 1)] : undefined;
  const total = tasks.length;
  const done = tasks.filter((t) => t.state === "done").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const running = tasks.filter((t) => t.state === "running").length;
  // Four columns share the inner width (minus the border + per-column gutter).
  const colWidth = Math.max(10, Math.floor((columns - 6) / COLUMNS.length) - 1);

  return (
    <MonitorShell
      glyph={glyphs.plan}
      title="/sdd board"
      accent={theme.monitor.sdd}
      footer={`${detailOpen ? "↑↓/⇥" : "⇥/^↑↓"} task${detailOpen ? "" : " · ⏎ inspect"} · esc close`}
      right={
        <Text color={theme.textMuted}>
          {"   "}
          {done}/{total} done
          {running ? ` · ${running} running` : ""}
          {failed ? ` · ${failed} failed` : ""}
        </Text>
      }
    >
      <Box>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.state === col.state);
          const color = STATE_COLOR[col.state];
          return (
            <Box key={col.state} flexDirection="column" width={colWidth} paddingRight={1}>
              <Text color={color} bold>
                {col.label} ({items.length})
              </Text>
              {items.slice(0, MAX_PER_COLUMN).map((t) => (
                <Text key={t.id} color={color} wrap="truncate-end" bold={t.id === sel?.id}>
                  {t.id === sel?.id ? glyphs.select : stateMark(col.state)} {t.id} {t.title}
                </Text>
              ))}
              {items.length > MAX_PER_COLUMN ? (
                <Text color={theme.textMuted} dimColor>
                  {`  +${items.length - MAX_PER_COLUMN} more`}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {detailOpen && sel ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text color={sel.state === "failed" ? theme.error : theme.accent} bold>
              {glyphs.tool} {sel.id} {sel.title}
            </Text>
            <Text color={theme.textMuted} dimColor>
              {` (${Math.min(selected, tasks.length - 1) + 1}/${tasks.length})`}
            </Text>
            {sel.dependsOn.length > 0 ? (
              <Text color={theme.textMuted}> — after {sel.dependsOn.join(", ")}</Text>
            ) : null}
          </Text>
          {feed.length === 0 ? (
            <Text color={theme.textMuted} dimColor>
              (no activity yet)
            </Text>
          ) : (
            feed.slice(-DETAIL_LINES).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: feed lines are append-only
              <Text key={i} color={theme.textMuted} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>
      ) : null}
    </MonitorShell>
  );
}
