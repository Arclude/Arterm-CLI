import { render } from "ink";
import React from "react";
import { App } from "./App.js";
import { syncedStdout } from "./syncOutput.js";
import type { Session } from "./types.js";

export type { Session, DisplayItem } from "./types.js";
export { syncedStdout } from "./syncOutput.js";

/**
 * Boots the Ink TUI and resolves when the user exits. The transcript is printed
 * into the terminal's NORMAL buffer (no alternate screen): finished messages
 * accumulate in the terminal's own scrollback, so the wheel and drag-to-select
 * work natively — like any plain CLI — and the conversation stays visible after
 * exit. Only the small bottom region (live stream, boards, input, status bar)
 * is redrawn in place by Ink.
 */
export async function runTui(session: Session, opts?: { goal?: string }): Promise<void> {
  const tty = Boolean(process.stdout.isTTY);
  // Anchor the prompt to the BOTTOM of the window from the first frame: pad the
  // screen once so Ink's dynamic region starts on the last rows, and the chat
  // grows upward into scrollback above the fixed footer.
  if (tty) {
    process.stdout.write("\n".repeat(Math.max(0, (process.stdout.rows ?? 24) - 1)));
  }
  // On a real terminal Ink writes through syncedStdout: repaints become single
  // synchronized-output frames (no half-painted footer) and Ink's worst-case
  // full clear can no longer wipe the scrollback. See syncOutput.ts.
  const instance = render(React.createElement(App, { session, initialGoal: opts?.goal }), {
    stdout: tty ? syncedStdout(process.stdout) : process.stdout,
  });
  await instance.waitUntilExit();
}
