import type { SddTaskState } from "@arterm/core";
import type React from "react";
import { agentColor } from "./agentColor.js";
import { Box, Text } from "./ink.js";
import { MonitorShell, panelWindow } from "./monitorShell.js";
import { STATE_COLOR, STATE_LABEL, stateMark } from "./taskState.js";
import { truncateDisplay } from "./terminalWidth.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

/** One team member's live cell on the swarm board. */
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
  /** Tokens this member has billed so far (summed from its bridged `usage`). */
  tokens?: number;
  /** The member's own context fill, bridged from its `context_usage`. */
  ctxUsed?: number;
  ctxWindow?: number;
  /** Tool calls made — the cheapest honest measure of "is it actually working". */
  steps?: number;
  /** Epoch ms the member last entered `running`; drives the live clock. */
  startedAt?: number;
  /** USD this member has billed, priced from the same catalog the budget uses. */
  cost?: number;
}

/**
 * The main agent's own spend, shown beside the fleet's.
 *
 * It is not a cell: the leader is not one of the tasks that can finish, its
 * live state is already the status bar's job, and giving it a cell would shift
 * every worker's index by one for no reading gain. What it does need is to be
 * *counted* — a board that totals only the workers makes a run look cheaper
 * than it was, and the leader is where the planning tokens go.
 */
export interface TeamBoardLeader {
  tokens?: number;
  cost?: number;
}

/** How many trailing feed lines the drill-down view shows. */
const DETAIL_LINES = 12;

/** Narrowest a swarm cell may get before the board drops to fewer columns. */
const MIN_CELL = 30;
/** More than three columns turns the cells into unreadable stubs. */
const MAX_COLS = 3;
/**
 * Grid rows drawn at once. The board lives in the bottom region, which every
 * repaint redraws, so an unbounded board pushes the transcript off the screen
 * one row at a time. Nine agents across three columns still fit; a twelfth
 * gets counted, not dropped silently.
 */
const MAX_GRID_ROWS = 3;

/** Which kind of run the board is showing — only the wording differs. */
export type TeamBoardKind = "team" | "fleet";

const KIND_LABEL: Record<TeamBoardKind, { title: string; unit: string }> = {
  team: { title: "team roster", unit: "member" },
  fleet: { title: "parallel workspace", unit: "subtask" },
};

/** Compact token count: 1.2k, 34k, 1.1M. */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Spend, at the precision the number deserves. Sub-cent amounts keep four
 * decimals because that is the range a single worker lives in and `$0.00`
 * would read as free; past a cent, two decimals are what anyone acts on.
 */
