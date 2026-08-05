import { render } from "ink";
import React from "react";
import { MultiApp } from "./MultiApp.js";
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
export async function runTui(
  initial: { id: string; session: Session },
  opts?: {
    goal?: string;
    createSession?: () => Promise<{ id: string; session: Session }>;
    closeSession?: (id: string) => Promise<void>;
    /** CLI version shown in the status bar — the binary is the single source. */
    version?: string;
  },
): Promise<void> {
  const session = initial.session;
  const tty = Boolean(process.stdout.isTTY);
  // Fullscreen (default): own the whole window on the alternate screen, like
  // Claude Code's fullscreen renderer — the footer stays pinned to the bottom
  // even while the chat scrolls in-app, and the primary buffer is restored
  // untouched on exit. Classic (tui.fullscreen: false): the chat flows into the
  // terminal's own scrollback; the pad below anchors the first prompt to the
  // window bottom.
  const fullscreen = tty && (session.config.tui?.fullscreen ?? true);
  const ESC = String.fromCharCode(27);
  if (fullscreen) {
    process.stdout.write(`${ESC}[?1049h${ESC}[2J${ESC}[H`);
  } else if (tty) {
    process.stdout.write("\n".repeat(Math.max(0, (process.stdout.rows ?? 24) - 1)));
  }
  try {
    // On a real terminal Ink writes through syncedStdout: repaints become single
    // synchronized-output frames (no half-painted footer) and Ink's worst-case
    // full clear can no longer wipe the scrollback. See syncOutput.ts.
    const instance = render(
      React.createElement(MultiApp, {
        initial,
        initialGoal: opts?.goal,
        createSession: opts?.createSession,
        closeSession: opts?.closeSession,
        fullscreen,
        version: opts?.version,
      }),
      { stdout: tty ? syncedStdout(process.stdout) : process.stdout },
    );
    await instance.waitUntilExit();
  } finally {
    if (fullscreen) process.stdout.write(`${ESC}[?1049l`);
  }
}
