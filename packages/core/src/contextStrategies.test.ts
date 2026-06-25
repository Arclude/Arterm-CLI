import { describe, expect, it, vi } from "vitest";
import type { ArtermConfig } from "./config.js";
import { createContextStrategy } from "./contextRegistry.js";
import { NoneStrategy, WindowStrategy, cleanCut, isCleanBoundary } from "./contextStrategies.js";
import type { Message } from "./types.js";

const ctx = { estimatedTokens: 0, model: "test", reason: "manual" as const };

function user(text: string): Message {
  return { role: "user", content: text };
}
function asst(text: string): Message {
  return { role: "assistant", content: text };
}
function callMsg(id: string): Message {
  return { role: "assistant", content: "", toolCalls: [{ id, name: "read", arguments: {} }] };
}
function toolMsg(id: string): Message {
  return { role: "tool", content: "result", toolCallId: id, name: "read" };
}

/** A tool result is valid only if a preceding assistant message carries its id. */
function hasOrphanToolResult(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (m.role !== "tool") continue;
    const ok = messages
      .slice(0, i)
      .some((p) => p.role === "assistant" && p.toolCalls?.some((c) => c.id === m.toolCallId));
    if (!ok) return true;
  }
  return false;
}

describe("NoneStrategy", () => {
  it("returns the history unchanged", () => {
    const msgs = [user("a"), asst("b")];
    const out = new NoneStrategy().compact(msgs, ctx);
    expect(out.messages).toBe(msgs);
    expect(out.before).toBe(2);
    expect(out.after).toBe(2);
  });
});

describe("WindowStrategy", () => {
  it("leaves history untouched when under the message limit", () => {
    const msgs = [user("a"), asst("b")];
    const out = new WindowStrategy({ maxMessages: 10 }).compact(msgs, ctx);
    expect(out.messages).toEqual(msgs);
    expect(out.after).toBe(2);
  });

  it("trims to roughly the last N messages", () => {
    const msgs = [user("1"), asst("2"), user("3"), asst("4"), user("5"), asst("6")];
    const out = new WindowStrategy({ maxMessages: 2 }).compact(msgs, ctx);
    expect(out.before).toBe(6);
    expect(out.after).toBeLessThanOrEqual(3); // last 2, snapped back to a clean boundary
    expect(out.messages[0]?.role === "user" || out.messages[0]?.role === "assistant").toBe(true);
  });

  it("never orphans a tool result when the cut lands mid tool-pair", () => {
    // Cutting to the last 2 would start at tool(c1); must snap back to the
    // assistant tool-call (or earlier) so the pair stays intact.
    const msgs = [user("start"), callMsg("c1"), toolMsg("c1"), asst("done")];
    const out = new WindowStrategy({ maxMessages: 2 }).compact(msgs, ctx);
    expect(hasOrphanToolResult(out.messages)).toBe(false);
  });

  it("always starts the kept slice at a clean boundary", () => {
    const msgs = [
      user("u1"),
      callMsg("c1"),
      toolMsg("c1"),
      callMsg("c2"),
      toolMsg("c2"),
      asst("final"),
    ];
    const out = new WindowStrategy({ maxMessages: 1 }).compact(msgs, ctx);
    expect(isCleanBoundary(out.messages[0] as Message)).toBe(true);
    expect(hasOrphanToolResult(out.messages)).toBe(false);
  });
});

describe("cleanCut", () => {
  it("snaps a mid-pair index back to the assistant tool-call", () => {
    const msgs = [user("u"), callMsg("c1"), toolMsg("c1")];
    // desiredStart = 2 (tool result) -> must snap back to 0 (the clean user msg).
    expect(cleanCut(msgs, 2)).toEqual(msgs);
  });
});

describe("createContextStrategy", () => {
  it("returns NoneStrategy for 'none'", () => {
    const s = createContextStrategy({ context: { strategy: "none" } } as ArtermConfig);
    expect(s).toBeInstanceOf(NoneStrategy);
  });

  it("falls back to WindowStrategy (does not throw) for the unimplemented 'summary'", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const s = createContextStrategy({ context: { strategy: "summary" } } as ArtermConfig);
    expect(s).toBeInstanceOf(WindowStrategy);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws on an unknown strategy", () => {
    expect(() =>
      createContextStrategy({ context: { strategy: "bogus" } } as unknown as ArtermConfig),
    ).toThrow(/Unknown context strategy/);
  });
});
