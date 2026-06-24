import { describe, expect, it } from "vitest";
import { diffHunk, editPreview, toolCallPreview, writePreview } from "./diff.js";

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
