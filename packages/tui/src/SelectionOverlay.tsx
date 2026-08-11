import type React from "react";
import { Box, Text } from "./ink.js";
import { type ProjectedLine, type SelectionRange, highlightSpanForLine } from "./selection.js";
import { displayWidth } from "./terminalWidth.js";
import { theme } from "./theme.js";

/**
 * The copy-selection viewport.
 *
 * Shown in place of the rich transcript while selection mode is active. It
 * draws the SAME flat, plain-text projection that `selection.ts` resolves mouse
 * coordinates against — that is the whole point: the character the highlight
 * paints at (row, col) is exactly the one a copy at (row, col) yields, because
 * both read the one projection. A rich re-render here could not promise that,
 * since Ink never says which cell a styled glyph landed in.
 *
 * Each visible line is split into up to three `<Text>` spans (before / selected
 * / after) so the selected run gets an inverse wash while the rest stays plain.
 */
function sliceCols(text: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return "";
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let col = 0;
  let out = "";
  for (const { segment } of seg.segment(text)) {
    const w = displayWidth(segment);
    if (col >= startCol && col < endCol) out += segment;
    col += w;
    if (col >= endCol) break;
  }
  return out;
}

export function SelectionOverlay({
  lines,
  firstVisibleLine,
  viewportRows,
  columns,
  range,
}: {
  lines: ProjectedLine[];
  firstVisibleLine: number;
  viewportRows: number;
  columns: number;
  range: SelectionRange | null;
}): React.ReactElement {
  const rows: React.ReactElement[] = [];
  for (let r = 0; r < viewportRows; r++) {
    const lineIdx = firstVisibleLine + r;
    const text = lines[lineIdx]?.text ?? "";
    const width = displayWidth(text);
    const span = highlightSpanForLine(range, lineIdx, width);
    if (!span) {
      rows.push(
        <Text key={r} wrap="truncate-end">
          {text.length > 0 ? text : " "}
        </Text>,
      );
      continue;
    }
    const before = sliceCols(text, 0, span.start);
    const selected = sliceCols(text, span.start, span.end);
    const after = sliceCols(text, span.end, width);
    const wash = theme.supportsBackground ? theme.accent : undefined;
    rows.push(
      <Text key={r} wrap="truncate-end">
        {before}
        <Text {...(wash ? { backgroundColor: wash, color: "black" } : { inverse: true })}>
          {selected.length > 0 ? selected : " "}
        </Text>
        {after}
      </Text>,
    );
  }
  return (
    <Box width={columns} height={Math.max(1, viewportRows)} flexDirection="column">
      {rows}
    </Box>
  );
}
