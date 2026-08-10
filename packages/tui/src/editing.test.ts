import { describe, expect, it } from "vitest";
import {
  type HistoryNav,
  type KeyLike,
  commandSuggestion,
  completeCommand,
  deleteWordBackward,
  emptyHistory,
  historyDown,
  historyPush,
  historyUp,
  isMouseSequence,
  matchCommands,
  reduceInput,
} from "./editing.js";

const NONE: KeyLike = {};

const CMDS = ["help", "model", "models", "login", "mode", "mcp"] as const;

describe("command completion", () => {
  it("suggests the first matching command's remaining characters", () => {
    expect(commandSuggestion("/lo", CMDS)).toBe("gin");
    expect(completeCommand("/lo", CMDS)).toBe("/login");
  });

  it("matches every command sharing the prefix, in list order", () => {
    expect(matchCommands("/mo", CMDS)).toEqual(["model", "models", "mode"]);
  });

  it("excludes an exact full match (so a complete command suggests nothing extra)", () => {
    // "model" is exact and excluded; "models" still extends it.
    expect(matchCommands("/model", CMDS)).toEqual(["models"]);
    expect(commandSuggestion("/login", CMDS)).toBe("");
  });

  it("never completes plain text or argument tokens", () => {
    expect(matchCommands("hello", CMDS)).toEqual([]);
    expect(matchCommands("/model gpt", CMDS)).toEqual([]);
    expect(commandSuggestion("/model gpt", CMDS)).toBe("");
  });

  it("leaves the input unchanged when nothing matches", () => {
    expect(completeCommand("/zzz", CMDS)).toBe("/zzz");
  });
});

describe("deleteWordBackward", () => {
  it("removes the last word but keeps the separating space", () => {
    expect(deleteWordBackward("hello world")).toBe("hello ");
  });

  it("removes a single word entirely", () => {
    expect(deleteWordBackward("word")).toBe("");
  });

  it("eats trailing whitespace before the word", () => {
    expect(deleteWordBackward("foo bar   ")).toBe("foo ");
  });

  it("returns empty for whitespace-only input", () => {
    expect(deleteWordBackward("   ")).toBe("");
  });

  it("returns empty for empty input", () => {
    expect(deleteWordBackward("")).toBe("");
  });

  it("treats punctuation as part of the word (whitespace-delimited)", () => {
    expect(deleteWordBackward("run npm-install")).toBe("run ");
  });
});

describe("isMouseSequence", () => {
  it("matches SGR wheel/click events", () => {
    expect(isMouseSequence("[<64;10;5M")).toBe(true); // wheel up
    expect(isMouseSequence("[<65;10;5M")).toBe(true); // wheel down
    expect(isMouseSequence("[<0;3;7m")).toBe(true); // button release
  });

  it("does not match normal typed input or pasted text", () => {
    expect(isMouseSequence("a")).toBe(false);
    expect(isMouseSequence("hello world")).toBe(false);
    expect(isMouseSequence("[200~pasted[201~")).toBe(false);
    expect(isMouseSequence("")).toBe(false);
  });
});

describe("reduceInput", () => {
  it("submits on Enter", () => {
    expect(reduceInput("hi", "", { return: true })).toEqual({ type: "submit", value: "hi" });
  });

  it("swallows a mouse-wheel sequence (no prompt change, no history recall)", () => {
    expect(reduceInput("draft", "[<64;10;5M", NONE)).toEqual({ type: "noop" });
  });

  it("appends a typed character", () => {
    expect(reduceInput("ab", "c", NONE)).toEqual({ type: "change", value: "abc" });
  });

  it("deletes one char on Backspace", () => {
    // The plain key is \x7f on a modern terminal — ink's `delete`. A bare
    // \x08 (`backspace`) is the Ctrl chord and deletes a word; see below.
    expect(reduceInput("abc", "", { delete: true })).toEqual({ type: "change", value: "ab" });
  });

  it("deletes a whole trailing [Image #N] on one Backspace", () => {
    // It is the one atom in the prompt the user did not type character by
    // character — Ctrl+V put it there whole. Ten presses to undo one press
    // would make detaching feel like a punishment, and a half-eaten
    // `[Image #` matches nothing, so the image would stay attached while the
    // line no longer said so.
    expect(reduceInput("look at this [Image #1]", "", { backspace: true })).toEqual({
      type: "change",
      value: "look at this",
    });
    expect(reduceInput("[Image #12]", "", { backspace: true })).toEqual({
      type: "change",
      value: "",
    });
  });

  it("still deletes one char when the line merely mentions an image elsewhere", () => {
    expect(reduceInput("[Image #1] and more", "", { delete: true })).toEqual({
      type: "change",
      value: "[Image #1] and mor",
    });
  });

  it("deletes a word on Ctrl+W", () => {
    expect(reduceInput("foo bar", "w", { ctrl: true })).toEqual({
      type: "change",
      value: "foo ",
    });
  });

  it("deletes a word on Ctrl+Backspace", () => {
    expect(reduceInput("foo bar", "", { ctrl: true, backspace: true })).toEqual({
      type: "change",
      value: "foo ",
    });
  });

  it("clears the line on Ctrl+U", () => {
    expect(reduceInput("anything here", "u", { ctrl: true })).toEqual({
      type: "change",
      value: "",
    });
  });

  it("opens help on ? when the line is empty", () => {
    expect(reduceInput("", "?", NONE)).toEqual({ type: "help" });
  });

  it("treats ? as a normal char when the line is not empty", () => {
    expect(reduceInput("a", "?", NONE)).toEqual({ type: "change", value: "a?" });
  });

  it("ignores bare Ctrl/Meta chords that aren't bound", () => {
    expect(reduceInput("abc", "p", { ctrl: true })).toEqual({ type: "noop" });
  });

  it("maps Up/Down arrows to history navigation", () => {
    expect(reduceInput("abc", "", { upArrow: true })).toEqual({ type: "history_prev" });
    expect(reduceInput("abc", "", { downArrow: true })).toEqual({ type: "history_next" });
  });

  it("ignores Esc and Tab", () => {
    expect(reduceInput("abc", "", { escape: true })).toEqual({ type: "noop" });
    expect(reduceInput("abc", "", { tab: true })).toEqual({ type: "noop" });
  });

  it("inserts a multi-character paste literally instead of submitting on its newline", () => {
    expect(reduceInput("hi ", "world\nthere", NONE)).toEqual({
      type: "change",
      value: "hi world\nthere",
    });
  });

  it("strips bracketed-paste markers and normalises CRLF in the paste", () => {
    const esc = String.fromCharCode(27);
    const wrapped = `${esc}[200~line1\r\nline2${esc}[201~`;
    expect(reduceInput("", wrapped, NONE)).toEqual({ type: "change", value: "line1\nline2" });
  });

  it("Alt/Meta+Enter inserts a newline rather than submitting", () => {
    expect(reduceInput("line1", "", { return: true, meta: true })).toEqual({
      type: "change",
      value: "line1\n",
    });
  });

  it("plain Enter still submits", () => {
    expect(reduceInput("done", "", { return: true })).toEqual({ type: "submit", value: "done" });
  });
});

