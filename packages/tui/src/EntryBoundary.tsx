/**
 * One transcript entry's blast radius.
 *
 * Ink renders the whole tree, so a render error anywhere — a malformed diff
 * row, a markdown edge case, a tool result that is not the shape its renderer
 * assumed — unmounts the entire UI. The session is still alive underneath, the
 * agent may still be mid-turn, and the user is looking at a stack trace where
 * their terminal used to be.
 *
 * This is deliberately the smallest possible boundary: it wraps ONE entry, so
 * the failure costs that entry and nothing else. The replacement line says
 * which entry broke and why, because a silent gap in a transcript is a bug
 * report nobody can write.
 *
 * A class component because React error boundaries have no hook form.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text } from "./ink.js";
import { theme } from "./theme.js";
import { glyphs } from "./uiGlyphs.js";

interface Props {
  children: ReactNode;
  /** What the entry was, for the replacement line. */
  label: string;
}

interface State {
  message?: string;
}

export class EntryBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately not logged: stdout IS the UI here, and writing to it during
    // a render tears the frame that is currently being painted.
  }

  override render(): ReactNode {
    const { message } = this.state;
    if (message === undefined) return this.props.children;
    return (
      <Text color={theme.error} wrap="truncate-end">
        {glyphs.failure} {this.props.label} could not be rendered: {message}
      </Text>
    );
  }
}
