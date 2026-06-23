import { describe, expect, it } from "vitest";
import { estimateHistoryTokens, estimateMessageTokens, estimateTokens } from "./tokenEstimate.js";
import type { Message } from "./types.js";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up (ceil) to whole tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3/4 -> 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 -> 2
  });
});

describe("estimateMessageTokens", () => {
  it("counts content plus per-message framing", () => {
    const m: Message = { role: "user", content: "hello" }; // 5/4 -> 2, +4
    expect(estimateMessageTokens(m)).toBe(6);
  });

  it("includes tool-call name and serialized arguments", () => {
    const bare: Message = { role: "assistant", content: "" };
    const withCall: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "write_file", arguments: { path: "a.ts", content: "x" } }],
    };
    expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateMessageTokens(bare));
  });
});

describe("estimateHistoryTokens", () => {
  it("is 0 for no messages", () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });

  it("is the sum of per-message estimates and grows monotonically", () => {
    const a: Message = { role: "user", content: "hi" };
    const b: Message = { role: "assistant", content: "hello there" };
    expect(estimateHistoryTokens([a, b])).toBe(estimateMessageTokens(a) + estimateMessageTokens(b));
    expect(estimateHistoryTokens([a, b])).toBeGreaterThan(estimateHistoryTokens([a]));
  });
});
