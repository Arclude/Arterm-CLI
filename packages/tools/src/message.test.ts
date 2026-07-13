import { type AgentEvent, Blackboard, EventBus } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { makeMessageTool } from "./message.js";

const ctx = { cwd: process.cwd() };

function setup() {
  const board = new Blackboard();
  board.round = 2;
  board.setRoster([
    { id: "m1-coder", name: "coder" },
    { id: "m2-reviewer", name: "reviewer" },
  ]);
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  const tool = makeMessageTool({ board, selfId: "m1-coder", selfName: "coder", bus });
  return { board, bus, events, tool };
}

describe("makeMessageTool", () => {
  it("broadcasts a note to the whole team", async () => {
    const { board, events, tool } = setup();
    const res = await tool.execute({ text: "parser is ready" }, ctx);
    expect(res.output).toContain("team board");

    const entry = board.entries()[0];
    expect(entry?.from).toBe("m1-coder");
    expect(entry?.to).toBeUndefined();
    expect(entry?.kind).toBe("message");
    expect(entry?.round).toBe(2);

    const evt = events.find((e) => e.type === "team_message");
    expect(evt?.type === "team_message" && evt.to).toBeUndefined();
    expect(evt?.type === "team_message" && evt.text).toBe("parser is ready");
  });

  it("addresses a known teammate directly", async () => {
    const { board, events, tool } = setup();
    const res = await tool.execute({ text: "please re-check types", to: "reviewer" }, ctx);
    expect(res.output).toContain("reviewer");

    const entry = board.entries()[0];
    expect(entry?.to).toBe("m2-reviewer");
    expect(entry?.toName).toBe("reviewer");

    const evt = events.find((e) => e.type === "team_message");
    expect(evt?.type === "team_message" && evt.to).toBe("m2-reviewer");
  });

  it("falls back to a broadcast for an unknown teammate", async () => {
    const { board, tool } = setup();
    const res = await tool.execute({ text: "hi", to: "ghost" }, ctx);
    expect(res.output).toContain("ghost");
    expect(res.output.toLowerCase()).toContain("broadcast");
    expect(board.entries()[0]?.to).toBeUndefined();
  });

  it("previews the direction for the permission prompt", () => {
    const { tool } = setup();
    expect(tool.preview?.({ text: "x", to: "reviewer" })).toContain("→");
    expect(tool.preview?.({ text: "x" })).toContain("broadcast");
  });
});
