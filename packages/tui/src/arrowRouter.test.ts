import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArrowDir, createArrowRouter, parseArrowChunk } from "./arrowRouter.js";

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

describe("createArrowRouter", () => {
  let history: ArrowDir[];
  let scrolls: Array<{ dir: ArrowDir; lines: number }>;
  let router: ReturnType<typeof createArrowRouter>;

  beforeEach(() => {
    vi.useFakeTimers();
    history = [];
    scrolls = [];
    router = createArrowRouter({
      onHistory: (dir) => history.push(dir),
      onScroll: (dir, lines) => scrolls.push({ dir, lines }),
    });
  });

  afterEach(() => {
    router.dispose();
    vi.useRealTimers();
  });

  it("a lone arrow becomes history after the hold-back window", () => {
    router.feed("up", 1);
    expect(history).toEqual([]);
    vi.advanceTimersByTime(30);
    expect(history).toEqual(["up"]);
    expect(scrolls).toEqual([]);
  });

  it("a batched multi-arrow chunk scrolls immediately", () => {
    router.feed("up", 3);
    expect(scrolls).toEqual([{ dir: "up", lines: 3 }]);
    expect(history).toEqual([]);
  });

  it("two lone arrows inside the window reclassify as wheel", () => {
    router.feed("up", 1);
    vi.advanceTimersByTime(5);
    router.feed("up", 1);
    expect(scrolls).toEqual([{ dir: "up", lines: 2 }]);
    vi.advanceTimersByTime(100);
    expect(history).toEqual([]);
  });

  it("lone arrows keep scrolling while the burst is sticky", () => {
    router.feed("up", 3);
    vi.advanceTimersByTime(50); // within stickyMs
    router.feed("up", 1);
    expect(scrolls).toEqual([
      { dir: "up", lines: 3 },
      { dir: "up", lines: 1 },
    ]);
    expect(history).toEqual([]);
  });

  it("keyboard auto-repeat spacing stays history", () => {
    router.feed("up", 1);
    vi.advanceTimersByTime(33);
    router.feed("up", 1);
    vi.advanceTimersByTime(33);
    expect(history).toEqual(["up", "up"]);
    expect(scrolls).toEqual([]);
  });

  it("a direction flip inside the window resolves both as history", () => {
    router.feed("up", 1);
    vi.advanceTimersByTime(5);
    router.feed("down", 1);
    expect(history).toEqual(["up"]);
    vi.advanceTimersByTime(30);
    expect(history).toEqual(["up", "down"]);
    expect(scrolls).toEqual([]);
  });

  it("a held lone arrow joins a burst instead of becoming history", () => {
    router.feed("up", 1);
    vi.advanceTimersByTime(5);
    router.feed("up", 3);
    expect(scrolls).toEqual([{ dir: "up", lines: 4 }]);
    vi.advanceTimersByTime(100);
    expect(history).toEqual([]);
  });

  it("dispose cancels a pending hold-back", () => {
    router.feed("up", 1);
    router.dispose();
    vi.advanceTimersByTime(100);
    expect(history).toEqual([]);
  });
});
