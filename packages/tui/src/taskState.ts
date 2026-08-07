/**
 * How a task state looks — mark, word and colour — for every panel that shows
 * one.
 *
 * The swarm board and the /sdd kanban each had their own copy, and they had
 * already drifted: `running` drew `●` on one and `▸` on the other, for the same
 * state, in the same session, two rows apart. One table settles it.
 *
 * The word beside the mark is not redundancy. Colour is the one channel that
 * survives neither a screenshot, nor a colourblind reader, nor a terminal with
 * a palette of its own — and "is that yellow or green" is exactly the question
 * a board exists to answer at a glance.
 */

import type { SddTaskState } from "@arterm/core";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

export function stateMark(state: SddTaskState): string {
  switch (state) {
    case "running":
      return glyphs.running;
    case "done":
      return glyphs.success;
    case "failed":
      return glyphs.failure;
    case "blocked":
      return glyphs.denied;
    default:
      return glyphs.pending;
  }
}

export const STATE_LABEL: Record<SddTaskState, string> = {
  pending: "queued",
  running: "LIVE",
  done: "done",
  failed: "failed",
  blocked: "blocked",
};

export const STATE_COLOR: Record<SddTaskState, string> = {
  pending: theme.textMuted,
  running: theme.warn,
  done: theme.success,
  failed: theme.error,
  blocked: theme.textMuted,
};
