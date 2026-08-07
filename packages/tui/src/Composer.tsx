/**
 * The composer's frame, drawn as text rather than as a border.
 *
 *   top:    ╭─ ◆ ARTERM ──────────────── ⠹ working 12.4s ─╮
 *   body:   │ › refactor auth.ts to async/await           │
 *   bottom: ╰─ Enter send · ? help · Esc cancels ─────────╯
 *
 * Ink can draw a box, and this used to be one — but a border is a single
 * colour and carries no text, so the two things worth putting on the frame had
 * nowhere to go: which program is asking, and whether it is working right now.
 * A rail is a string, so it holds a spinner on the right and a hint along the
 * bottom without spending two more rows of a small terminal on them.
 *
 * Drawing it makes the wrapping ours as well: Ink wraps inside a `<Text>`, and
 * this code has to know where every row ends to close it with a `│`.
 * `wrapToWidth` does that on grapheme boundaries, and every row is padded to
 * the same inner width so the right-hand rail is a straight column whatever is
 * typed into it.
 *
 * Two widths are reserved rather than measured after the fact, because both
 * change while the frame is on screen: the status slot (a spinner plus a clock
 * that counts `9.9s → 10s → 1m05s`) and the trailing hint on the last row. Laid
 * out left to right and closed at the end, the corner would move every second.
 *
 * Nothing here measures with `.length` — a two-column glyph pasted into the
 * prompt would push the closing corner past the edge, which wraps the line,
 * which pushes a transcript row into the scrollback on every repaint.
 */

import type React from "react";
import { ELAPSED_W, Elapsed, Spinner } from "./Spinner.js";
import { Box, Text } from "./ink.js";
import { displayWidth, truncateDisplay, wrapToWidth } from "./terminalWidth.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

/** Rows of typing shown before the body scrolls internally. */
const MAX_BODY_ROWS = 10;

/** One space, the spinner, ` working `, and the padded clock. */
const STATUS_W = 1 + 1 + 9 + ELAPSED_W;

const PLACEHOLDER = " message… (type ? for help)";

export interface ComposerFrameProps {
  value: string;
  /** Ghost-text completion for a slash command, drawn after the caret. */
  suggestion?: string | undefined;
  columns: number;
  /** Frame colour — mirrors the permission mode, as the border used to. */
  color: string;
  /** Epoch ms the running turn began, or undefined when idle. */
  workingSince?: number | undefined;
  /** The bottom rail's text. */
  hint: string;
}

export function ComposerFrame({
  value,
  suggestion,
  columns,
  color,
  workingSince,
  hint,
}: ComposerFrameProps): React.ReactElement {
  // The content width between "│ " and " │".
  const inner = Math.max(8, columns - 4);
  const working = workingSince !== undefined;

  const title = `${glyphs.brand} ARTERM`;
  const topFill = "─".repeat(Math.max(0, inner - displayWidth(title) - (working ? STATUS_W : 0)));

  const caret = `${glyphs.prompt} `;
  const rows = wrapToWidth(`${caret}${value}`, inner - 1);
  const shown = rows.slice(-MAX_BODY_ROWS);
  const scrolled = rows.length - shown.length;

  // The tail rides on the last row and is reserved out of that row's padding.
  const tail = suggestion ? `${suggestion}  ${glyphs.tab} tab` : value === "" ? PLACEHOLDER : "";

  // The scroll counter goes INSIDE the rail, not after its closing corner:
  // the row is exactly `columns` wide and truncated at that width, so anything
  // written past the corner is written into nothing.
  const scrollNote = scrolled > 0 ? ` ↑${scrolled} more ` : "";
  const bottomLabel = ` ${truncateDisplay(hint, Math.max(4, inner - 4 - scrollNote.length))} `;
  const bottomFill = "─".repeat(
    Math.max(0, inner - displayWidth(bottomLabel) - displayWidth(scrollNote)),
  );

  return (
    <Box flexDirection="column" width={columns}>
      <Text wrap="truncate">
        <Text color={color}>{"╭─"}</Text>
        <Text color={color} bold>
          {title}
        </Text>
        <Text color={color}>{topFill}</Text>
        {working ? (
          <Text>
            {" "}
            <Spinner />
            <Text color={theme.warn}> working </Text>
            <Elapsed since={workingSince as number} minWidth={ELAPSED_W} />
          </Text>
        ) : null}
        <Text color={color}>{"─╮"}</Text>
      </Text>
      {shown.map((row, i) => {
        const isLast = i === shown.length - 1;
        // cursor (1) + tail, on the last row only.
        const used = displayWidth(row) + (isLast ? 1 + displayWidth(tail) : 0);
        const pad = " ".repeat(Math.max(0, inner - used));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: wrapped rows are positional
          <Text key={i} wrap="truncate">
            <Text color={color}>{"│ "}</Text>
            {i === 0 ? (
              <>
                <Text color={theme.brandAccent} bold>
                  {caret}
                </Text>
                <Text>{row.slice(caret.length)}</Text>
              </>
            ) : (
              <Text>{row}</Text>
            )}
            {isLast ? (
              <>
                <Text color={theme.accent}>{glyphs.cursor}</Text>
                {tail ? (
                  <Text color={theme.textMuted} dimColor={Boolean(suggestion)}>
                    {tail}
                  </Text>
                ) : null}
              </>
            ) : null}
            <Text color={color}>{`${pad} │`}</Text>
          </Text>
        );
      })}
      <Text wrap="truncate">
        <Text color={color}>{"╰─"}</Text>
        <Text color={theme.textMuted} dimColor>
          {bottomLabel}
        </Text>
        {scrollNote ? (
          <Text color={theme.textMuted} dimColor>
            {scrollNote}
          </Text>
        ) : null}
        <Text color={color}>{bottomFill}</Text>
        <Text color={color}>{"─╯"}</Text>
      </Text>
    </Box>
  );
}
