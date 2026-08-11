import type { DiffRow } from "@arterm/core";
import { displayWidth, wrapToWidth } from "./terminalWidth.js";
import type { DisplayItem } from "./types.js";

/**
 * The copy-selection model, kept entirely separate from React.
 *
 * jcode owns its own screen buffer (ratatui), so it always knows the plain text
 * at any (row, column) and can map a mouse click straight onto it. Ink does not
 * give us that — it renders a rich tree and never tells us which character
 * landed in which cell. So we reproduce jcode's snapshot the one way that keeps
 * the highlight and the copied text identical BY CONSTRUCTION: we project the
 * transcript into the same flat, wrapped, plain-text lines that the selection
 * overlay renders, and resolve every mouse coordinate against THAT. The overlay
 * draws these exact strings, so what is highlighted is what is copied.
 *
 * This is the pure half: no React, no I/O, fully unit-tested. `App` owns the
 * mouse plumbing and the overlay; everything it needs to reason about a
 * selection lives here.
 */

/** One projected transcript line: the plain text of a single wrapped screen row. */
export interface ProjectedLine {
  text: string;
}

/** A point in the projected buffer: absolute line index and a column in display cells. */
export interface SelectionPoint {
  /** Index into the full projected line list (NOT the visible window). */
  line: number;
  /** Column in display cells from the line's left edge, clamped to the line width. */
  column: number;
}

export interface SelectionRange {
  start: SelectionPoint;
  end: SelectionPoint;
}

/** A left-margin prefix a renderer indents an item by, mirrored into the projection. */
const INDENT = "  ";

