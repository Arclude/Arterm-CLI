import { render } from "ink";
import React from "react";
import { MultiApp } from "./MultiApp.js";
import { syncedStdout } from "./syncOutput.js";
import { installTerminalRestore, resetTerminalModes } from "./terminalReset.js";
import type { Session } from "./types.js";

export type { Session, DisplayItem } from "./types.js";
export { syncedStdout } from "./syncOutput.js";
export { installTerminalRestore, resetTerminalModes } from "./terminalReset.js";

/**
 * Boots the Ink TUI and resolves when the user exits.
 *
 * Fullscreen (the default on a TTY) owns the whole window on the alternate
 * screen, so the footer stays pinned to the bottom row and the primary buffer
 * comes back untouched on exit. Classic (`tui.fullscreen: false`) prints the
 * transcript into the terminal's own scrollback and redraws only the bottom
 * region in place, so the conversation stays visible after exit — at the cost of
 * the pinned footer (see `config.ts` for why the two cannot both be had).
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
  // The HARDWARE cursor goes dark for the whole run: the composer draws its own
  // (`▏`), so the real one is always a second cursor sitting wherever the last
  // write left it — observed parked in the void below the session panel. Hidden
  // in classic mode too, which draws the same fake glyph.
  if (tty) process.stdout.write(`${ESC}[?25l`);
  if (fullscreen) {
    process.stdout.write(`${ESC}[?1049h${ESC}[2J${ESC}[H`);
  } else if (tty) {
    process.stdout.write("\n".repeat(Math.max(0, (process.stdout.rows ?? 24) - 1)));
  }
  // The abnormal-exit half. Ink's unmount and the `finally` below cover a
  // session that ENDS; being killed or crashing skips both, and that is exactly
  // when a terminal left with mouse reporting on becomes the user's problem for
  // the rest of the shell's life.
  const disposeRestore = tty ? installTerminalRestore({ fullscreen }) : (): void => {};
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
      {
        stdout: tty ? syncedStdout(process.stdout) : process.stdout,
        // Ctrl+C is handled by the App itself (two presses to quit), so Ink's
        // default single-press exit must be off — otherwise the first press
        // kills the process before the App can count it.
        exitOnCtrlC: false,
      },
    );
    await instance.waitUntilExit();
  } finally {
    disposeRestore();
    // One writer for every exit path, normal or not: the cursor comes back, all
    // mouse reporting goes off, and the alt screen is left LAST so the primary
    // buffer returns with a visible cursor whatever state it was in.
    if (tty) resetTerminalModes({ fullscreen });
  }
}
