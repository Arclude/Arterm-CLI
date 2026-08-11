import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type React from "react";
import { Box, Text } from "./ink.js";
import { CHIP_SEP, type Chip, fitChips } from "./statusChips.js";
import { truncateDisplay } from "./terminalWidth.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

export type Status = "idle" | "thinking" | "tool";

interface Props {
  provider: string;
  model: string;
  status: Status;
  inTok: number;
  outTok: number;
  ctxUsed: number;
  ctxWindow: number;
  toolCount: number;
  mode: string;
  /** Terminal width in columns; drives the responsive layout. */
  columns: number;
  /**
   * Alternate-screen mode. Only consulted when the mouse is NOT captured: there
   * the wheel belongs to the terminal, which has a scrollback to move in classic
   * mode and nothing to move in fullscreen, so PgUp/PgDn become the scroll.
   * Advertising "wheel scrolls" in a window where it does nothing is how a
   * working build reads as broken.
   */
  fullscreen?: boolean;
  /**
   * Mouse capture is on, so the wheel scrolls the chat here and plain drag no
   * longer selects — Shift+drag does. Both halves of that trade have to be on
   * screen, or the first attempt to copy a line reads as a broken terminal.
   */
  mouseCapture?: boolean;
  /** Session working directory (multi-session: not necessarily process.cwd()). */
  cwd?: string;
  /** Multi-session summary for the badge: 1-based index, total, busy background count. */
  sessions?: { index: number; count: number; busyBackground: number };
  /**
   * Background processes this session started and has not stopped.
   *
   * On the LIVE row rather than the place row, and ahead of the model: a dev
   * server holding a port is a fact about the machine right now, and until this
   * the only way to learn it was to type `/ps` — which nobody does when they do
   * not already suspect it.
   */
  bgProcesses?: number;
  /**
   * Where the fallback chain landed, when it has moved off the configured model.
   *
   * Without it the bar keeps naming the model you *chose* while a different one
   * is answering — the `↪` notice scrolls away and nothing on screen says your
   * replies are now coming from somewhere else.
   */
  fallbackTo?: { provider: string; model: string } | null;
  /**
   * The CLI's version string, threaded down from the binary. The bar used to
   * hold its own hard-coded copy, and it drifted: v0.4.0 shipped with the
   * footer still saying v0.3.3 because the release bump missed the duplicate.
   * One source (main.ts VERSION, next to the package.json the release DOES
   * bump) — or nothing.
   */
  version?: string;
}

