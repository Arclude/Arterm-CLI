import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EntryBoundary } from "./EntryBoundary.js";
import { Item } from "./MessageList.js";
import type { DisplayItem } from "./types.js";

function item(i: DisplayItem): string {
  const { lastFrame } = render(createElement(Item, { item: i }));
  return lastFrame() ?? "";
}

describe("a tool call row", () => {
  it("gives tools that do different things different marks", () => {
    // Every call drew the same `•` in the same yellow, so the shape of a turn —
    // five reads, an edit, a bash — was unreadable until you read the names.
    const read = item({ kind: "tool", name: "read", args: '{"path":"a.ts"}' });
    const bash = item({ kind: "tool", name: "bash", args: '{"command":"ls"}' });
    expect(read).not.toBe(bash);
    expect(read).toContain("read");
    expect(bash).toContain("bash");
  });
});

describe("a tool result row", () => {
  it("shows how long it took and how much it produced", () => {
    // `ms`, `bytes` and `tok` were recorded on the item and rendered nowhere,
    // so a call that took four seconds and one that took four milliseconds
    // looked the same — the difference between a slow tool and a slow model.
    const frame = item({
      kind: "tool",
      name: "bash",
      output: "ok",
      ms: 4120,
      bytes: 3277,
      tok: 900,
    });
    expect(frame).toContain("4.1s");
    expect(frame).toContain("3KB");
    expect(frame).toContain("900t");
  });

  it("says nothing where there is nothing measured", () => {
    const frame = item({ kind: "tool", name: "bash", output: "ok" });
    expect(frame).toContain("ok");
    expect(frame).not.toContain("·");
  });

  it("formats a duration at the scale a reader acts on", () => {
    expect(item({ kind: "tool", name: "x", output: "o", ms: 87 })).toContain("87ms");
    expect(item({ kind: "tool", name: "x", output: "o", ms: 4120 })).toContain("4.1s");
    expect(item({ kind: "tool", name: "x", output: "o", ms: 125_000 })).toContain("2m05s");
  });
});

describe("a diff", () => {
  const rows = [
    { kind: "context" as const, old: 12, new: 12, text: "  const a = 1;" },
    { kind: "del" as const, old: 13, text: "  const b = 2;" },
    { kind: "add" as const, new: 13, text: "\tconst b = 3;" },
  ];

  it("renders every row, tabs included", () => {
    // A hard tab advances the cursor without painting, so it would leave a
    // colourless gap in the wash and put the padding in the wrong column.
    const frame = item({ kind: "tool", name: "edit", path: "a.ts", diffRows: rows });
    expect(frame).toContain("const a = 1;");
    expect(frame).toContain("const b = 2;");
    expect(frame).toContain("const b = 3;");
    expect(frame).not.toContain("\t");
  });

  it("keeps the line-number gutter and the markers", () => {
    const frame = item({ kind: "tool", name: "edit", path: "a.ts", diffRows: rows });
    expect(frame).toMatch(/12\s+12\s+│/);
    expect(frame).toContain("- ");
    expect(frame).toContain("+ ");
  });
});

describe("the per-entry boundary", () => {
  function Boom(): never {
    throw new Error("bad row");
  }

  it("costs one entry, not the whole terminal", () => {
    // Ink renders a single tree: without this, a render error anywhere unmounts
    // the UI — the session still alive underneath, the agent possibly mid-turn,
    // and a stack trace where the terminal used to be.
    const { lastFrame } = render(
      <EntryBoundary label="a tool entry">
        <Boom />
      </EntryBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a tool entry could not be rendered");
    expect(frame).toContain("bad row");
  });

  it("passes a healthy entry straight through", () => {
    const { lastFrame } = render(
      <EntryBoundary label="x">
        <Item item={{ kind: "system", text: "hello" }} />
      </EntryBoundary>,
    );
    expect(lastFrame()).toContain("hello");
  });
});
