import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ComposerFrame, type ComposerFrameProps } from "./Composer.js";
import { displayWidth } from "./terminalWidth.js";

function frame(props: Partial<ComposerFrameProps> = {}): string[] {
  const { lastFrame } = render(
    createElement(ComposerFrame, {
      value: "",
      columns: 60,
      color: "gray",
      hint: "Enter send · ? help",
      ...props,
    }),
  );
  return (lastFrame() ?? "").split("\n");
}

/**
 * The invariant the whole file exists for: every row is exactly as wide as the
 * pane. One column over and the terminal wraps the line, and a wrapped line in
 * the bottom region pushes a transcript row into the scrollback on every
 * repaint — the failure mode that made Ink's own border the safe choice until
 * the widths here were measured rather than counted.
 */
function expectSquare(lines: string[], columns: number): void {
  for (const line of lines) {
    if (line === "") continue;
    expect(displayWidth(line), JSON.stringify(line)).toBe(columns);
  }
}

describe("the composer frame", () => {
  it("draws a square frame at every width", () => {
    for (const columns of [40, 60, 80, 120]) {
      expectSquare(frame({ columns }), columns);
    }
  });

  it("stays square while the user types", () => {
    expectSquare(frame({ value: "refactor auth.ts to async/await" }), 60);
  });

  it("stays square with a two-column glyph in the prompt", () => {
    // `.length` says one, the terminal draws two. This is the case that pushed
    // the closing corner past the edge before the widths were measured.
    expectSquare(frame({ value: "fix the ⚙ icon" }), 60);
    expectSquare(frame({ value: "汉字汉字汉字汉字" }), 60);
    expectSquare(frame({ value: "ship it 🚀🚀🚀" }), 60);
  });

  it("stays square with the ghost-text completion showing", () => {
    expectSquare(frame({ value: "/comp", suggestion: "act" }), 60);
  });

  it("stays square while a turn is running", () => {
    // The status slot is reserved, not measured afterwards: the clock counts
    // `9.9s → 10s → 1m05s` and would otherwise move the corner every second.
    expectSquare(frame({ workingSince: Date.now() - 3000 }), 60);
    expectSquare(frame({ workingSince: Date.now() - 3000, value: "typing under it" }), 60);
  });

  it("wraps a long value onto its own rows rather than overflowing", () => {
    const lines = frame({ value: "x".repeat(400), columns: 60 });
    expectSquare(lines, 60);
    // Top rail + body rows + bottom rail; the body is capped at ten rows.
    expect(lines.filter(Boolean).length).toBeLessThanOrEqual(12);
  });

  it("counts the rows it scrolled past instead of hiding them", () => {
    const lines = frame({ value: "y".repeat(2000), columns: 60 });
    // Inside the rail, not after its corner: the row is exactly `columns` wide
    // and truncated there, so anything past the corner is written into nothing.
    expect(lines.join("\n")).toMatch(/↑\d+ more/);
    expectSquare(lines, 60);
  });

  it("keeps a pasted block's own line breaks", () => {
    const lines = frame({ value: "one\ntwo\nthree", columns: 60 });
    const body = lines.join("\n");
    expect(body).toContain("one");
    expect(body).toContain("two");
    expect(body).toContain("three");
  });

  it("puts the title on the top rail and the hint on the bottom one", () => {
    const lines = frame({ hint: "Enter send · ? help" });
    expect(lines[0]).toContain("ARTERM");
    expect(lines[lines.length - 1] ?? "").toContain("Enter send");
  });

  it("says nothing about working when it is not", () => {
    expect(frame().join("\n")).not.toContain("working");
    expect(frame({ workingSince: Date.now() }).join("\n")).toContain("working");
  });
});
