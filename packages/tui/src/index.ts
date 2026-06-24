import { render } from "ink";
import React from "react";
import { App } from "./App.js";
import type { Session } from "./types.js";

export type { Session, DisplayItem } from "./types.js";

/** Enter/leave the terminal's alternate screen buffer (like vim/less), so the TUI
 *  owns the whole viewport and the primary buffer is restored untouched on exit. */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** Boots the full-screen Ink TUI and resolves when the user exits. */
export async function runTui(session: Session, opts?: { goal?: string }): Promise<void> {
  const useAltScreen = Boolean(process.stdout.isTTY);
  if (useAltScreen) process.stdout.write(ENTER_ALT_SCREEN);
  try {
    const instance = render(React.createElement(App, { session, initialGoal: opts?.goal }));
    await instance.waitUntilExit();
  } finally {
    if (useAltScreen) process.stdout.write(LEAVE_ALT_SCREEN);
  }
}