export function fmtCost(usd: number): string {
  if (usd <= 0) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Wall time since a member started, at the precision that is actually useful:
 * seconds while you are watching it spin up, minutes once it has settled in.
 */
export function fmtElapsed(ms: number): string {
  if (ms < 0) return "0s";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Five-cell context meter — the shape reads before the number does. */
function ctxMeter(pct: number): string {
  const w = 5;
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return glyphs.meterFull.repeat(filled) + glyphs.meterEmpty.repeat(w - filled);
}

/**
 * A ramp, not a threshold. One red line at 80% says nothing until the moment
 * it says everything; a run climbing through 40 → 60 → 75 is information you
 * can act on while there is still room to act.
 */
function ctxColor(pct: number): string {
  if (pct >= 80) return theme.error;
  if (pct >= 65) return theme.warn;
  if (pct >= 50) return "peach";
  if (pct >= 25) return theme.success;
  return theme.accent;
}

/**
 * One agent's cell: two lines, five facts.
 *
 *   ❯03 chimera-review        ● LIVE 9m52s
 *      ⚙ read            1.2kt ███░░ 61%
 *
 * The right edge of the second line is reserved for the context meter on
 * purpose — it is the number that decides whether a worker's next answer is
 * worth reading, and a column of meters can be scanned in one pass in a way a
 * column of prose cannot. The state is spelled out next to its glyph because
 * colour is the one channel that does not survive a screenshot, a colourblind
 * reader, or a terminal with a palette of its own.
 *
 * Each line's two halves are placed by flexbox (`justifyContent="space-between"`,
 * left shrinkable and right fixed) rather than by padding a string to a computed
 * width — nothing here measures text itself. `.length` is not the width: Ink
 * renders `⚙`, `●` and `✉` as TWO columns each (East Asian ambiguous), so a
 * hand-padded line overflowed by exactly the number of glyphs in it and
 * `truncate-end` ate the right edge — precisely where the context percentage
 * lives. Substituting a width GUESS for `.length` only moves the error: counting
 * block-drawing as wide starved the activity text down to one ellipsis. The
 * layout engine already knows the real widths, so it does both jobs.
 */
function Cell({
  member,
  index,
  width,
  selected,
  now,
}: {
  member: TeamBoardMember;
  index: number;
  width: number;
  selected: boolean;
  now: number;
}): React.ReactElement {
  const m = member;
  const accent = m.state === "failed" ? theme.error : agentColor(m.id);
  const running = m.state === "running";

  // Line 1 — identity on the left, liveness and wall time on the right.
  const idx = String(index).padStart(2, "0");
  const elapsed = m.startedAt ? fmtElapsed(now - m.startedAt) : "";
  const status = `${stateMark(m.state)} ${STATE_LABEL[m.state]}${elapsed ? ` ${elapsed}` : ""}`;
  const headText = `${selected ? glyphs.select : " "}${idx} ${m.name}${m.adhoc ? "*" : ""}`;

  // Line 2 — what it is doing on the left, what it has spent on the right.
  const pct =
    m.ctxWindow && m.ctxUsed ? Math.min(100, Math.round((m.ctxUsed / m.ctxWindow) * 100)) : 0;
  // The meter is coloured by fill and the counters are not, so they are built
  // as two strings rather than one joined list — a single list would have to be
  // re-split at render time, which is where the token count went missing.
  //
  // What the right column gives up as it narrows, in order. Cost goes first —
  // not because it matters least, but because the header already totals it,
  // while the activity text on the left has no second home. A three-across
  // grid squeezes hardest, and there the cell should still say what the worker
  // is DOING; measured, `⚙ r… 1.2kt $0.0031` is not a cell anyone can read.
  const counters = [
    m.steps && width >= 52 ? `${m.steps}${glyphs.tool}` : "",
    m.tokens ? `${fmtTok(m.tokens)}t` : "",
    m.cost && width >= 44 ? fmtCost(m.cost) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const meter = pct > 0 ? `${ctxMeter(pct)} ${String(pct).padStart(2)}%` : "";
  const doing = running ? (m.activity ?? "· starting") : (m.task ?? m.description);
  const bodyText = `   ${doing}`;

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" color={selected ? theme.monitor.swarm : accent} bold={selected}>
            {headText}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={STATE_COLOR[m.state]} bold={running}>
            {status}
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Text
            wrap="truncate-end"
            color={running ? theme.accent : theme.textMuted}
            dimColor={!running}
          >
            {bodyText}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            <Text color={theme.textMuted} dimColor>
              {counters}
              {counters && meter ? " " : ""}
            </Text>
            <Text color={ctxColor(pct)}>{meter}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Live board for a fan-out run: one CELL per worker, laid out as a swarm grid so
 * nine concurrent agents fit on a screen instead of nine stacked rows pushing the
 * transcript off it. Updated in place by `team_member_state` (assignment + state)
 * and `team_member_event` (activity, tokens, context).
 *
 * Tab steps to the next cell (the one binding no terminal can mangle), as do
 * Ctrl+↑/↓ and Alt+↑/↓ where the terminal transmits them. Enter on an empty prompt
 * opens the selected cell's activity feed (drill-down), and while that feed is open
 * plain ↑/↓ step cells too — inspecting is a mode, so the bare arrows are free
 * there; with it closed they stay prompt history. Esc closes it. Rendered in the
 * bottom region, like the /sdd kanban.
 *
 * Both fan-out modes render here: a /team run's cells are its standing roster
 * (stable across rounds), a parallel run's cells are the current round's
 * subtasks (replaced each round).
 */
export function TeamBoard({
  members,
  columns,
  selected,
  detailOpen,
  feed,
  kind = "team",
  now = Date.now(),
  leader,
  arrowsStepRows = false,
}: {
  members: TeamBoardMember[];
  /** The main agent's own spend, named beside the fleet's. */
  leader?: TeamBoardLeader;
  /** Terminal width, used to size the grid. */
  columns: number;
  /** Index of the cell the Ctrl+↑/↓ selection is on. */
  selected: number;
  /** True when the selected cell's activity feed is expanded. */
  detailOpen: boolean;
  /** The selected cell's feed lines (newest last). */
  feed: string[];
  /** Team roster vs. parallel-round subtasks — wording only. */
  kind?: TeamBoardKind;
  /** Clock for the live elapsed times; injected so tests are deterministic. */
  now?: number;
  /**
   * Whether bare ↑↓ step rows, which is only true when the arrow router is NOT
   * the one reading them. Under the router a wheel tick and a keypress arrive as
   * the same bytes, so bare arrows are left to the transcript and the prompt —
   * and a footer that still advertised them would be teaching a binding that
   * does nothing while quietly scrolling the transcript instead.
   */
  arrowsStepRows?: boolean;
}): React.ReactElement {
  const done = members.filter((m) => m.state === "done").length;
  const failed = members.filter((m) => m.state === "failed").length;
  const live = members.filter((m) => m.state === "running").length;
  const sel = members[Math.min(selected, members.length - 1)];
  const selIndex = Math.min(selected, members.length - 1);

  // The grid: as many columns as fit at a readable cell width, never more than
  // the member count (two agents must not render as two thirds of a row).
  const inner = Math.max(MIN_CELL, columns - 4);
  const cols = Math.max(1, Math.min(MAX_COLS, members.length, Math.floor(inner / MIN_CELL)));
  const cellW = Math.floor((inner - (cols - 1) * 2) / cols);
  const allRows: TeamBoardMember[][] = [];
  for (let i = 0; i < members.length; i += cols) allRows.push(members.slice(i, i + cols));
  // Window on the selection so stepping past the last visible cell scrolls the
  // grid instead of appearing to do nothing, and count what is off-screen: a
  // board showing nine of twelve reads as the whole swarm.
  const grid = panelWindow(allRows, Math.floor(selIndex / cols), MAX_GRID_ROWS);
  const hidden = grid.before * cols + grid.after * cols;

  // Aggregates: the swarm as one number each, so "is anything happening" is
  // answerable without reading nine cells. The leader's share is named
  // separately rather than folded in — "the fleet cost $0.21" and "this run
  // cost $0.29, most of it planning" are different facts.
  const fleetTokens = members.reduce((sum, m) => sum + (m.tokens ?? 0), 0);
  const fleetCost = members.reduce((sum, m) => sum + (m.cost ?? 0), 0);

  return (
    <MonitorShell
      glyph={glyphs.fleet}
      title="AGENT SWARM"
      kicker={KIND_LABEL[kind].title}
      accent={theme.monitor.swarm}
      footer={`${detailOpen && arrowsStepRows ? "↑↓/⇥" : "⇥/^↑↓"} ${KIND_LABEL[kind].unit}${
        detailOpen ? "" : " · ⏎ inspect"
      } · esc close`}
      right={
        <>
          <Text color={theme.textMuted}>
            {"   "}
            {done}/{members.length} done
            {failed ? ` · ${failed} failed` : ""}
          </Text>
          <Text color={live > 0 ? theme.success : theme.textMuted}>
            {"   "}
            {glyphs.running} {live} LIVE
          </Text>
          {fleetTokens > 0 ? <Text color={theme.textMuted}> · {fmtTok(fleetTokens)}t</Text> : null}
          {fleetCost > 0 ? <Text color={theme.textMuted}> · {fmtCost(fleetCost)}</Text> : null}
          {leader && (leader.cost ?? 0) > 0 ? (
            <Text color={theme.textMuted} dimColor>
              {" +"}
              {fmtCost(leader.cost ?? 0)} lead
            </Text>
          ) : null}
        </>
      }
    >
      {grid.window.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: grid rows are positional
        <Box key={r} flexDirection="row" marginTop={r === 0 ? 1 : 0}>
          {row.map((m, c) => {
            const index = (grid.offset + r) * cols + c;
            return (
              <Box key={m.id} marginRight={c === row.length - 1 ? 0 : 2}>
                <Cell
                  member={m}
                  index={index}
                  width={cellW}
                  selected={index === selIndex}
                  now={now}
                />
              </Box>
            );
          })}
        </Box>
      ))}
      {hidden > 0 ? (
        <Text color={theme.textMuted} dimColor>
          {" "}
          {grid.before > 0 ? "↑" : "↓"} {hidden} more agent{hidden > 1 ? "s" : ""}
        </Text>
      ) : null}
      {detailOpen && sel ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text color={sel.state === "failed" ? theme.error : agentColor(sel.id)} bold>
              {glyphs.tool} {sel.name}
            </Text>
            <Text color={theme.textMuted} dimColor>
              {` (${selIndex + 1}/${members.length})`}
            </Text>
            <Text color={theme.textMuted}>
              {" "}
              — {truncateDisplay(sel.task ?? sel.description, Math.max(10, columns - 20))}
            </Text>
            {sel.filesChanged ? (
              <Text color={theme.success}>
                {" "}
                {glyphs.filesChanged}
                {sel.filesChanged}
              </Text>
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
