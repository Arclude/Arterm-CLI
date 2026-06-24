/**
 * Pure text-editing logic for the prompt input, kept free of Ink so it can be
 * unit-tested. The input is append-only (the cursor always sits at the end).
 */

/** The subset of Ink's `Key` we react to. */
export interface KeyLike {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export type InputAction =
  | { type: "submit"; value: string }
  | { type: "change"; value: string }
  | { type: "help" }
  | { type: "history_prev" }
  | { type: "history_next" }
  | { type: "noop" };

/**
 * Deletes the word immediately before the cursor (readline-style Ctrl+W): drops
 * any trailing whitespace, then the run of non-whitespace before it. The space
 * separating the previous word is kept, matching shell behaviour.
 */
export function deleteWordBackward(value: string): string {
  const trimmed = value.replace(/\s+$/, "");
  const wordStart = trimmed.search(/\S+$/);
  return wordStart === -1 ? "" : trimmed.slice(0, wordStart);
}

/**
 * Maps a keypress to an edit action. Centralises the prompt's keymap:
 * - Enter submits.
 * - Ctrl+W / Ctrl+Backspace deletes the previous word.
 * - Ctrl+U clears the line.
 * - Backspace/Delete removes one char.
 * - `?` on an empty line opens help.
 */
export function reduceInput(value: string, input: string, key: KeyLike): InputAction {
  if (key.return) return { type: "submit", value };

  // Word/line deletion (checked before the plain-backspace and ctrl-swallow rules).
  if (key.ctrl && (input === "w" || key.backspace || key.delete)) {
    return { type: "change", value: deleteWordBackward(value) };
  }
  if (key.ctrl && input === "u") return { type: "change", value: "" };

  if (key.backspace || key.delete) return { type: "change", value: value.slice(0, -1) };
  if (key.upArrow) return { type: "history_prev" };
  if (key.downArrow) return { type: "history_next" };
  if (key.escape || key.tab) return { type: "noop" };
  if (key.ctrl || key.meta) return { type: "noop" };
  if (input === "?" && value === "") return { type: "help" };
  if (input) return { type: "change", value: value + input };
  return { type: "noop" };
}

/**
 * Slash-command names (no leading slash) that begin with the typed prefix.
 * Returns [] unless the line is a bare command token: it must start with "/"
 * and contain no space yet (we never complete arguments). Exact matches are
 * excluded so a fully-typed command shows no suggestion of itself.
 */
export function matchCommands(value: string, commands: readonly string[]): string[] {
  if (!value.startsWith("/")) return [];
  const typed = value.slice(1).toLowerCase();
  if (typed.includes(" ")) return [];
  return commands.filter((c) => c !== typed && c.startsWith(typed));
}

/**
 * The trailing characters to append to complete the current input to its first
 * matching command (the ghost text shown after the cursor), or "" if none.
 */
export function commandSuggestion(value: string, commands: readonly string[]): string {
  const first = matchCommands(value, commands)[0];
  return first ? first.slice(value.length - 1) : "";
}

/** Apply the suggestion: the input completed to its first matching command. */
export function completeCommand(value: string, commands: readonly string[]): string {
  return value + commandSuggestion(value, commands);
}

/**
 * Shell-style input history. `entries` are oldest-first submitted lines. `cursor`
 * ranges over [0, entries.length]; `cursor === entries.length` means "editing the
 * live draft" (not browsing). `draft` preserves the text typed before browsing so
 * arrowing back down to the bottom restores it.
 */
export interface HistoryNav {
  entries: string[];
  cursor: number;
  draft: string;
}

export function emptyHistory(): HistoryNav {
  return { entries: [], cursor: 0, draft: "" };
}

/**
 * Record a submitted line. Ignores empties and consecutive duplicates, and resets
 * the cursor back to the (empty) draft position.
 */
export function historyPush(nav: HistoryNav, entry: string): HistoryNav {
  const last = nav.entries[nav.entries.length - 1];
  const entries = entry && entry !== last ? [...nav.entries, entry] : nav.entries;
  return { entries, cursor: entries.length, draft: "" };
}

/**
 * Step to the previous (older) entry. `current` is the live input, saved as the
 * draft the first time we step off it. Returns the text to display.
 */
export function historyUp(nav: HistoryNav, current: string): { nav: HistoryNav; value: string } {
  if (nav.entries.length === 0 || nav.cursor === 0) return { nav, value: current };
  const draft = nav.cursor >= nav.entries.length ? current : nav.draft;
  const cursor = nav.cursor - 1;
  return { nav: { ...nav, cursor, draft }, value: nav.entries[cursor] ?? current };
}

/** Step to the next (newer) entry, restoring the saved draft past the newest. */
export function historyDown(nav: HistoryNav, current: string): { nav: HistoryNav; value: string } {
  if (nav.cursor >= nav.entries.length) return { nav, value: current };
  const cursor = nav.cursor + 1;
  if (cursor >= nav.entries.length) {
    return { nav: { ...nav, cursor: nav.entries.length }, value: nav.draft };
  }
  return { nav: { ...nav, cursor }, value: nav.entries[cursor] ?? current };
}
