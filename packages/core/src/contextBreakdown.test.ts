import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { EventBus } from "./eventBus.js";
import { PermissionManager } from "./permissions.js";
import type { ChatChunk, ChatProvider, ChatRequest, Message, Tool } from "./types.js";

function provider(native: boolean): ChatProvider {
  return {
    id: "fake",
    supportsNativeTools: async () => native,
    listModels: async () => [],
    async *chat(_req: ChatRequest): AsyncGenerator<ChatChunk> {
      yield { type: "done" };
    },
  };
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo the input back, for tests that need a tool schema present.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  permission: "allow",
  execute: async () => ({ output: "ok" }),
};

function agent(opts: { native: boolean; tools?: Tool[]; messages?: Message[] }): Agent {
  return new Agent({
    provider: provider(opts.native),
    model: "fake",
    tools: opts.tools ?? [],
    permissions: new PermissionManager({}, "yolo"),
    ask: async () => "deny",
    bus: new EventBus(),
    cwd: process.cwd(),
    systemPrompt: "You are a test agent.",
    initialMessages: opts.messages ?? [],
  });
}

describe("contextBreakdown", () => {
  it("separates the conversation from the tool output filling the window", () => {
    // The distinction the gauge cannot make: 80% of conversation and 80% of
    // tool results are different problems, and only one is fixed by compacting.
    const messages: Message[] = [
      { role: "user", content: "find the parser" },
      { role: "assistant", content: "looking" },
      { role: "tool", content: "x".repeat(4000), name: "grep" },
    ];
    return agent({ native: true, messages })
      .contextBreakdown()
      .then((b) => {
        expect(b.toolResults).toBeGreaterThan(900);
        expect(b.conversation).toBeGreaterThan(0);
        expect(b.conversation).toBeLessThan(b.toolResults);
        expect(b.messages).toBe(3);
      });
  });

  it("counts the tool schemas once, wherever the model takes them", async () => {
    // Native: the schemas go through the API field, so they are their own line.
    const native = await agent({ native: true, tools: [echoTool] }).contextBreakdown();
    expect(native.nativeTools).toBe(true);
    expect(native.tools).toBeGreaterThan(0);

    // Text-protocol: the schemas ARE part of the system message. Counting them
    // again as `tools` would inflate the only number a reader can act on.
    const text = await agent({ native: false, tools: [echoTool] }).contextBreakdown();
    expect(text.nativeTools).toBe(false);
    expect(text.tools).toBe(0);
    expect(text.system).toBeGreaterThan(native.system);
  });

  it("sums to its own total, which is not the reported usage", async () => {
    const a = agent({
      native: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const b = await a.contextBreakdown();
    expect(b.total).toBe(b.system + b.tools + b.conversation + b.toolResults);
    // `contextUsage()` prefers the provider's reported prompt tokens; the
    // breakdown is always the estimate. Presenting them as one number would
    // show a discrepancy nothing on screen could explain.
    expect(a.contextUsage().estimated).toBe(true);
  });

  it("has a system cost even with no history at all", async () => {
    // An empty session is not an empty context: the prompt and the project
    // instructions are already in it, which is why a fresh gauge is not at 0%.
    const b = await agent({ native: true }).contextBreakdown();
    expect(b.system).toBeGreaterThan(0);
    expect(b.conversation).toBe(0);
    expect(b.messages).toBe(0);
  });
});
