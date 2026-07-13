import { describe, expect, it } from "vitest";
import { Blackboard } from "./blackboard.js";

describe("Blackboard", () => {
  it("resolves teammates by id or name, case-insensitively", () => {
    const b = new Blackboard();
    b.setRoster([
      { id: "m1-coder", name: "coder" },
      { id: "m2-reviewer", name: "Reviewer" },
    ]);
    expect(b.resolve("coder")?.id).toBe("m1-coder");
    expect(b.resolve("M1-CODER")?.id).toBe("m1-coder");
    expect(b.resolve("reviewer")?.id).toBe("m2-reviewer");
    expect(b.resolve("nobody")).toBeUndefined();
  });

  it("stamps the current round on posts and ignores empty text", () => {
    const b = new Blackboard();
    b.round = 3;
    b.post({ from: "m1", fromName: "coder", kind: "result", text: "did the thing" });
    b.post({ from: "m1", fromName: "coder", kind: "message", text: "   " });
    expect(b.entries()).toHaveLength(1);
    expect(b.entries()[0]?.round).toBe(3);
  });

  it("briefFor shows only earlier-round entries meant for the member, not its own", () => {
    const b = new Blackboard();
    // Round 1 work posted at round 1.
    b.round = 1;
    b.post({ from: "m1", fromName: "coder", kind: "result", text: "wrote the parser" });
    b.post({
      from: "m2",
      fromName: "reviewer",
      to: "m1",
      toName: "coder",
      kind: "message",
      text: "rename Foo to Bar",
    });
    // Now the reviewer is entering round 2 — it should see the coder's result but
    // not its own directed message, and not same-round entries.
    b.round = 2;
    const brief = b.briefFor("m2-x-never-authored");
    expect(brief).toContain("wrote the parser");

    const coderBrief = b.briefFor("m1");
    // Directed message to m1 surfaces; m1's own result does not.
    expect(coderBrief).toContain("rename Foo to Bar");
    expect(coderBrief).toContain("Message to you");
    expect(coderBrief).not.toContain("wrote the parser");
  });

  it("hides current-and-future-round entries (parallel members can't see live work)", () => {
    const b = new Blackboard();
    b.round = 2;
    b.post({ from: "m2", fromName: "reviewer", kind: "result", text: "same round work" });
    // Another member also entering round 2 must not see round-2 postings.
    expect(b.briefFor("m1")).toBe("");
  });

  it("returns empty brief when nothing is relevant", () => {
    const b = new Blackboard();
    b.round = 5;
    expect(b.briefFor("m1")).toBe("");
  });

  it("clear resets entries, roster, and round", () => {
    const b = new Blackboard();
    b.round = 4;
    b.setRoster([{ id: "m1", name: "coder" }]);
    b.post({ from: "m1", fromName: "coder", kind: "result", text: "x" });
    b.clear();
    expect(b.entries()).toHaveLength(0);
    expect(b.round).toBe(0);
    expect(b.resolve("coder")).toBeUndefined();
  });

  it("truncates very long entries", () => {
    const b = new Blackboard();
    b.round = 1;
    b.post({ from: "m1", fromName: "coder", kind: "result", text: "x".repeat(2000) });
    const text = b.entries()[0]?.text ?? "";
    expect(text.length).toBeLessThan(2000);
    expect(text.endsWith("…")).toBe(true);
  });
});
