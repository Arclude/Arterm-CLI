import { describe, expect, it } from "vitest";
import {
  highlightSpanForLine,
  normalizeRange,
  parseMouseEvents,
  pointFromScreen,
  projectTranscript,
  selectionText,
} from "./selection.js";
import type { DisplayItem } from "./types.js";

const ESC = String.fromCharCode(27);

describe("projectTranscript", () => {
  it("flattens an entry into its label header and body lines", () => {
    const items: DisplayItem[] = [{ kind: "assistant", text: "hello world" }];
    const lines = projectTranscript(items, 80).map((l) => l.text);
    expect(lines).toEqual(["ASSISTANT", "hello world"]);
  });

  it("separates two entries with a blank line, so a cross-entry copy keeps them apart", () => {
    const items: DisplayItem[] = [
      { kind: "user", text: "question" },
      { kind: "assistant", text: "answer" },
    ];
    const lines = projectTranscript(items, 80).map((l) => l.text);
    expect(lines).toEqual(["USER", "question", "", "ASSISTANT", "answer"]);
  });

  it("wraps a long paragraph to the given width", () => {
    const items: DisplayItem[] = [{ kind: "system", text: "abcdefghij" }];
    const lines = projectTranscript(items, 4).map((l) => l.text);
    // wrapToWidth breaks on grapheme boundaries at 4 cells.
    expect(lines).toEqual(["abcd", "efgh", "ij"]);
  });

  it("appends the live assistant stream so a selection can include it mid-turn", () => {
    const lines = projectTranscript([{ kind: "user", text: "hi" }], 80, "streaming…").map(
      (l) => l.text,
    );
    expect(lines).toEqual(["USER", "hi", "", "ASSISTANT", "streaming…"]);
  });
});

describe("pointFromScreen", () => {
  const lines = projectTranscript([{ kind: "assistant", text: "hello" }], 80);
  it("maps a viewport row onto the absolute projected line", () => {
    // firstVisibleLine 0, row 1 -> line 1 ("hello"), column clamped to width.
    expect(pointFromScreen(lines, 0, 1, 3)).toEqual({ line: 1, column: 3 });
  });

  it("clamps a column past the line end to the line width", () => {
    expect(pointFromScreen(lines, 0, 1, 999)).toEqual({ line: 1, column: 5 });
  });

  it("returns null for a click below the last line", () => {
    expect(pointFromScreen(lines, 0, 50, 0)).toBeNull();
  });

  it("honours the scroll offset via firstVisibleLine", () => {
    expect(pointFromScreen(lines, 1, 0, 0)?.line).toBe(1);
  });
});

describe("normalizeRange", () => {
  it("orders points so start precedes end regardless of drag direction", () => {
    const a = { line: 3, column: 2 };
    const b = { line: 1, column: 5 };
    expect(normalizeRange(a, b)).toEqual({ start: b, end: a });
    expect(normalizeRange(b, a)).toEqual({ start: b, end: a });
  });

  it("orders by column within one line", () => {
    const a = { line: 2, column: 8 };
    const b = { line: 2, column: 3 };
    expect(normalizeRange(a, b).start).toEqual(b);
  });
});

describe("selectionText", () => {
  const lines = projectTranscript(
    [
      { kind: "assistant", text: "hello" },
      { kind: "user", text: "world" },
    ],
    80,
  );
  // lines: ["ASSISTANT","hello","","USER","world"]

  it("cuts a single line between its columns", () => {
    const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } };
    expect(selectionText(lines, range)).toBe("ell");
  });

  it("spans multiple lines, cutting only the ends", () => {
    const range = { start: { line: 1, column: 2 }, end: { line: 4, column: 3 } };
    // "llo" + whole "" + whole "USER" + "wor"
    expect(selectionText(lines, range)).toBe("llo\n\nUSER\nwor");
  });

  it("returns empty for a zero-width selection", () => {
    const range = { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } };
    expect(selectionText(lines, range)).toBe("");
  });
});

describe("highlightSpanForLine", () => {
  const range = { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } };
  it("cuts the first line from the anchor column to the line end", () => {
    expect(highlightSpanForLine(range, 1, 10)).toEqual({ start: 2, end: 10 });
  });
  it("selects a whole middle line", () => {
    expect(highlightSpanForLine(range, 2, 7)).toEqual({ start: 0, end: 7 });
  });
  it("cuts the last line from its start to the cursor column", () => {
    expect(highlightSpanForLine(range, 3, 10)).toEqual({ start: 0, end: 4 });
  });
  it("returns null for a line outside the range", () => {
    expect(highlightSpanForLine(range, 0, 10)).toBeNull();
    expect(highlightSpanForLine(range, 4, 10)).toBeNull();
  });
  it("returns null when there is no selection", () => {
    expect(highlightSpanForLine(null, 2, 7)).toBeNull();
  });
});

describe("parseMouseEvents", () => {
  it("decodes a left press, a drag, and a release into zero-based coordinates", () => {
    expect(parseMouseEvents(`${ESC}[<0;12;5M`)).toEqual([{ kind: "down", col: 11, row: 4 }]);
    // 32 = motion flag + button 0 = left drag.
    expect(parseMouseEvents(`${ESC}[<32;12;5M`)).toEqual([{ kind: "drag", col: 11, row: 4 }]);
    // release is lowercase m.
    expect(parseMouseEvents(`${ESC}[<0;12;5m`)).toEqual([{ kind: "up", col: 11, row: 4 }]);
  });

  it("decodes wheel ticks with direction in the button byte", () => {
    expect(parseMouseEvents(`${ESC}[<64;1;1M`)[0]?.kind).toBe("wheel-up");
    expect(parseMouseEvents(`${ESC}[<65;1;1M`)[0]?.kind).toBe("wheel-down");
  });

  it("returns every event in a batched chunk, in order", () => {
    const chunk = `${ESC}[<32;2;3M${ESC}[<32;4;3M${ESC}[<0;5;3m`;
    expect(parseMouseEvents(chunk).map((e) => e.kind)).toEqual(["drag", "drag", "up"]);
  });

  it("ignores non-mouse bytes", () => {
    expect(parseMouseEvents("just text")).toEqual([]);
  });

  it("decodes the exact form Ink delivers press/drag/wheel in — the SAME path", () => {
    // This is the load-bearing assumption behind the whole feature working on a
    // real terminal. Ink's `parseKeypress` does NOT match an SGR mouse sequence
    // (`fnKeyRe` requires a digit/letter after `[`, not `<`), so it returns an
    // empty key name and hands `useInput` the raw sequence with the single
    // leading ESC stripped. That is why press (button 0), drag (32) and wheel
    // (64) all arrive as `[<b;x;yM` — byte-identical shapes differing only in
    // `b`. The app's wheel scroll is known to work interactively, and this
    // parser is the one both the wheel handler and the selection handler run,
    // so a press that stops decoding here is the one way selection could break
    // while the wheel still scrolls. Pin the delivered form (leading ESC gone).
    expect(parseMouseEvents("[<0;12;5M")).toEqual([{ kind: "down", col: 11, row: 4 }]);
    expect(parseMouseEvents("[<32;12;5M")).toEqual([{ kind: "drag", col: 11, row: 4 }]);
    expect(parseMouseEvents("[<0;12;5m")).toEqual([{ kind: "up", col: 11, row: 4 }]);
    expect(parseMouseEvents("[<64;12;5M")).toEqual([{ kind: "wheel-up", col: 11, row: 4 }]);
  });
});
