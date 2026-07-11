/**
 * Tells wheel-generated ↑/↓ apart from keyboard ↑/↓, so the prompt keeps
 * shell-style history while the mouse wheel scrolls the transcript — WITHOUT
 * capturing the mouse (SGR capture eats click-drag, breaking native
 * select-to-copy; see the App effect that enables alternate scroll instead).
 *
 * With the alternate screen active and mouse reporting off, the terminal's
 * "alternate scroll" mode (DECSET 1007) translates each wheel tick into arrow
 * key sequences. Two observable differences from a human keypress:
 *   - one tick usually arrives as ONE stdin chunk holding SEVERAL arrows
 *     ("\x1b[A\x1b[A\x1b[A" — the system wheel-lines setting, typically 3),
 *     while a keypress is a single lone sequence per chunk;
 *   - ticks of a continuous scroll follow each other within a few ms, while
 *     keyboard auto-repeat stays ≥ ~30 ms apart.
 * So: a multi-arrow chunk scrolls immediately; a lone arrow is held for
 * `windowMs` and becomes history navigation unless a second lone arrow of the
 * same direction lands inside the window (then the run is a wheel). Wheel
 * classification stays sticky for `stickyMs` so the rest of a burst scrolls
 * without the hold-back delay.
 */

export type ArrowDir = "up" | "down";

export interface ArrowRouterOptions {
  onHistory: (dir: ArrowDir) => void;
  onScroll: (dir: ArrowDir, lines: number) => void;
  /** How long a lone arrow waits for a companion before counting as a keypress. */
  windowMs?: number;
  /** How long after wheel activity lone arrows keep scrolling (mid-burst). */
  stickyMs?: number;
}

export interface ArrowRouter {
  /** Feed one same-direction run of arrows (count ≥ 1) from a stdin chunk. */
  feed(dir: ArrowDir, count: number): void;
  /** Cancels the pending hold-back timer (call on unmount). */
  dispose(): void;
}

/** Below keyboard auto-repeat (~33 ms) but above wheel-burst spacing (~1-5 ms). */
const DEFAULT_WINDOW_MS = 25;
const DEFAULT_STICKY_MS = 150;

export function createArrowRouter(opts: ArrowRouterOptions): ArrowRouter {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const stickyMs = opts.stickyMs ?? DEFAULT_STICKY_MS;
  let pending: ArrowDir | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scrollUntil = 0;

  const clearPending = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = null;
  };

  const scroll = (dir: ArrowDir, lines: number): void => {
    scrollUntil = Date.now() + stickyMs;
    opts.onScroll(dir, lines);
  };

  return {
    feed(dir, count) {
      if (count <= 0) return;
      // Several arrows at once, or arrows while a burst is active: wheel.
      if (count >= 2 || Date.now() < scrollUntil) {
        let lines = count;
        if (pending !== null) {
          const held = pending;
          clearPending();
          if (held === dir) lines += 1;
          else scroll(held, 1);
        }
        scroll(dir, lines);
        return;
      }
      if (pending !== null) {
        const held = pending;
        clearPending();
        if (held === dir) {
          // A second lone arrow inside the window — the run is a wheel.
          scroll(dir, 2);
          return;
        }
        // Direction flipped within the window: two distinct keypresses.
        opts.onHistory(held);
      }
      pending = dir;
      timer = setTimeout(() => {
        const held = pending;
        clearPending();
        if (held !== null) opts.onHistory(held);
      }, windowMs);
    },
    dispose: clearPending,
  };
}

/**
 * Parses a raw stdin chunk made purely of ↑/↓ arrow sequences (CSI "\x1b[A" or
 * SS3 "\x1bOA" style) into ordered same-direction runs. Returns null when the
 * chunk contains anything else — typed text, pastes, and other keys must never
 * be misrouted. Raw chunks are needed because Ink's keypress parser collapses a
 * batched multi-arrow chunk into a single upArrow event, hiding the count.
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
