/**
 * Tells a wheel tick apart from an ↑/↓ keypress — and throws the wheel away.
 *
 * This is the UNCAPTURED fallback, and it is reached only when the mouse is not
 * captured (`tui.mouse: false`, or /mouse) in fullscreen. The default path never
 * comes here: with SGR reporting a tick is `ESC[<64;x;yM`, which is not an arrow
 * at all, so ↑/↓ are read straight by the composer as the keypresses they are.
 *
 * Here the alternate screen is up and the terminal's own scrollback is out of
 * reach, so some terminals answer a wheel tick by synthesizing arrow keys
 * ("alternate scroll", DECSET 1007). That mode is never enabled by us in either
 * branch (see MultiApp's mode-assert effect) — this is the belt to that pair of
 * braces, for a terminal that translates regardless.
 *
 * What it does NOT do is *route* — a wheel tick used to scroll the transcript
 * through this path, which is where both halves of the reported bug came from:
 * three arrows per tick made the chat jump in three-line steps, and a terminal
 * configured for ONE line per tick sends exactly what a keypress sends, so
 * scrolling recalled prompts from history. A tick that means nothing can be
 * dropped; a tick that might mean either cannot be guessed. The wheel earns its
 * scroll back on a channel where the question does not arise, not here.
 *
 * The old timing router (hold a lone arrow 25 ms, see whether a companion
 * lands) is gone with it. It cost every history keypress that delay, and it was
 * a guess either way.
 */

export type ArrowDir = "up" | "down";

/**
 * The keypress a raw stdin chunk represents, or null when it is not one.
 *
 * Null covers both "not arrows at all" (typed text, a paste, any other key —
 * those belong to Ink's own parser) and "several arrows in one chunk", which no
 * keyboard produces: that is a wheel tick and the caller must ignore it rather
 * than pass it on.
 */
export function arrowKeypress(chunk: string): ArrowDir | null {
  const runs = parseArrowChunk(chunk);
  if (!runs || runs.length !== 1) return null;
  const only = runs[0];
  if (!only || only.count !== 1) return null;
  return only.dir;
}

/**
 * Parses a raw stdin chunk made purely of ↑/↓ arrow sequences (CSI "\x1b[A" or
 * SS3 "\x1bOA" style) into ordered same-direction runs. Returns null when the
 * chunk contains anything else — typed text, pastes, and other keys must never
 * be misrouted. Raw chunks are needed because Ink's keypress parser collapses a
 * batched multi-arrow chunk into a single upArrow event, hiding the count that
 * is the only thing telling a wheel tick from a keypress.
 */
export function parseArrowChunk(chunk: string): Array<{ dir: ArrowDir; count: number }> | null {
  // Split on the ESC byte instead of matching it in a regex (Biome flags control
  // chars in regexes); every sequence in a pure-arrow chunk starts with ESC.
  const esc = String.fromCharCode(27);
  if (!chunk.startsWith(esc)) return null;
  const parts = chunk.split(esc).slice(1);
  const runs: Array<{ dir: ArrowDir; count: number }> = [];
  for (const part of parts) {
    if (!/^(\[|O)[AB]$/.test(part)) return null;
    const dir: ArrowDir = part.endsWith("A") ? "up" : "down";
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) last.count += 1;
    else runs.push({ dir, count: 1 });
  }
  return runs.length > 0 ? runs : null;
}
