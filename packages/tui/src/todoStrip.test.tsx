import type { TodoItem } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { TodoStrip } from "./TodoStrip.js";

const items = (n: number, activeAt = -1): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    text: `step ${i + 1}`,
    status: i === activeAt ? "in_progress" : i < activeAt ? "done" : "pending",
  }));

const strip = (list: TodoItem[], columns = 80): string =>
  render(createElement(TodoStrip, { items: list, columns })).lastFrame() ?? "";

describe("the todo strip", () => {
  it("counts what is done", () => {
    expect(strip(items(5, 3))).toContain("3/5");
  });

  it("keeps a long list to a few rows and counts the rest", () => {
    // It sits above the status bar for the whole run, so it cannot cost
    // fourteen rows for a fourteen-step plan.
    const frame = strip(items(14, 7));
    expect(frame.split("\n").filter(Boolean).length).toBeLessThanOrEqual(5);
    expect(frame).toContain("more");
  });

  it("windows on the step in progress, not the top of the list", () => {
    // Cutting the head would show a run's first three steps forever while it
    // works on the tenth.
    const frame = strip(items(14, 9));
    expect(frame).toContain("step 10");
    expect(frame).not.toContain("step 1 ");
  });

  it("shows the head when nothing is in progress yet", () => {
    const frame = strip(items(6));
    expect(frame).toContain("step 1");
  });

  it("marks the three states differently", () => {
    const frame = strip(items(3, 1));
    const marks = frame
      .split("\n")
      .filter((l) => /step \d/.test(l))
      .map((l) => l.trim()[0]);
    expect(new Set(marks).size).toBeGreaterThan(1);
  });
});
