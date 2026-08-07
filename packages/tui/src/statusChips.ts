/**
 * Fitting a row of status chips into the columns that exist.
 *
 * The status bar used to fork on one breakpoint: below 84 columns it stacked
 * every group onto its own line, so a narrow terminal spent five rows on
 * chrome, and crossing the breakpoint re-laid the whole bar out. Chips replace
 * both behaviours — the row keeps a constant height and drops what does not
 * fit, in a stated order, saying how many it dropped.
 *
 * Pure functions: the width arithmetic is the part worth testing, and it should
 * not need a renderer to test it.
 */

import { displayWidth } from "./terminalWidth.js";

/** One measurable status-bar item. `text` is what it draws, for the arithmetic. */
export interface Chip {
  key: string;
  text: string;
}

/** Columns between two chips. */
export const CHIP_SEP = 3;

/**
 * How many leading chips fit in `budget` columns.
 *
 * Greedy from the left, which is why chip ORDER is the priority order: the
 * model you are talking to and how full its context is outrank the clock.
 * Never drops the first chip — a bar with nothing on it is worse than a bar
 * that overflows by two columns, and the first chip is the one that says which
 * program this is.
 */
export function planChipFit(widths: number[], budget: number, sep = CHIP_SEP): number {
  let used = 0;
  let keep = 0;
  for (const w of widths) {
    const cost = w + (keep > 0 ? sep : 0);
    if (keep > 0 && used + cost > budget) break;
    used += cost;
    keep += 1;
  }
  return Math.max(1, keep);
}

/**
 * Split chips into what is drawn and what is counted.
 *
 * `reserve` is for a right-anchored item (the version). It is subtracted up
 * front rather than measured at the end, because the alternative — laying out
 * left to right and hoping — is what made the version chip jitter every time
 * the counter beside it changed width.
 */
export function fitChips<T extends Chip>(
  chips: T[],
  columns: number,
  reserve = 0,
): { shown: T[]; hidden: number } {
  const budget = Math.max(0, columns - reserve);
  // Measured in columns, not code units: half these chips carry a glyph and
  // two of them carry user content (a branch name, a directory), where
  // `.length` is a guess that runs one column short per wide character.
  const keep = planChipFit(
    chips.map((c) => displayWidth(c.text)),
    budget,
  );
  return { shown: chips.slice(0, keep), hidden: chips.length - keep };
}
