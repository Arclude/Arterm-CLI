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
 * A trailing `[Image #1]` is one thing, so one backspace removes it.
 *
 * It is the ONE atom in the prompt the user did not type character by
 * character: Ctrl+V put it there whole. Taking ten presses to undo one press
 * would make detaching feel like a mistake being punished — and a half-deleted
 * `[Image #` no longer matches anything, so the image would silently stay
 * attached while the line said nothing about it.
 */
const TRAILING_IMAGE_TOKEN = /\s?\[Image #\d+\]$/;

/**
 * Deletes the word immediately before the cursor (readline-style Ctrl+W): drops
 * any trailing whitespace, then the run of non-whitespace before it. The space
 * separating the previous word is kept, matching shell behaviour. A trailing
 * `[Image #N]` counts as ONE word — it is one attachment, and eating half of
 * it would leave a token that matches nothing while the image stays attached
 * (the same argument as `deleteBackward`'s).
 */
export function deleteWordBackward(value: string): string {
  const trimmed = value.replace(/\s+$/, "");
  const token = TRAILING_IMAGE_TOKEN.exec(trimmed);
  if (token) return trimmed.slice(0, token.index);
  const wordStart = trimmed.search(/\S+$/);
  return wordStart === -1 ? "" : trimmed.slice(0, wordStart);
}

/**
 * One backspace: a trailing `[Image #N]` goes whole (see TRAILING_IMAGE_TOKEN),
 * anything else loses one character. Exported for the session panel's input,
 * which carries the same tokens without the composer's full keymap.
 */
export function deleteBackward(value: string): string {
  const whole = TRAILING_IMAGE_TOKEN.exec(value);
  return whole ? value.slice(0, whole.index) : value.slice(0, -1);
}

/** Normalises pasted line endings (CRLF or a lone CR) to "\n". */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Bracketed-paste markers a terminal wraps pasted text in: ESC[200~ … ESC[201~. */
const PASTE_MARKER = /\[20[01]~/g;

/** True if the chunk carries bracketed-paste markers (start or end). */
export function isPaste(input: string): boolean {
  return input.includes("[200~") || input.includes("[201~");
}

/**
 * SGR mouse-event sequence (ESC[<b;x;y M|m) a terminal emits while mouse
 * reporting is enabled. The TUI no longer turns reporting on (capture would
 * break native drag-to-select; the wheel arrives as alternate-scroll arrows
 * instead — see arrowRouter.ts), but a stray report can still leak in, e.g.
 * reporting left enabled by a previous crashed program — swallow, never type it.
 */
const MOUSE_SGR = /\[<\d+;\d+;\d+[Mm]/;
export function isMouseSequence(input: string): boolean {
  return MOUSE_SGR.test(input);
}

/** Strips bracketed-paste markers and normalises newlines to plain pasted text. */
export function stripPaste(s: string): string {
  // The ESC byte that frames each marker is dropped first (avoiding a control
  // char in the regex), then the literal marker bodies "[200~" / "[201~".
  const esc = String.fromCharCode(27);
  return normalizeNewlines(s.split(esc).join("").replace(PASTE_MARKER, ""));
}

/**
 * Maps a keypress to an edit action. Centralises the prompt's keymap:
 * - Pasted text (a bracketed-paste chunk, or any multi-character chunk) is
 *   inserted literally, newlines included — an embedded Enter never submits.
 * - Enter submits; Alt/Option+Enter inserts a newline (compose multi-line by hand).
 * - Ctrl+W / Ctrl+Backspace deletes the previous word.
 * - Ctrl+U clears the line.
 * - Backspace/Delete removes one char.
 * - `?` on an empty line opens help.
 */
export function reduceInput(value: string, input: string, key: KeyLike): InputAction {
  // Stray mouse reports (see isMouseSequence) must never touch the prompt text —
  // swallow them before anything else.
  if (isMouseSequence(input)) return { type: "noop" };

  // Pasted text arrives as a single chunk (wrapped in bracketed-paste markers
  // when supported, otherwise just a multi-character string). Insert it as-is so
  // a newline inside the paste does not trigger an early submit.
  if (isPaste(input)) {
    return { type: "change", value: value + stripPaste(input) };
  }
  if (!key.ctrl && !key.meta && input.length > 1) {
    return { type: "change", value: value + normalizeNewlines(input) };
  }

  // Alt/Option+Enter inserts a newline; plain Enter still submits.
  if (key.return && key.meta) return { type: "change", value: `${value}\n` };
  if (key.return) return { type: "submit", value };

  // Word/line deletion (checked before the plain-backspace and ctrl-swallow
  // rules). Three spellings for one intent, because terminals disagree:
  //  - Ctrl+W arrives as ctrl+"w" everywhere.
  //  - Ctrl+Backspace arrives as a BARE \x08 in most emulators — ink's parser
  //    labels it "backspace or ctrl+h" with NO ctrl bit — while the plain
  //    Backspace key sends \x7f (ink's `delete`). So an unmodified
  //    `key.backspace` IS the ctrl chord on a modern terminal; a terminal
  //    with `stty erase ^H` loses per-char backspace here, which is the
  //    trade every readline-family tool makes.
  //  - Alt/Option+Backspace arrives as ESC+\x7f: `delete` with meta.
  if (
    (key.ctrl && (input === "w" || key.backspace || key.delete)) ||
    (key.backspace && !key.meta) ||
    (key.meta && (key.backspace || key.delete))
  ) {
    return { type: "change", value: deleteWordBackward(value) };
  }
  if (key.ctrl && input === "u") return { type: "change", value: "" };

  if (key.backspace || key.delete) {
    return { type: "change", value: deleteBackward(value) };
  }
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