describe("input history", () => {
  function seed(...entries: string[]): HistoryNav {
    return entries.reduce((nav, e) => historyPush(nav, e), emptyHistory());
  }

  it("records submissions and resets the cursor to the draft", () => {
    const nav = seed("first", "second");
    expect(nav.entries).toEqual(["first", "second"]);
    expect(nav.cursor).toBe(2);
  });

  it("ignores empty and consecutive-duplicate submissions", () => {
    let nav = historyPush(emptyHistory(), "");
    expect(nav.entries).toEqual([]);
    nav = historyPush(seed("ls"), "ls");
    expect(nav.entries).toEqual(["ls"]);
  });

  it("Up walks backwards through entries, newest first", () => {
    let nav = seed("a", "b", "c");
    let value: string;
    ({ nav, value } = historyUp(nav, ""));
    expect(value).toBe("c");
    ({ nav, value } = historyUp(nav, value));
    expect(value).toBe("b");
    ({ nav, value } = historyUp(nav, value));
    expect(value).toBe("a");
    // Past the oldest, it stays put.
    ({ value } = historyUp(nav, value));
    expect(value).toBe("a");
  });

  it("Down returns toward the draft and restores it", () => {
    const nav = seed("a", "b");
    // Type a draft, then browse up.
    let r = historyUp(nav, "draft");
    expect(r.value).toBe("b");
    r = historyUp(r.nav, r.value);
    expect(r.value).toBe("a");
    // Back down to "b", then to the restored draft.
    r = historyDown(r.nav, r.value);
    expect(r.value).toBe("b");
    r = historyDown(r.nav, r.value);
    expect(r.value).toBe("draft");
  });

  it("Up on empty history is a no-op that keeps the current text", () => {
    const { value } = historyUp(emptyHistory(), "typing");
    expect(value).toBe("typing");
  });
});

describe("word deletion, as terminals actually spell it", () => {
  // Ink's parser labels a bare \x08 "backspace or ctrl+h" with NO ctrl bit —
  // that byte IS Ctrl+Backspace on a modern emulator, while the plain key
  // sends \x7f (ink's `delete`). The user-visible bug: Ctrl+Backspace deleted
  // one character, indistinguishable from the unmodified key.
  it("a bare \\x08 (Ctrl+Backspace) deletes the previous word", () => {
    const out = reduceInput("foo bar baz", "", { backspace: true });
    expect(out).toEqual({ type: "change", value: "foo bar " });
  });

  it("plain Backspace (\\x7f) still deletes one character", () => {
    const out = reduceInput("foo bar", "", { delete: true });
    expect(out).toEqual({ type: "change", value: "foo ba" });
  });

  it("Alt+Backspace (ESC \\x7f — delete with meta) deletes the word", () => {
    const out = reduceInput("foo bar", "", { delete: true, meta: true });
    expect(out).toEqual({ type: "change", value: "foo " });
  });

  it("Ctrl+W keeps working", () => {
    const out = reduceInput("foo bar", "w", { ctrl: true });
    expect(out).toEqual({ type: "change", value: "foo " });
  });

  it("a trailing [Image #N] is one word — never half a token", () => {
    const out = reduceInput("compare [Image #1]", "", { backspace: true });
    expect(out).toEqual({ type: "change", value: "compare" });
  });
});
