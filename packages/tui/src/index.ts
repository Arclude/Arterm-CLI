import { render } from "ink";
import React from "react";
import { App } from "./App.js";
import type { Session } from "./types.js";

export type { Session, DisplayItem } from "./types.js";

/**
 * Boots the Ink TUI and resolves when the user exits. The transcript is printed
 * into the terminal's NORMAL buffer (no alternate screen): finished messages
 * accumulate in the terminal's own scrollback, so the wheel and drag-to-select
 * work natively — like any plain CLI — and the conversation stays visible after
 * exit. Only the small bottom region (live stream, boards, input, status bar)
 * is redrawn in place by Ink.
 */
export async function runTui(session: Session, opts?: { goal?: string }): Promise<void> {
  const instance = render(React.createElement(App, { session, initialGoal: opts?.goal }));
  await instance.waitUntilExit();
}
