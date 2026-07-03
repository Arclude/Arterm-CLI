import { describe, expect, it } from "vitest";
import { diffHunk, editPreview, lineDiff, toolCallPreview, writePreview } from "./diff.js";

describe("lineDiff", () => {
  it("returns [] for identical content", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("numbers a single-line change and keeps surrounding context", () => {
    const before = "l1\nl2\nl3\nl4\nl5";
    const after = "l1\nl2\nX\nl4\nl5";
    const rows = lineDiff(before, after);
    // context l1,l2 (both nums), the del l3 (old 3), the add X (new 3), context l4,l5.
    expect(rows.filter((r) => r.kind === "del")).toEqual([{ kind: "del", old: 3, text: "l3" }]);
    expect(rows.filter((r) => r.kind === "add")).toEqual([{ kind: "add", new: 3, text: "X" }]);
    const ctx = rows.filter((r) => r.kind === "context");
    expect(ctx).toContainEqual({ kind: "context", old: 2, new: 2, text: "l2" });
    expect(ctx).toContainEqual({ kind: "context", old: 4, new: 4, text: "l4" });
  });

  it("collapses far-apart unchanged regions behind a hunk header", () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join("\n");
    const after = before.replace("l1", "X1").replace("l40", "X40");
    const rows = lineDiff(before, after);
    // The 30+ unchanged middle lines are dropped; a hunk header marks the gap.
    expect(rows.some((r) => r.kind === "hunk")).toBe(true);
    expect(rows.some((r) => r.kind === "context" && r.text === "l20")).toBe(false);
  });

  it("treats a brand-new file as all additions", () => {
    const rows = lineDiff("", "a\nb");
    expect(rows).toEqual([
      { kind: "add", new: 1, text: "a" },
      { kind: "add", new: 2, text: "b" },
    ]);
  });
});

describe("diffHunk", () => {
  it("renders old lines as removals and new lines as additions", () => {
    expect(diffHunk("a\nb", "c")).toEqual(["-a", "-b", "+c"]);
  });

  it("omits the empty side (pure insertion or deletion)", () => {
    expect(diffHunk("", "new")).toEqual(["+new"]);
    expect(diffHunk("old", "")).toEqual(["-old"]);
  });
});

describe("editPreview", () => {
  it("puts the summary on the first line and the diff below", () => {
    const [head, ...body] = editPreview("f.ts", "x", "y", false).split("\n");
    expect(head).toBe("edit f.ts");
    expect(body).toEqual(["-x", "+y"]);
  });

  it("notes replace_all in the summary", () => {
    expect(editPreview("f.ts", "x", "y", true).split("\n")[0]).toContain("all occurrences");
  });

  it("truncates a long diff body and reports how many lines were hidden", () => {
    const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const lines = editPreview("f.ts", big, "", false).split("\n");
    // 1 summary + 20 body + 1 truncation note.
    expect(lines.length).toBe(22);
    expect(lines.at(-1)).toMatch(/more line/);
  });
});

describe("writePreview", () => {
  it("shows the new content as added lines", () => {
    const [head, ...body] = writePreview("n.txt", "hi\nthere").split("\n");
    expect(head).toContain("write n.txt");
    expect(body).toEqual(["+hi", "+there"]);
  });
});

describe("toolCallPreview", () => {
  it("formats an edit call as a diff", () => {
    const p = toolCallPreview("edit", { path: "f.ts", old_string: "a", new_string: "b" });
    expect(p).toBe("edit f.ts\n-a\n+b");
  });

  it("formats a write call as added lines", () => {
    expect(toolCallPreview("write", { path: "f", content: "x" })).toBe("write f · 1 bytes\n+x");
  });

  it("formats a multi_edit call with per-edit hunks", () => {
    const p = toolCallPreview("multi_edit", {
      path: "f",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(p).toContain("multi_edit f");
    expect(p).toContain("@ edit 1");
    expect(p).toContain("-a");
    expect(p).toContain("+b");
  });

  it("returns null for tools without a file-diff representation", () => {
    expect(toolCallPreview("bash", { command: "ls" })).toBeNull();
    expect(toolCallPreview("grep", { pattern: "x" })).toBeNull();
  });
});