function gitBranch(dir: string): string {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/ref: refs\/heads\/(.+)/);
    return m?.[1] ?? head.slice(0, 7);
  } catch {
    return "—";
  }
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function bar(pct: number, width: number): string {
  const w = Math.max(1, width);
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/**
 * Truncate to a column budget, marking the cut with an ellipsis. Measured in
 * terminal columns rather than code units: a branch name with an emoji, a cwd
 * with CJK, or the bar's own `⚙` are all wider than `.length` claims, and the
 * status bar is where an overflow costs a wrapped line.
 */
function clip(s: string, max: number): string {
  return truncateDisplay(s, max);
}

/** Status-bar color for each permission mode. */
function modeColor(mode: string): string {
  switch (mode) {
    case "YOLO":
      return theme.error;
    case "PLAN":
      return theme.accent;
    case "AUTO":
      return theme.success;
    default:
      return theme.warn;
  }
}

/**
 * The same fill ramp the swarm board's cells and the /context panel use, so a
 * worker at 70% and the session at 70% are the same colour wherever they are
 * read. One red line at 80% says nothing until the moment it says everything.
 */
function ctxColor(pct: number): string {
  if (pct >= 80) return theme.error;
  if (pct >= 65) return theme.warn;
  if (pct >= 50) return "peach";
  if (pct >= 25) return theme.success;
  return theme.accent;
}

/**
 * The permission-mode badge in the footer. YOLO disables every permission prompt,
 * so it gets a filled warning badge (⚠) — unmistakably distinct from the plain
 * bracketed ASK / AUTO / PLAN labels, which only differ by color.
 */
function ModeBadge({ mode }: { mode: string }): React.ReactElement {
  // A filled badge is the loudest thing the bar can say, and it depends on a
  // background the terminal may strip. Where it would, the badge falls back to
  // a bold word rather than to a stray pair of padding spaces — the mode is
  // exactly the fact that must survive a downgrade.
  const filled = (bg: string, label: string): React.ReactElement =>
    theme.supportsBackground ? (
      <Text backgroundColor={bg} color="whiteBright" bold>
        {` ${label} `}
      </Text>
    ) : (
      <Text color={bg} bold>
        {label}
      </Text>
    );
  if (mode === "YOLO") return filled(theme.error, `${glyphs.warning} YOLO`);
  // Shift+Tab's armed state: prompts are goals and permissions are yolo — at
  // least as consequential as YOLO, so it gets the same filled-badge treatment.
  if (mode === "AUTONOMOUS") return filled(theme.monitor.swarm, `${glyphs.brand} AUTONOMOUS`);
  return (
    <Text color={modeColor(mode)} bold>
      [{mode}]
    </Text>
  );
}

export function StatusBar({
  bgProcesses,
  provider,
  model,
  status,
  inTok,
  outTok,
  ctxUsed,
  ctxWindow,
  toolCount,
  mode,
  columns,
  fullscreen = false,
  mouseCapture = false,
  cwd: cwdProp,
  version,
  sessions,
  fallbackTo,
}: Props): React.ReactElement {
  // Capture answers both halves at once: the wheel scrolls, and the gesture it
  // took over has to be named in the same breath.
  const scrollHint = mouseCapture
    ? "wheel scrolls"
    : fullscreen
      ? "PgUp/PgDn scrolls"
      : "wheel scrolls";
  // With capture on, the terminal's own drag is gone; ⇧drag is the terminal's
  // bypass, and Ctrl+S is the app's own selection mode (drag to select, release
  // to copy). Name the app's, which is the one that also copies.
  const selectHint = mouseCapture ? "^S selects text" : "drag selects text";
  // Name both ends of the switch: "backup" alone would look like the model was
  // changed, when in fact the configured one is still the one that failed.
  const answering =
    fallbackTo && (fallbackTo.provider !== provider || fallbackTo.model !== model)
      ? `${model}↪${fallbackTo.provider === provider ? fallbackTo.model : `${fallbackTo.provider}/${fallbackTo.model}`}`
      : model;
  // Computed inline (no per-second timer) so the UI does not repaint while idle.
  const clock = new Date().toLocaleTimeString();
  const dir = cwdProp ?? process.cwd();
  const branch = gitBranch(dir);
  const cwd = basename(dir);
  const pct = ctxWindow ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0;
  const statusColor = status === "idle" ? "green" : "yellow";

  // The meter takes a share of the pane rather than a fixed ten cells: at 44
  // columns a ten-cell bar is a quarter of the row spent on a shape, and the
  // number beside it is the part that survives being small.
  const meterW = Math.max(4, Math.min(10, Math.floor(columns / 9)));
  const words = theme.noColor;

  // The two rows' chips, in priority order — `fitChips` is greedy from the
  // left, so this list IS the ranking. What the session is talking to and how
  // full its context is outrank where it is running and what time it is.
  const liveChips: RenderChip[] = [
    {
      key: "brand",
      text: `▌ARTERM${version ? ` v${version}` : ""}`,
      node: (
        <>
          <Text color={theme.accent} bold>
            ▌ARTERM
          </Text>
          {version ? <Text color={theme.textMuted}> v{version}</Text> : null}
        </>
      ),
    },
    {
      key: "status",
      text: `${glyphs.running} ${status}`,
      node: (
        <Text color={statusColor}>
          {glyphs.running} {status}
        </Text>
      ),
    },
    // Mode is its own chip, ahead of the model, because it is the one fact on
    // the bar that changes what the agent is ALLOWED to do. Riding along with
    // the model name, it was dropped together with it — so an 84-column
    // terminal could be in YOLO and not say so.
    {
      key: "mode",
      text:
        mode === "YOLO"
          ? ` ${glyphs.warning} YOLO `
          : mode === "AUTONOMOUS"
            ? ` ${glyphs.brand} AUTONOMOUS `
            : `[${mode}]`,
      node: <ModeBadge mode={mode} />,
    },
    {
      key: "context",
      // Percent AND absolutes: a percentage alone cannot tell 25% of an 8k
      // window from 25% of a 1M one, and those are different situations.
      text: `ctx ${bar(pct, meterW)} ${pct}% ${fmtTok(ctxUsed)}/${fmtTok(ctxWindow || 0)}`,
      node: (
        <>
          <Text color={theme.textMuted}>ctx </Text>
          <Text color={ctxColor(pct)}>{bar(pct, meterW)}</Text>
          <Text color={theme.textMuted}>
            {" "}
            {pct}% {fmtTok(ctxUsed)}/{fmtTok(ctxWindow || 0)}
          </Text>
        </>
      ),
    },
    {
      key: "model",
      text: `${provider}/${answering}`,
      node: (
        <Text color={fallbackTo ? theme.warn : theme.monitor.swarm}>
          {provider}/{answering}
        </Text>
      ),
    },
    {
      key: "tokens",
      text: `↑${fmtTok(inTok)} ↓${fmtTok(outTok)}`,
      node: (
        <Text color={theme.textMuted}>
          ↑{fmtTok(inTok)} ↓{fmtTok(outTok)}
        </Text>
      ),
    },
    // Last on the row on purpose: it is the only chip about sessions other than
    // this one, and it used to sit ahead of the context meter — which meant a
    // second open session pushed the gauge off a 110-column bar.
    ...(sessions && sessions.count > 1
      ? [
          {
            key: "sessions",
            text: `${glyphs.sessions} ${sessions.index}/${sessions.count}${
              sessions.busyBackground > 0 ? ` · ${sessions.busyBackground} busy` : ""
            }`,
            node: (
              <Text color={theme.accent}>
                {glyphs.sessions} {sessions.index}/{sessions.count}
                {sessions.busyBackground > 0 ? ` · ${sessions.busyBackground} busy` : ""}
              </Text>
            ),
          },
        ]
      : []),
  ];

  if (bgProcesses && bgProcesses > 0) {
    const label = `${bgProcesses} bg`;
    liveChips.splice(3, 0, {
      key: "bg",
      text: `${glyphs.tool} ${label}`,
      node: (
        <Text color={theme.warn}>
          {glyphs.tool} {label}
        </Text>
      ),
    });
  }

  const placeChips: RenderChip[] = [
    {
      key: "cwd",
      text: `${glyphs.folder} ${cwd}`,
      node: (
        <Text color={theme.warn} bold>
          {glyphs.folder} {cwd}
        </Text>
      ),
    },
    {
      key: "branch",
      text: `${glyphs.gitBranch} ${branch}`,
      node: (
        <Text color={theme.success}>
          {glyphs.gitBranch} {branch}
        </Text>
      ),
    },
    {
      key: "tools",
      text: `${glyphs.tool} ${toolCount} tools`,
      node: (
        <Text color={theme.textMuted}>
          {glyphs.tool} {toolCount} tools
        </Text>
      ),
    },
    {
      key: "clock",
      text: `${glyphs.clock} ${clock}`,
      node: (
        <Text color={theme.textMuted}>
          {glyphs.clock} {clock}
        </Text>
      ),
    },
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <ChipRow chips={liveChips} columns={columns} words={words} />
      <ChipRow chips={placeChips} columns={columns} words={words} />
      <Text color={theme.textMuted} dimColor wrap="truncate">
        {clip(
          `Enter send · ↑↓ history · ← sessions · ^←/^→ switch · ^X close · ${scrollHint} · ${selectHint} · ? help · ^C quit`,
          columns,
        )}
      </Text>
    </Box>
  );
}

/** A chip that can be measured and drawn: the arithmetic uses `text`. */
interface RenderChip extends Chip {
  node: React.ReactNode;
}

/**
 * One row of chips, constant height.
 *
 * The bar used to fork at 84 columns and stack every group onto its own line —
 * a narrow terminal spent five rows on chrome, and dragging across the
 * breakpoint re-laid out the whole thing. A row that drops its tail and says
 * how much it dropped keeps a fixed height at every width, which is what the
 * bottom region needs: it is redrawn on every repaint, and a region that
 * changes height leaks rows into the scrollback.
 */
function ChipRow({
  chips,
  columns,
  words,
}: {
  chips: RenderChip[];
  columns: number;
  words: boolean;
}): React.ReactElement {
  const { shown, hidden } = fitChips(chips, columns, hidden0(chips, columns));
  return (
    <Text wrap="truncate">
      {shown.map((chip, i) => (
        <Text key={chip.key}>
          {i > 0 ? (
            <Text color={theme.textMuted} dimColor>
              {words ? " · " : " │ "}
            </Text>
          ) : null}
          {chip.node}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.textMuted} dimColor>
          {" "}
          +{hidden}
        </Text>
      ) : null}
    </Text>
  );
}

/**
 * Columns to hold back for the overflow marker. Reserved up front rather than
 * discovered at the end: a row that fits exactly, then appends `+2`, is a row
 * that wraps — and one wrapped chrome line pushes a transcript row into the
 * scrollback on every repaint.
 */
function hidden0(chips: RenderChip[], columns: number): number {
  const total = chips.reduce((sum, c) => sum + c.text.length, 0) + (chips.length - 1) * CHIP_SEP;
  return total > columns ? 4 : 0;
}
