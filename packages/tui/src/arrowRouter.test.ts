import { describe, expect, it } from "vitest";
import { arrowKeypress, parseArrowChunk } from "./arrowRouter.js";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

describe("parseArrowChunk", () => {
  it("parses a batched wheel tick into one run", () => {
    expect(parseArrowChunk(UP.repeat(3))).toEqual([{ dir: "up", count: 3 }]);
    expect(parseArrowChunk(DOWN.repeat(2))).toEqual([{ dir: "down", count: 2 }]);
  });

  it("parses a lone arrow (CSI and SS3 styles)", () => {
    expect(parseArrowChunk(UP)).toEqual([{ dir: "up", count: 1 }]);
    expect(parseArrowChunk(`${ESC}OA`)).toEqual([{ dir: "up", count: 1 }]);
    expect(parseArrowChunk(`${ESC}OB`)).toEqual([{ dir: "down", count: 1 }]);
  });

  it("keeps direction runs in order", () => {
    expect(parseArrowChunk(`${UP}${UP}${DOWN}`)).toEqual([
      { dir: "up", count: 2 },
      { dir: "down", count: 1 },
    ]);
  });

  it("rejects anything that is not purely arrows", () => {
    expect(parseArrowChunk("")).toBeNull();
    expect(parseArrowChunk("abc")).toBeNull();
    expect(parseArrowChunk(`${ESC}[C`)).toBeNull(); // right arrow
    expect(parseArrowChunk(`${UP}x`)).toBeNull(); // trailing junk
    expect(parseArrowChunk(`${ESC}[200~hi${ESC}[201~`)).toBeNull(); // paste
    expect(parseArrowChunk(`${ESC}[<64;10;10M`)).toBeNull(); // SGR mouse
  });
});

describe("arrowKeypress", () => {
  it("a lone arrow is a keypress, in both encodings", () => {
    expect(arrowKeypress(UP)).toBe("up");
    expect(arrowKeypress(DOWN)).toBe("down");
    expect(arrowKeypress(`${ESC}OA`)).toBe("up");
  });

  it("a batched chunk is a wheel tick and is dropped, not scrolled", () => {
    // The regression this file exists for: three arrows in one chunk is what a
    // terminal sends for ONE wheel tick under alternate scroll. Routed to
    // history it walked the prompt back three entries; routed to a scroll it
    // moved the chat in three-line jumps. Neither is what the wheel meant.
    expect(arrowKeypress(UP.repeat(3))).toBeNull();
    expect(arrowKeypress(DOWN.repeat(2))).toBeNull();
    expect(arrowKeypress(`${UP}${DOWN}`)).toBeNull();
  });

  it("is silent about everything that is not an arrow", () => {
    expect(arrowKeypress("hello")).toBeNull();
    expect(arrowKeypress(`${ESC}[<65;10;10M`)).toBeNull();
    expect(arrowKeypress("")).toBeNull();
  });

  it("answers immediately — a keypress is never held back", () => {
    // The old router waited 25 ms on every lone arrow to see whether a second
    // one landed. That delay was paid by every ↑ a human pressed, to guess at
    // an input that is now simply discarded.
    const before = Date.now();
    expect(arrowKeypress(UP)).toBe("up");
    expect(Date.now() - before).toBeLessThan(5);
  });
});
