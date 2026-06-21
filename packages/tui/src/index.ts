import { render } from "ink";
import React from "react";
import { App } from "./App.js";
import type { Session } from "./types.js";

export type { Session, DisplayItem } from "./types.js";

/** Boots the full-screen Ink TUI and resolves when the user exits. */
export async function runTui(session: Session): Promise<void> {
  const instance = render(React.createElement(App, { session }));
  await instance.waitUntilExit();
}
