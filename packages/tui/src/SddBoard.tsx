import type { SddTaskState } from "@arterm/core";
import { Box, Text } from "ink";
import type React from "react";

/** A single task rendered on the /sdd board. */
export interface SddBoardTask {
  id: string;
  title: string;
  dependsOn: string[];
  state: SddTaskState;
}

/** Kanban columns, in flow order left→right. */
const COLUMNS: { state: SddTaskState; label: string; color: string }[] = [
  { state: "pending", label: "PENDING", color: "gray" },
  { state: "running", label: "RUNNING", color: "yellow" },
  { state: "done", label: "DONE", color: "green" },
  { state: "failed", label: "FAILED", color: "red" },
];

const MAX_PER_COLUMN = 8;

/**
 * Live kanban board for a /sdd run: one column per task state, updated in place as
 * `sdd_task_state` events arrive. Rendered in the bottom region so the whole DAG
 * stays visible while the fleet works through it.
 */
export function SddBoard({
  tasks,
  columns,
}: {
  tasks: SddBoardTask[];
  /** Terminal width, used to size the four columns. */
  columns: number;
}): React.ReactElement {
  const total = tasks.length;
  const done = tasks.filter((t) => t.state === "done").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const running = tasks.filter((t) => t.state === "running").length;
  // Four columns share the inner width (minus the border + per-column gutter).
  const colWidth = Math.max(10, Math.floor((columns - 6) / COLUMNS.length) - 1);

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        <Text color="cyan" bold>
          ▤ /sdd board
        </Text>
        <Text color="gray">
          {"  — "}
          {done}/{total} done
          {running ? ` · ${running} running` : ""}
          {failed ? ` · ${failed} failed` : ""}
        </Text>
      </Text>
      <Box>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.state === col.state);
          return (
            <Box key={col.state} flexDirection="column" width={colWidth} paddingRight={1}>
              <Text color={col.color} bold>
                {col.label} ({items.length})
              </Text>
              {items.slice(0, MAX_PER_COLUMN).map((t) => (
                <Text key={t.id} color={col.color} wrap="truncate-end">
                  {mark(col.state)} {t.id} {t.title}
                </Text>
              ))}
              {items.length > MAX_PER_COLUMN ? (
                <Text color="gray" dimColor>
                  {`  +${items.length - MAX_PER_COLUMN} more`}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function mark(state: SddTaskState): string {
  switch (state) {
    case "running":
      return "▸";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}
