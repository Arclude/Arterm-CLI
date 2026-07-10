import type { SddTaskState } from "@arterm/core";
import { Box, Text } from "ink";
import type React from "react";

/** One team member's live row on the /team board. */
export interface TeamBoardMember {
  id: string;
  name: string;
  description: string;
  /** True when the leader invented this member (no definition file). */
  adhoc: boolean;
  state: SddTaskState;
  /** Current assignment (from the latest team_member_state). */
  task?: string;
  /** Last bridged activity — tool name or a writing indicator. */
  activity?: string;
  filesChanged?: number;
}

const STATE_COLOR: Record<SddTaskState, string> = {
  pending: "gray",
  running: "yellow",
  done: "green",
  failed: "red",
};

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

/** How many trailing feed lines the drill-down view shows. */
const DETAIL_LINES = 12;

/**
 * Live member board for a /team run: one row per member, updated in place by
 * `team_member_state` (assignment + state) and `team_member_event` (activity).
 * ↑/↓ (on an empty prompt) move the selection, Enter opens the selected
 * member's activity feed (drill-down), Esc closes it. Rendered in the bottom
 * region, like the /sdd kanban.
 */
export function TeamBoard({
  members,
  columns,
  selected,
  detailOpen,
  feed,
}: {
  members: TeamBoardMember[];
  /** Terminal width, used to truncate rows. */
  columns: number;
  /** Index of the row the ↑/↓ selection is on. */
  selected: number;
  /** True when the selected member's activity feed is expanded. */
  detailOpen: boolean;
  /** The selected member's feed lines (newest last). */
  feed: string[];
}): React.ReactElement {
  const done = members.filter((m) => m.state === "done").length;
  const failed = members.filter((m) => m.state === "failed").length;
  const nameWidth = Math.min(
    18,
    Math.max(6, ...members.map((m) => m.name.length + (m.adhoc ? 1 : 0))),
  );
  const sel = members[Math.min(selected, members.length - 1)];

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Text>
        <Text color="magenta" bold>
          ⚑ team
        </Text>
        <Text color="gray">
          {"  — "}
          {done}/{members.length} done
          {failed ? ` · ${failed} failed` : ""}
        </Text>
        <Text color="gray" dimColor>
          {"   ↑↓ member · ⏎ inspect · esc close"}
        </Text>
      </Text>
      {members.map((m, i) => {
        const color = STATE_COLOR[m.state];
        const isSel = i === Math.min(selected, members.length - 1);
        const label = `${m.name}${m.adhoc ? "*" : ""}`.padEnd(nameWidth);
        const detail = m.state === "pending" ? m.description : (m.task ?? m.description);
        const files = m.filesChanged ? `  ✎${m.filesChanged}` : "";
        const activity = m.state === "running" && m.activity ? `  ${m.activity}` : "";
        return (
          <Text key={m.id} wrap="truncate-end">
            <Text color={isSel ? "magenta" : "gray"} bold={isSel}>
              {isSel ? "❯ " : "  "}
            </Text>
            <Text color={color} bold={isSel}>
              {mark(m.state)} {label}
            </Text>
            <Text color="gray"> {detail.slice(0, Math.max(10, columns - nameWidth - 22))}</Text>
            <Text color="cyan">{activity}</Text>
            <Text color="green">{files}</Text>
          </Text>
        );
      })}
      {detailOpen && sel ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text color="magenta" bold>
              ⚙ {sel.name}
            </Text>
            <Text color="gray"> — {(sel.task ?? sel.description).slice(0, columns - 20)}</Text>
          </Text>
          {feed.length === 0 ? (
            <Text color="gray" dimColor>
              (no activity yet)
            </Text>
          ) : (
            feed.slice(-DETAIL_LINES).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: feed lines are append-only
              <Text key={i} color="gray" wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>
      ) : null}
    </Box>
  );
}
