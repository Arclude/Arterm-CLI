import { describe, expect, it } from "vitest";
import type { RawNode, RawSnapshot } from "./collector.js";
import { renderSnapshot } from "./snapshot.js";

function node(over: Partial<RawNode> & { ref: string; role: string }): RawNode {
  return { name: "", depth: 1, tag: over.role, ...over };
}

function snap(nodes: RawNode[], over: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    nodes,
    total: nodes.length,
    url: "https://example.com/",
    title: "Example",
    ...over,
  };
}

const opts = { limit: 200, mode: "interactive" as const };

describe("renderSnapshot", () => {
  it("heads the tree with the url and title", () => {
    const out = renderSnapshot(snap([node({ ref: "e1", role: "button", name: "Go" })]), opts);
    expect(out.split("\n")[0]).toBe('https://example.com/ — "Example"');
  });

  it("renders role, name, ref and only the state that is set", () => {
    const out = renderSnapshot(
      snap([
        node({ ref: "e1", role: "heading", name: "Sign in", level: 1 }),
        node({ ref: "e2", role: "textbox", name: "Email", value: "a@b.c", depth: 2 }),
        node({ ref: "e3", role: "checkbox", name: "Remember", checked: true, depth: 2 }),
        node({ ref: "e4", role: "button", name: "Go", disabled: true, depth: 2 }),
        node({ ref: "e5", role: "link", name: "Help", url: "/help", depth: 2 }),
      ]),
      opts,
    );
    expect(out).toContain('- heading "Sign in" [e1] level=1');
    expect(out).toContain('textbox "Email" [e2] value="a@b.c"');
    expect(out).toContain('checkbox "Remember" [e3] checked');
    expect(out).toContain('button "Go" [e4] disabled');
    expect(out).toContain('link "Help" [e5] → /help');
    // Nothing invents state it was not given.
    expect(out).not.toContain('"Sign in" [e1] level=1 value');
  });

  it("indents by EMITTED ancestors, not by raw DOM depth", () => {
    // A control eleven wrappers deep under a heading at depth 2 is one level in,
    // not nine — otherwise every real page renders off the right of the screen.
    const out = renderSnapshot(
      snap([
        node({ ref: "e1", role: "heading", name: "Title", depth: 2 }),
        node({ ref: "e2", role: "button", name: "Deep", depth: 13 }),
        node({ ref: "e3", role: "button", name: "Sibling", depth: 13 }),
        node({ ref: "e4", role: "heading", name: "Next", depth: 2 }),
      ]),
      opts,
    );
    const lines = out.split("\n");
    expect(lines[1]).toBe('- heading "Title" [e1]');
    expect(lines[2]).toBe('  - button "Deep" [e2]');
    expect(lines[3]).toBe('  - button "Sibling" [e3]');
    expect(lines[4]).toBe('- heading "Next" [e4]');
  });

  it("says what was cut and how to see more", () => {
    const out = renderSnapshot(
      snap([node({ ref: "e1", role: "button", name: "Go", interactive: true })], { total: 340 }),
      { limit: 1, mode: "interactive" },
    );
    expect(out).toContain("1 of 340 elements (limit 1)");
    expect(out).toContain("1 interactive");
    expect(out).toContain("raise `limit` or narrow with `selector`");
    expect(out).toContain('mode="full"');
  });

  it("does not offer the full-mode advice when already in full mode", () => {
    const out = renderSnapshot(snap([node({ ref: "e1", role: "text", name: "hi" })]), {
      limit: 200,
      mode: "full",
    });
    expect(out).not.toContain('mode="full"');
    expect(out).toContain("1 elements · 0 interactive");
  });

  it("separates a bad selector from a page with nothing on it", () => {
    expect(renderSnapshot(snap([], { rootMissing: true }), opts)).toContain(
      "The selector matched no element",
    );
    expect(renderSnapshot(snap([]), opts)).toContain("no elements with an accessible role");
  });

  it("survives a page with no url or title", () => {
    const out = renderSnapshot(snap([], { url: "", title: "" }), opts);
    expect(out.split("\n")[0]).toBe("(no page)");
  });
});
