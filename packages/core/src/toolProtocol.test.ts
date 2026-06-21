import { describe, expect, it } from "vitest";
import { parseToolCalls } from "./toolProtocol.js";

describe("parseToolCalls", () => {
  it("extracts a single fenced json tool call", () => {
    const text = 'Let me read it.\n```json\n{"tool": "read", "args": {"path": "a.ts"}}\n```';
    const { calls, cleaned } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("read");
    expect(calls[0]?.arguments).toEqual({ path: "a.ts" });
    expect(cleaned).toBe("Let me read it.");
  });

  it("returns no calls for plain prose", () => {
    const { calls } = parseToolCalls("Just a normal answer with no tools.");
    expect(calls).toHaveLength(0);
  });

  it("defaults missing args to an empty object", () => {
    const { calls } = parseToolCalls('```json\n{"tool": "ls"}\n```');
    expect(calls[0]?.arguments).toEqual({});
  });

  it("supports an array of calls in one block", () => {
    const text = '```json\n[{"tool":"read","args":{"path":"a"}},{"tool":"ls","args":{}}]\n```';
    const { calls } = parseToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["read", "ls"]);
  });

  it("ignores malformed json", () => {
    const { calls } = parseToolCalls("```json\n{not valid}\n```");
    expect(calls).toHaveLength(0);
  });
});
