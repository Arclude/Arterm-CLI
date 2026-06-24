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

  it("accepts the {name, arguments} shape emitted by local models (qwen/Ollama)", () => {
    const text = '{"name": "get_weather", "arguments": {"city": "Paris"}}';
    const { calls } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("get_weather");
    expect(calls[0]?.arguments).toEqual({ city: "Paris" });
  });

  it("accepts a fenced {name, arguments} block", () => {
    const text = '```json\n{"name": "edit", "arguments": {"path": "a.ts"}}\n```';
    const { calls } = parseToolCalls(text);
    expect(calls[0]?.name).toBe("edit");
    expect(calls[0]?.arguments).toEqual({ path: "a.ts" });
  });

  it("does not treat a bare object with only a name (no arguments) as a tool call", () => {
    const { calls } = parseToolCalls('Here is data: {"name": "John", "age": 3}');
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

  it("recovers a bare (unfenced) tool call", () => {
    const text = 'Sure.\n{"tool": "write_file", "args": {"path": "a.ts", "content": "x"}}';
    const { calls, cleaned } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("write_file");
    expect(calls[0]?.arguments).toEqual({ path: "a.ts", content: "x" });
    expect(cleaned).toBe("Sure.");
  });

  it("recovers a call whose file content embeds ``` fences", () => {
    const content = "# Title\n```js\nconst x = 1;\n```\n";
    const text = `\`\`\`json\n${JSON.stringify({ tool: "write_file", args: { path: "README.md", content } })}\n\`\`\``;
    const { calls } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("write_file");
    expect((calls[0]?.arguments as { content: string }).content).toBe(content);
  });

  it("does not treat plain json objects without a tool field as calls", () => {
    const { calls } = parseToolCalls('Here is config: {"path": "a.ts", "size": 12}');
    expect(calls).toHaveLength(0);
  });

  it("prefers fenced calls and ignores the bare fallback when a fence matched", () => {
    const text = '```json\n{"tool":"read","args":{"path":"a"}}\n```\nNote: {"tool":"ls","args":{}}';
    const { calls } = parseToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["read"]);
  });
});
