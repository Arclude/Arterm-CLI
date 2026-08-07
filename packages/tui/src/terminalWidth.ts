/**
 * Terminal-column measurement.
 *
 * `String.length` counts UTF-16 code units, which is not what a terminal draws.
 * An emoji is two columns, a combining mark is zero, and a ZWJ sequence is one
 * two-column grapheme made of several code points. The TUI already paid for
 * this: `TeamBoard`'s cells had to abandon string padding entirely because Ink
 * renders `⚙`, `●` and `✉` as two columns each, so every hand-padded line
 * overflowed by exactly the number of glyphs in it. Padding is fine — measuring
 * with `.length` is not.
 *
 * Everything that pads, truncates, or budgets width should go through
 * `displayWidth`.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the escape sequence being matched
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const COMBINING_RE = /\p{Mark}/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** East Asian Wide / Fullwidth ranges — the code points a terminal draws twice. */
function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b2ff) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

/** Strip SGR/CSI escapes so a styled string measures as what it draws. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/** How many terminal columns `value` occupies. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(stripAnsi(value))) {
    // A joined emoji (family, profession, skin tone) is several code points
    // drawn as one two-column grapheme; measuring its parts would triple it.
    if (EMOJI_RE.test(segment)) {
      width += 2;
      continue;
    }
    for (const char of segment) {
      const code = char.codePointAt(0) ?? 0;
      // C0/C1 controls draw nothing.
      if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
      // Combining marks, variation selectors and ZWJ attach to the glyph
      // before them and add no width of their own.
      if (COMBINING_RE.test(char) || code === 0xfe0e || code === 0xfe0f || code === 0x200d) {
        continue;
      }
      width += isWideCodePoint(code) ? 2 : 1;
    }
  }
  return width;
}

/** Pad `value` on the right to exactly `width` columns (never truncates). */
export function padEndDisplay(value: string, width: number): string {
  const w = displayWidth(value);
  return w >= width ? value : value + " ".repeat(width - w);
}

/**
 * Truncate to `width` columns with a trailing ellipsis. The ellipsis costs one
 * column, so the result is always at most `width` — the property every caller
 * assumes and `.slice(0, n) + "…"` quietly breaks on a wide glyph.
 */
export function truncateDisplay(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  let out = "";
  let used = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    const w = displayWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

/**
 * Truncate from the middle, keeping both ends. For a path or a command the
 * informative parts are the head (what it is) and the tail (which file) — a
 * tail-cut throws away the second one.
 */
export function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return "…";
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const graphemes = [...SEGMENTER.segment(value)].map((s) => s.segment);
  let left = "";
  let leftW = 0;
  for (const g of graphemes) {
    const w = displayWidth(g);
    if (leftW + w > head) break;
    left += g;
    leftW += w;
  }
  let right = "";
  let rightW = 0;
  for (let i = graphemes.length - 1; i >= 0; i--) {
    const g = graphemes[i] as string;
    const w = displayWidth(g);
    if (rightW + w > tail) break;
    right = g + right;
    rightW += w;
  }
  return `${left}…${right}`;
}
