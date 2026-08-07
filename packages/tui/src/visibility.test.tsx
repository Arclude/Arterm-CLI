import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Item } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import type { DisplayItem } from "./types.js";

/**
 * Two things a tool can do that the transcript could not see.
 *
 * Both are cost the user pays and had no representation on screen: an image is
 * the most expensive thing a tool can put in the context and is re-sent every
 * later turn, and a background process is something still running on the
 * machine after the call that started it returned.
 */

const frame = (node: Parameters<typeof render>[0]): string => {
  const { lastFrame, unmount } = render(node);
  const out = lastFrame() ?? "";
  unmount();
  return out;
};

const toolItem = (over: Partial<Extract<DisplayItem, { kind: "tool" }>>): DisplayItem =>
  ({
    kind: "tool",
    name: "browser_screenshot",
    output: "screenshot of Example",
    ...over,
  }) as DisplayItem;

describe("an image a tool sent is visible, and priced", () => {
  it("shows the image marker and its size on the result row", () => {
    const out = frame(
      createElement(Item, { item: toolItem({ images: { count: 1, bytes: 245_000 } }) }),
    );
    expect(out).toMatch(/▨|i /);
    // The SIZE is the point: a screenshot is a line of text and a fortune.
    expect(out).toMatch(/2\d\d\s?KB|239KB|0\.2MB/i);
  });

  it("counts more than one", () => {
    const out = frame(
      createElement(Item, { item: toolItem({ images: { count: 3, bytes: 600_000 } }) }),
    );
    expect(out).toContain("×3");
  });

  it("says nothing when a result carried no image", () => {
    const out = frame(createElement(Item, { item: toolItem({ bytes: 40, tok: 10 }) }));
    expect(out).not.toContain("×");
    expect(out).not.toContain("▨");
  });
});

describe("a background process is visible without asking", () => {
  const bar = (bgProcesses?: number) =>
    frame(
      createElement(StatusBar, {
        provider: "ollama",
        model: "qwen2.5:7b",
        status: "idle" as never,
        inTok: 0,
        outTok: 0,
        ctxUsed: 0,
        ctxWindow: 8192,
        toolCount: 7,
        mode: "auto",
        columns: 120,
        ...(bgProcesses !== undefined ? { bgProcesses } : {}),
      }),
    );

  it("shows a chip while something is running", () => {
    // Until this, the only way to learn a dev server was holding a port was to
    // type `/ps` — which nobody does without already suspecting it.
    expect(bar(2)).toContain("2 bg");
  });

  it("shows nothing when nothing is running", () => {
    expect(bar(0)).not.toContain(" bg");
    expect(bar()).not.toContain(" bg");
  });

  it("keeps the chip on a narrow bar, ahead of the model name", () => {
    // A fact about the machine outranks a label the user already knows.
    const narrow = frame(
      createElement(StatusBar, {
        provider: "ollama",
        model: "qwen2.5:7b",
        status: "idle" as never,
        inTok: 0,
        outTok: 0,
        ctxUsed: 0,
        ctxWindow: 8192,
        toolCount: 7,
        mode: "auto",
        columns: 64,
        bgProcesses: 1,
      }),
    );
    expect(narrow).toContain("1 bg");
  });
});
