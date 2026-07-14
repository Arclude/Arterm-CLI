import { type AgentEvent, EventBus, MemberMemory } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { makeMemoTool } from "./memo.js";

const ctx = { cwd: process.cwd() };

function setup() {
  const memory = new MemberMemory();
  memory.round = 2;
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  const tool = makeMemoTool({ memory, selfId: "m1-coder", selfName: "coder", bus });
  return { memory, bus, events, tool };
}

describe("makeMemoTool", () => {
  it("stores a private note stamped with the current round", async () => {
    const { memory, tool } = setup();
    const res = await tool.execute({ text: "ruled out the regex approach" }, ctx);
    expect(res.output).toContain("next round");

    const entry = memory.entries("m1-coder")[0];
    expect(entry?.kind).toBe("note");
    expect(entry?.round).toBe(2);
    expect(entry?.text).toBe("ruled out the regex approach");
  });

  it("surfaces the note as a team_memory event", async () => {
    const { events, tool } = setup();
    await tool.execute({ text: "ruled out the regex approach" }, ctx);

    const evt = events.find((e) => e.type === "team_memory");
    expect(evt?.type === "team_memory" && evt.member).toBe("m1-coder");
    expect(evt?.type === "team_memory" && evt.memberName).toBe("coder");
    expect(evt?.type === "team_memory" && evt.round).toBe(2);
    expect(evt?.type === "team_memory" && evt.kind).toBe("note");
    expect(evt?.type === "team_memory" && evt.text).toBe("ruled out the regex approach");
  });

  it("truncates a very long note on the event stream", async () => {
    const { events, tool } = setup();
    await tool.execute({ text: "x".repeat(2000) }, ctx);
    const evt = events.find((e) => e.type === "team_memory");
    const text = evt?.type === "team_memory" ? evt.text : "";
    expect(text.length).toBeLessThan(2000);
    expect(text.endsWith("…")).toBe(true);
  });

  it("hands the note back to its author next round", async () => {
    const { memory, tool } = setup();
    await tool.execute({ text: "Foo must stay sync" }, ctx);
    memory.round = 3;
    expect(memory.recall("m1-coder")).toContain("Foo must stay sync");
    expect(memory.recall("m2-reviewer")).toBe("");
  });

  it("marks the preview as private", () => {
    const { tool } = setup();
    expect(tool.preview?.({ text: "x" })).toContain("private");
  });
});
