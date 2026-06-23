import type { Message, ToolSchema } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { toAnthropicConversation, toAnthropicTools } from "./anthropic.js";

describe("toAnthropicConversation", () => {
  it("hoists system messages into the top-level system string", () => {
    const messages: Message[] = [
      { role: "system", content: "be terse" },
      { role: "system", content: "use tools" },
      { role: "user", content: "hi" },
    ];
    const { system, messages: out } = toAnthropicConversation(messages);
    expect(system).toBe("be terse\n\nuse tools");
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps assistant tool calls to tool_use content blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "t1", name: "read", arguments: { path: "a.ts" } }],
      },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me read it" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
      ],
    });
  });

  it("maps tool messages to user tool_result blocks", () => {
    const messages: Message[] = [
      { role: "tool", content: "file contents", toolCallId: "t1", name: "read" },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
    });
  });

  it("never emits empty assistant content", () => {
    const { messages: out } = toAnthropicConversation([{ role: "assistant", content: "" }]);
    expect(out[0]).toEqual({ role: "assistant", content: [{ type: "text", text: " " }] });
  });

  it("returns undefined system when there are no system messages", () => {
    const { system } = toAnthropicConversation([{ role: "user", content: "hi" }]);
    expect(system).toBeUndefined();
  });
});

describe("toAnthropicTools", () => {
  it("maps parameters to input_schema", () => {
    const tools: ToolSchema[] = [
      {
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    expect(toAnthropicTools(tools)).toEqual([
      {
        name: "read",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });
});
