import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Elapsed, SPINNER_INTERVAL_MS, Spinner, fmtElapsed } from "./Spinner.js";
import { displayWidth } from "./terminalWidth.js";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the spinner", () => {
  it("moves", async () => {
    // The failure this replaces: a turn that has stalled looks exactly like a
    // turn that is thinking, because the only liveness on screen was a static
    // glyph and the word "working".
    const { lastFrame, unmount } = render(createElement(Spinner));
    const first = lastFrame();
    await tick(SPINNER_INTERVAL_MS * 2);
    expect(lastFrame()).not.toBe(first);
    unmount();
  });

  it("keeps every frame one column wide, so the text beside it never shifts", async () => {
    const { lastFrame, unmount } = render(createElement(Spinner));
    for (let i = 0; i < 12; i++) {
      expect(displayWidth((lastFrame() ?? "").trim())).toBe(1);
      await tick(SPINNER_INTERVAL_MS + 5);
    }
    unmount();
  });

  it("stops its timer when it unmounts — an idle session repaints nothing", async () => {
    // A permanent animation is a cost paid forever for a shape nobody reads,
    // which is why there was none before this. The timer's lifetime is the
    // component's, and the component is mounted only while a turn runs.
    const { lastFrame, unmount } = render(createElement(Spinner));
    unmount();
    const after = lastFrame();
    await tick(SPINNER_INTERVAL_MS * 3);
    expect(lastFrame()).toBe(after);
  });
});

describe("fmtElapsed", () => {
  it("changes precision with the scale a reader cares about", () => {
    // Tenths while you watch it start, seconds once it has settled, minutes
    // once you have stopped watching.
    expect(fmtElapsed(1500)).toBe("1.5s");
    expect(fmtElapsed(42_000)).toBe("42s");
    expect(fmtElapsed(125_000)).toBe("2m05s");
    expect(fmtElapsed(-5)).toBe("0.0s");
  });
});

describe("the elapsed clock", () => {
  it("renders the time since the turn began", () => {
    const { lastFrame, unmount } = render(createElement(Elapsed, { since: Date.now() - 3_000 }));
    expect(lastFrame()).toMatch(/^3\.\ds$/);
    unmount();
  });
});
