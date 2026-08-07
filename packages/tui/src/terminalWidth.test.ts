import { describe, expect, it } from "vitest";
import {
  displayWidth,
  padEndDisplay,
  stripAnsi,
  truncateDisplay,
  truncateMiddle,
} from "./terminalWidth.js";

describe("displayWidth (columns, not code units)", () => {
  it("counts plain ASCII one per character", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  it("counts the box-drawing and geometric glyphs the chrome uses as one", () => {
    // These are the glyphs the boards and status bar pad around.
    for (const g of ["█", "░", "❯", "▏", "│", "╭", "─", "✓", "✗", "·"]) {
      expect(displayWidth(g), g).toBe(1);
    }
  });

  it("counts the two-column glyphs that overflowed the board's padded cells", () => {
    // `⚙` is Extended_Pictographic, so Ink measures it as two columns — the
    // exact finding recorded in TeamBoard's layout comment. `.length` says 1,
    // which is how a hand-padded line overflowed by one column per glyph.
    expect("⚙".length).toBe(1);
    expect(displayWidth("⚙")).toBe(2);
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("ｆｕｌｌ")).toBe(8);
  });

  it("counts an emoji as two columns, and a ZWJ sequence as one emoji", () => {
    expect(displayWidth("📁")).toBe(2);
    // Family: 4 people + 3 ZWJ. `.length` says 11.
    expect("👨‍👩‍👧‍👦".length).toBe(11);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("gives combining marks and variation selectors no width", () => {
    expect(displayWidth("é")).toBe(1); // e + U+0301
    expect(displayWidth("✓️")).toBe(1);
  });

  it("measures what is drawn, not the escapes around it", () => {
    const styled = "\x1b[38;2;243;139;168mfail\x1b[39m";
    expect(stripAnsi(styled)).toBe("fail");
    expect(displayWidth(styled)).toBe(4);
  });
});

describe("truncateDisplay", () => {
  it("leaves a string that already fits", () => {
    expect(truncateDisplay("abc", 5)).toBe("abc");
    expect(truncateDisplay("abcde", 5)).toBe("abcde");
  });

  it("never returns more columns than asked, even cutting a wide glyph", () => {
    // The property `.slice(0, n) + "…"` breaks: it would return 4 columns here.
    for (const s of ["漢字漢字", "📁📁📁", "abcdefgh", "a漢b字c"]) {
      for (const w of [1, 2, 3, 4, 5, 6]) {
        expect(displayWidth(truncateDisplay(s, w)), `${s}@${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("marks the cut with an ellipsis", () => {
    expect(truncateDisplay("abcdefgh", 4)).toBe("abc…");
    expect(truncateDisplay("abc", 0)).toBe("");
  });
});

describe("truncateMiddle", () => {
  it("keeps both ends — the head says what it is, the tail says which one", () => {
    const out = truncateMiddle("packages/tui/src/StatusBar.tsx", 20);
    expect(displayWidth(out)).toBeLessThanOrEqual(20);
    expect(out.startsWith("packa")).toBe(true);
    expect(out.endsWith("r.tsx")).toBe(true);
    expect(out).toContain("…");
  });

  it("stays within budget on wide glyphs", () => {
    expect(displayWidth(truncateMiddle("漢字漢字漢字", 5))).toBeLessThanOrEqual(5);
  });
});

describe("padEndDisplay", () => {
  it("pads to a column count rather than a character count", () => {
    expect(displayWidth(padEndDisplay("📁", 5))).toBe(5);
    expect(displayWidth(padEndDisplay("abc", 5))).toBe(5);
  });

  it("never truncates — padding and clipping are separate decisions", () => {
    expect(padEndDisplay("abcdef", 3)).toBe("abcdef");
  });
});
