/**
 * The one animated thing in the UI.
 *
 * There was none: liveness was a static `●` and the word "working", so a turn
 * that had stalled looked exactly like a turn that was thinking. The reason
 * there was none is real and still holds — Ink repaints the whole dynamic
 * region on every frame, and a permanent animation is a cost paid forever for
 * a shape nobody is reading. So the rules here are narrow:
 *
 * - It is its OWN component. A frame tick re-renders one glyph, never the
 *   parent that owns the transcript.
 * - Its timer exists only while it is mounted, and it is mounted only while a
 *   turn is actually running. An idle session repaints nothing.
 * - The frame is width-stable: every braille cell is one column, so the text
 *   beside it never shifts. (The status bar's clock is computed inline for the
 *   same reason — a second's tick is not worth a repaint.)
 *
 * 120 ms, not 1 s: a spinner slower than about 10 fps reads as a stutter
 * rather than as motion, and the whole point is to say "still alive".
 */

import { useEffect, useState } from "react";
import type React from "react";
import { Text } from "./ink.js";
import { theme } from "./theme.js";
import { resolveIconStyle } from "./uiGlyphs.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** The ascii profile's spinner: the same idea drawn with what a VT can print. */
const ASCII = ["-", "\\", "|", "/"];

export const SPINNER_INTERVAL_MS = 120;

/** The animated frame alone, so a caller can place it inside its own line. */
export function Spinner({ color }: { color?: string }): React.ReactElement {
  const frames = resolveIconStyle() === "ascii" ? ASCII : BRAILLE;
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(t);
  }, [frames.length]);
  return <Text color={color ?? theme.warn}>{frames[i] ?? frames[0]}</Text>;
}

/**
 * Elapsed wall time for the running turn, at the precision that is useful:
 * tenths while you are watching it start, whole seconds once it has settled,
 * minutes once you have stopped watching.
 */
export function fmtElapsed(ms: number): string {
  if (ms < 0) return "0.0s";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/**
 * The elapsed clock, on its own 1 s timer.
 *
 * Two clocks rather than one: the spinner has to move fast enough to read as
 * motion, and the number has to change slowly enough to read at all. Driving
 * both from the 120 ms tick would redraw the digits eight times a second for
 * one visible change.
 */
export function Elapsed({ since, color }: { since: number; color?: string }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Text color={color ?? theme.textMuted}>{fmtElapsed(now - since)}</Text>;
}
