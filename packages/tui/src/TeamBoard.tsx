import type { SddTaskState } from "@arterm/core";
import { Box, Text } from "ink";
import type React from "react";
import { agentColor } from "./agentColor.js";

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
  blocked: "gray",
};

function mark(state: SddTaskState): string {
  switch (state) {
    case "running":
      return "▸";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "blocked":
      return "⊘";
    default:
      return "·";
  }
}

/** How many trailing feed lines the drill-down view shows. */
const DETAIL_LINES = 12;

/** Which kind of run the board is showing — only the wording differs. */
export type TeamBoardKind = "team" | "fleet";

const KIND_LABEL: Record<TeamBoardKind, { title: string; unit: string }> = {
  team: { title: "⚑ team", unit: "member" },
  fleet: { title: "⛓ fleet", unit: "subtask" },
};

/**
 * Live board for a fan-out run: one row per worker, updated in place by
 * `team_member_state` (assignment + state) and `team_member_event` (activity).
 * Tab steps to the next row (the one binding no terminal can mangle), as do
 * Ctrl+↑/↓ and Alt+↑/↓ where the terminal transmits them. Enter on an empty prompt
 * opens the selected row's activity feed (drill-down), and while that feed is open
 * plain ↑/↓ step rows too — inspecting is a mode, so the bare arrows are free
 * there; with it closed they stay prompt history. Esc closes it. Rendered in the
 * bottom region, like the /sdd kanban.
 *
 * Both fan-out modes render here: a /team run's rows are its standing roster
 * (stable across rounds), a parallel run's rows are the current round's
 * subtasks (replaced each round).
 */
export function TeamBoard({
  members,
  columns,
  selected,
  detailOpen,
  feed,
  kind = "team",
}: {
  members: TeamBoardMember[];
  /** Terminal width, used to truncate rows. */
  columns: number;
  /** Index of the row the Ctrl+↑/↓ selection is on. */
  selected: number;
  /** True when the selected row's activity feed is expanded. */
  detailOpen: boolean;
  /** The selected row's feed lines (newest last). */
  feed: string[];
  /** Team roster vs. parallel-round subtasks — wording only. */
  kind?: TeamBoardKind;
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
          {KIND_LABEL[kind].title}
        </Text>
        <Text color="gray">
          {"  — "}
          {done}/{members.length} done
          {failed ? ` · ${failed} failed` : ""}
        </Text>
        <Text color="gray" dimColor>
          {`   ${detailOpen ? "↑↓/⇥" : "⇥/^↑↓"} ${KIND_LABEL[kind].unit}${
            detailOpen ? "" : " · ⏎ inspect"
          } · esc close`}
        </Text>
      </Text>
      {members.map((m, i) => {
        // The state glyph keeps the state colour (▸ running, ✓ done, ✗ failed);
        // the NAME wears the worker's own accent, so five same-role sub-agents are
        // still tellable apart — and match their lines in the transcript.
        const color = STATE_COLOR[m.state];
        const accent = m.state === "failed" ? "red" : agentColor(m.id);
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
            <Text color={color}>{mark(m.state)} </Text>
            <Text color={accent} bold={isSel}>
              {label}
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
            <Text color={sel.state === "failed" ? "red" : agentColor(sel.id)} bold>
              ⚙ {sel.name}
            </Text>
            <Text color="gray" dimColor>
              {` (${Math.min(selected, members.length - 1) + 1}/${members.length})`}
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
