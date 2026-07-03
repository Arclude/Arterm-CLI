import { lineDiff } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Item } from "./MessageList.js";
import type { DisplayItem } from "./types.js";

describe("rich diff rendering (DiffView)", () => {
  it("renders a line-number gutter, the file path, and +/- markers", () => {
    const before = "func New() {\n  a := 1\n  b := 2\n  return a\n}";
    const after = "func New() {\n  a := 1\n  b := 3\n  return a\n}";
    const item: DisplayItem = {
      kind: "tool",
      name: "edit",
      path: "session.go",
      diffRows: lineDiff(before, after),
      output: "Replaced 1 occurrence(s) in session.go",
    };
    const { lastFrame, unmount } = render(createElement(Item, { item }));
    const frame = lastFrame() ?? "";
    // Header shows the changed file.
    expect(frame).toContain("session.go");
    // The changed line appears as a removal and an addition.
    expect(frame).toContain("- ");
    expect(frame).toContain("  b := 2"); // old line (removed)
    expect(frame).toContain("+ ");
    expect(frame).toContain("  b := 3"); // new line (added)
    // A gutter line number for the changed row (line 3) is present.
    expect(frame).toMatch(/\b3\b/);
    unmount();
  });

  it("shows the failure text for an errored mutating tool", () => {
    const item: DisplayItem = {
      kind: "tool",
      name: "write",
      path: "x.ts",
      diffRows: lineDiff("", "hello"),
      isError: true,
      output: "permission denied",
    };
    const { lastFrame, unmount } = render(createElement(Item, { item }));
    expect(lastFrame() ?? "").toContain("permission denied");
    unmount();
  });
});
