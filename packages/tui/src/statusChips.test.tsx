import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar.js";
import { fitChips, planChipFit } from "./statusChips.js";

describe("planChipFit", () => {
  it("fits what it can, greedily from the left", () => {
    // Greedy from the left is why chip ORDER is the priority order.
    expect(planChipFit([10, 10, 10], 40)).toBe(3); // 10+3+10+3+10 = 36
    expect(planChipFit([10, 10, 10], 30)).toBe(2); // third would need 36
    expect(planChipFit([10, 10, 10], 12)).toBe(1);
  });

  it("never drops the first chip, however narrow the pane", () => {
    // A bar with nothing on it is worse than one that overflows by two columns,
    // and the first chip is the one that says which program this is.
    expect(planChipFit([40], 5)).toBe(1);
    expect(planChipFit([40, 10], 5)).toBe(1);
    expect(planChipFit([], 80)).toBe(1);
  });

  it("charges for the separators, not only the chips", () => {
    // Three 10-wide chips are 30 columns of content and 36 of row.
    expect(planChipFit([10, 10, 10], 35)).toBe(2);
    expect(planChipFit([10, 10, 10], 36)).toBe(3);
  });
});

describe("fitChips", () => {
  const chips = [
    { key: "a", text: "aaaaaaaaaa" },
    { key: "b", text: "bbbbbbbbbb" },
    { key: "c", text: "cccccccccc" },
  ];

  it("reports what it left out rather than dropping it silently", () => {
    const { shown, hidden } = fitChips(chips, 30);
    expect(shown.map((c) => c.key)).toEqual(["a", "b"]);
    expect(hidden).toBe(1);
  });

  it("honours a reservation for a right-anchored item", () => {
    // Reserved up front, because laying out left to right and hoping is what
    // makes a right-hand chip jitter as its neighbour changes width.
    expect(fitChips(chips, 40).hidden).toBe(0);
    expect(fitChips(chips, 40, 10).hidden).toBe(1);
  });

  it("measures columns, not code units", () => {
    // A branch name or a directory can hold anything a filesystem allows.
    const wide = [
      { key: "a", text: "漢字漢字漢字" }, // 12 columns, 6 code units
      { key: "b", text: "bbbb" },
    ];
    expect(fitChips(wide, 15).hidden).toBe(1);
    expect(fitChips(wide, 20).hidden).toBe(0);
  });
});

function bar(props: Record<string, unknown>): string {
  const { lastFrame } = render(
    createElement(StatusBar, {
      provider: "anthropic",
      model: "claude-opus-4",
      status: "thinking",
      inTok: 12300,
      outTok: 840,
      ctxUsed: 20481,
      ctxWindow: 32768,
      toolCount: 14,
      mode: "AUTO",
      columns: 110,
      version: "0.11.5",
      ...props,
    } as never),
  );
  return lastFrame() ?? "";
}

describe("the status bar", () => {
  it("names who owns the wheel, and what capture took in exchange", () => {
    // Three states, three different true sentences. The one that matters is the
    // middle: capture buys a wheel that scrolls the chat and costs plain
    // drag-select, and a user who learns the first half from the footer and the
    // second half by failing to copy a line reads the build as broken. With
    // capture on, the footer names the app's OWN selection (Ctrl+S), which both
    // selects and copies — the replacement for the terminal's lost drag.
    const wide = { columns: 200 };
    const captured = bar({ ...wide, fullscreen: true, mouseCapture: true });
    expect(captured).toContain("wheel scrolls");
    expect(captured).toContain("^S selects text");

    // Fullscreen without capture: the alternate screen has no scrollback to
    // give the wheel, so advertising it would name a key that does nothing.
    const uncaptured = bar({ ...wide, fullscreen: true, mouseCapture: false });
    expect(uncaptured).toContain("PgUp/PgDn scrolls");
    expect(uncaptured).not.toContain("^S selects");

    // Classic: the terminal owns its own scrollback and its own drag.
    const classic = bar({ ...wide, fullscreen: false, mouseCapture: false });
    expect(classic).toContain("wheel scrolls");
    expect(classic).not.toContain("^S selects");
  });

  it("keeps a constant height at every width", () => {
    // It used to fork at 84 columns and stack every group onto its own line —
    // five rows of chrome on a small terminal, and a full re-layout when the
    // window was dragged across the breakpoint. The bottom region is redrawn
    // on every repaint, so a region that changes height leaks scrollback rows.
    const rows = (cols: number) => bar({ columns: cols }).split("\n").filter(Boolean).length;
    expect(rows(140)).toBe(rows(84));
    expect(rows(84)).toBe(rows(40));
  });

  it("says how many chips it dropped", () => {
    expect(bar({ columns: 50 })).toMatch(/\+\d+/);
    expect(bar({ columns: 200 })).not.toMatch(/\+\d+$/m);
  });

  it("never drops the permission mode, which is what YOLO depends on", () => {
    // Riding along with the model name, the badge went out with it — so a
    // narrow terminal could be in YOLO and not say so.
    for (const columns of [140, 100, 84, 60, 44]) {
      expect(bar({ columns, mode: "YOLO" }), `at ${columns}`).toContain("YOLO");
    }
  });

  it("shows the context gauge as percent AND absolutes", () => {
    // A percentage alone cannot tell 25% of an 8k window from 25% of a 1M one.
    const frame = bar({ columns: 140 });
    expect(frame).toContain("63%");
    expect(frame).toContain("20k/33k");
  });

  it("names both ends of a fallback so the switch is legible", () => {
    const frame = bar({
      columns: 140,
      model: "opus",
      fallbackTo: { provider: "openai", model: "gpt-4o" },
    });
    // "backup" alone would look like the model was changed, when in fact the
    // configured one is still the one that failed.
    expect(frame).toContain("opus↪openai/gpt-4o");
  });
});
