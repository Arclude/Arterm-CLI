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

describe("reduceInput", () => {
  it("submits on Enter", () => {
    expect(reduceInput("hi", "", { return: true })).toEqual({ type: "submit", value: "hi" });
  });

  it("appends a typed character", () => {
    expect(reduceInput("ab", "c", NONE)).toEqual({ type: "change", value: "abc" });
  });

  it("deletes one char on Backspace", () => {
    expect(reduceInput("abc", "", { backspace: true })).toEqual({ type: "change", value: "ab" });
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