function toolMeta(item: Extract<DisplayItem, { kind: "tool" }>): string {
  // Mirrors MessageList's result-row meta join, minus the glyphs a copy has no
  // use for. Kept plain: the point is the words, not the decoration.
  const parts: string[] = [];
  if (item.ms !== undefined)
    parts.push(item.ms < 1000 ? `${Math.round(item.ms)}ms` : `${(item.ms / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

function diffRowText(r: DiffRow): string {
  if (r.kind === "hunk") return r.text;
  const marker = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
  return `${marker} ${r.text}`;
}

/**
 * Turn one transcript entry into its plain-text lines, in reading order. This
 * deliberately mirrors `ItemBody` in MessageList: same label headers, same
 * indentation, same content — but flattened to strings a human would want on
 * their clipboard, with the box-drawing and colour stripped.
 */
function itemToParagraphs(item: DisplayItem): string[] {
  switch (item.kind) {
    case "user": {
      const out = ["USER", item.text];
      if (item.images) out.push(`[image ×${item.images.count}]`);
      return out;
    }
    case "assistant":
      return ["ASSISTANT", item.text];
    case "tool": {
      if (item.diffRows && item.diffRows.length > 0) {
        return [`${item.path ?? "edit"}`, ...item.diffRows.map(diffRowText)];
      }
      if (item.output !== undefined && item.args === undefined) {
        const meta = toolMeta(item);
        return [`${INDENT}└─ ${item.output}${meta ? `  · ${meta}` : ""}`];
      }
      if (item.diff) {
        return item.diff.split("\n");
      }
      return [`${item.name}${item.args ? ` ${item.args}` : ""}`];
    }
    case "system":
      return [item.text];
    case "banner":
      return [`Arterm · ${item.provider} · ${item.model}`];
    case "help":
      return ["Commands (see /help)"];
    case "stats":
      return [
        `[↑${item.inTok} ↓${item.outTok} · ${item.rounds} round${item.rounds === 1 ? "" : "s"} · ${(item.ms / 1000).toFixed(1)}s]`,
      ];
  }
}

/**
 * Project the whole transcript into flat wrapped lines at a given width.
 *
 * A blank line separates entries, so a copied span that crosses two messages
 * keeps them apart — the same visual gap the bordered blocks give on screen.
 * `live` (the in-flight assistant text) is appended last so a selection can
 * include it mid-stream.
 */
export function projectTranscript(
  items: DisplayItem[],
  columns: number,
  live?: string,
): ProjectedLine[] {
  const width = Math.max(1, columns);
  const lines: ProjectedLine[] = [];
  const pushBlock = (paragraphs: string[]): void => {
    if (lines.length > 0) lines.push({ text: "" });
    for (const para of paragraphs) {
      for (const wrapped of wrapToWidth(para, width)) lines.push({ text: wrapped });
    }
  };
  for (const item of items) pushBlock(itemToParagraphs(item));
  if (live && live.length > 0) pushBlock(["ASSISTANT", live]);
  return lines;
}

/**
 * Map a mouse coordinate (viewport row, column) onto an absolute projected
 * point. `firstVisibleLine` is the index of the projected line drawn on the
 * overlay's top row, so `firstVisibleLine + row` is the absolute line. Returns
 * null for a click below the last line (the empty area), which is not a
 * selectable point.
 */
export function pointFromScreen(
  lines: ProjectedLine[],
  firstVisibleLine: number,
  row: number,
  column: number,
): SelectionPoint | null {
  const line = firstVisibleLine + row;
  if (line < 0 || line >= lines.length) return null;
  const width = displayWidth(lines[line]?.text ?? "");
  return { line, column: Math.max(0, Math.min(column, width)) };
}

/** Order two points so start <= end in (line, column) reading order. */
export function normalizeRange(a: SelectionPoint, b: SelectionPoint): SelectionRange {
  const before = a.line < b.line || (a.line === b.line && a.column <= b.column);
  return before ? { start: a, end: b } : { start: b, end: a };
}

/** Slice a single line's text between two display columns, on grapheme boundaries. */
function sliceByColumns(text: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return "";
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let col = 0;
  let out = "";
  for (const { segment } of seg.segment(text)) {
    const w = displayWidth(segment);
    // A grapheme is included when its START column is within [startCol, endCol).
    if (col >= startCol && col < endCol) out += segment;
    col += w;
    if (col >= endCol) break;
  }
  return out;
}

/**
 * The text a selection covers, joined with newlines. Mirrors a terminal's own
 * block selection: the first and last lines are cut at their columns, every
 * line between is whole.
 */
export function selectionText(lines: ProjectedLine[], range: SelectionRange): string {
  const { start, end } = range;
  if (start.line === end.line) {
    return sliceByColumns(lines[start.line]?.text ?? "", start.column, end.column);
  }
  const out: string[] = [];
  for (let i = start.line; i <= end.line; i++) {
    const text = lines[i]?.text ?? "";
    if (i === start.line) out.push(sliceByColumns(text, start.column, displayWidth(text)));
    else if (i === end.line) out.push(sliceByColumns(text, 0, end.column));
    else out.push(text);
  }
  return out.join("\n");
}

/**
 * For a given visible line index, the [startCol, endCol) span that is selected
 * on it, or null if the line is entirely outside the selection. Used by the
 * overlay to paint the highlight. `lineWidth` is the line's display width, so
 * a full-line selection (a middle line) reports the whole width.
 */
export function highlightSpanForLine(
  range: SelectionRange | null,
  line: number,
  lineWidth: number,
): { start: number; end: number } | null {
  if (!range) return null;
  const { start, end } = range;
  if (line < start.line || line > end.line) return null;
  const startCol = line === start.line ? start.column : 0;
  const endCol = line === end.line ? end.column : lineWidth;
  if (endCol <= startCol) return null;
  return { start: startCol, end: endCol };
}

/** A decoded SGR mouse report. Columns/rows are ZERO-based (the wire is 1-based). */
export interface MouseEvent {
  kind: "down" | "drag" | "up" | "wheel-up" | "wheel-down" | "move" | "other";
  /** Zero-based column from the left edge of the terminal. */
  col: number;
  /** Zero-based row from the top edge of the terminal. */
  row: number;
}

/**
 * Parse every SGR mouse report in a raw input chunk: `ESC[<b;x;yM` (press/drag/
 * motion) or `ESC[<b;x;ym` (release). A fast drag or scroll batches several
 * into one chunk, so this returns all of them in order.
 *
 * The button byte `b` encodes: low 2 bits = button (0 left), bit 5 (32) = a
 * motion/drag flag, bit 6 (64) = a wheel event (then low bit 0 = up, 1 = down).
 * The trailing `M`/`m` is press vs release. That is the whole of what a
 * selection needs to tell a click, a drag and a wheel tick apart.
 */
export function parseMouseEvents(input: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of input.matchAll(/\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const b = Number(m[1]);
    const col = Number(m[2]) - 1;
    const row = Number(m[3]) - 1;
    const release = m[4] === "m";
    if ((b & 64) !== 0) {
      out.push({ kind: (b & 1) === 0 ? "wheel-up" : "wheel-down", col, row });
      continue;
    }
    const button = b & 3;
    const motion = (b & 32) !== 0;
    if (release) out.push({ kind: "up", col, row });
    else if (motion) out.push({ kind: button === 3 ? "move" : "drag", col, row });
    else if (button === 0) out.push({ kind: "down", col, row });
    else out.push({ kind: "other", col, row });
  }
  return out;
}
