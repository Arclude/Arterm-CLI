import { describe, expect, it } from "vitest";
import { MemberMemory } from "./memberMemory.js";

describe("MemberMemory", () => {
  it("stamps the current round on entries and ignores empty text", () => {
    const m = new MemberMemory();
    m.round = 3;
    m.note("m1", "decided to use zod");
    m.note("m1", "   ");
    expect(m.entries("m1")).toHaveLength(1);
    expect(m.entries("m1")[0]?.round).toBe(3);
    expect(m.entries("m1")[0]?.kind).toBe("note");
  });

  it("keeps each member's memory private to itself", () => {
    const m = new MemberMemory();
    m.round = 1;
    m.note("m1", "coder secret");
    m.recap("m2", "reviewer output");
    expect(m.recall("m1")).toContain("coder secret");
    expect(m.recall("m1")).not.toContain("reviewer output");
    expect(m.recall("m2")).toContain("reviewer output");
  });

  it("recall surfaces notes before recaps", () => {
    const m = new MemberMemory();
    m.round = 1;
    m.recap("m1", "wrote the parser");
    m.note("m1", "Foo must stay sync");
    const recall = m.recall("m1");
    expect(recall.indexOf("Foo must stay sync")).toBeLessThan(recall.indexOf("wrote the parser"));
    expect(recall).toContain("round 1");
  });

  it("returns an empty recall for a member with no history", () => {
    const m = new MemberMemory();
    m.round = 4;
    expect(m.recall("m1")).toBe("");
  });

  it("caps recaps to the last few rounds while keeping notes", () => {
    const m = new MemberMemory();
    for (let round = 1; round <= 6; round += 1) {
      m.round = round;
      m.recap("m1", `output of round ${round}`);
    }
    m.note("m1", "a decision worth keeping");
    const recaps = m.entries("m1").filter((e) => e.kind === "recap");
    expect(recaps).toHaveLength(3);
    // Oldest recaps are pruned; the newest survive.
    expect(recaps[0]?.text).toContain("round 4");
    expect(recaps[2]?.text).toContain("round 6");
    expect(m.recall("m1")).toContain("a decision worth keeping");
  });

  it("caps notes without dropping recaps", () => {
    const m = new MemberMemory();
    m.round = 1;
    m.recap("m1", "the one recap");
    for (let i = 1; i <= 15; i += 1) m.note("m1", `note ${i}`);
    const notes = m.entries("m1").filter((e) => e.kind === "note");
    expect(notes).toHaveLength(12);
    expect(notes[0]?.text).toBe("note 4");
    expect(m.entries("m1").filter((e) => e.kind === "recap")).toHaveLength(1);
  });

  it("truncates very long entries", () => {
    const m = new MemberMemory();
    m.round = 1;
    m.recap("m1", "x".repeat(2000));
    const text = m.entries("m1")[0]?.text ?? "";
    expect(text.length).toBeLessThan(2000);
    expect(text.endsWith("…")).toBe(true);
  });

  it("clear resets entries and round", () => {
    const m = new MemberMemory();
    m.round = 4;
    m.note("m1", "x");
    m.clear();
    expect(m.entries("m1")).toHaveLength(0);
    expect(m.round).toBe(0);
  });
});
