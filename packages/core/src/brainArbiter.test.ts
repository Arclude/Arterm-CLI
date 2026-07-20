import { describe, expect, it } from "vitest";
import { createBrainArbiterStage } from "./brainArbiter.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { Pipeline } from "./kernel/pipeline.js";
import type { ToolCallCtx } from "./kernel/pipeline.js";
import type { ChatChunk, ChatProvider, ChatRequest, Tool } from "./types.js";

/** A provider whose gatekeeper always replies with `verdict`. */
function verdictProvider(verdict: string): ChatProvider {
  return {
    id: "stub",
    supportsNativeTools: () => true,
    listModels: async () => [],
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text", delta: verdict };
    },
  };
}

const runTool: Tool = {
  name: "run",
  description: "",
  parameters: {},
  permission: "ask",
  category: "execute",
  execute: async () => ({ output: "" }),
};

const readTool: Tool = {
  name: "read",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "" }),
};

/** Build a toolCall pipeline: the arbiter before a terminal stage that records reaching execute. */
function pipelineWith(provider: ChatProvider, tools: Tool[], bus: EventBus) {
  let reached = false;
  const p = new Pipeline<ToolCallCtx>();
  p.use("permission", async (ctx, next) => {
    reached = true;
    ctx.output = "executed";
    await next();
  });
  p.before(
    "permission",
    createBrainArbiterStage({
      provider,
      model: "guard",
      bus,
      toolFor: (name) => tools.find((t) => t.name === name),
    }),
  );
  return { p, reachedExecute: () => reached };
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

describe("createBrainArbiterStage (small-model gatekeeper)", () => {
  it("blocks an execute-category call the gatekeeper flags", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const { p, reachedExecute } = pipelineWith(verdictProvider("BLOCK"), [runTool], bus);
    const ctx = await p.run({ call: { id: "c1", name: "run", arguments: { cmd: "rm -rf /" } } });
    expect(ctx.isError).toBe(true);
    expect(reachedExecute()).toBe(false); // short-circuited before permission
    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
  });

  it("passes an execute call the gatekeeper approves through to permission", async () => {
    const bus = new EventBus();
    const { p, reachedExecute } = pipelineWith(verdictProvider("SAFE"), [runTool], bus);
    const ctx = await p.run({ call: { id: "c2", name: "run", arguments: { cmd: "npm test" } } });
    expect(reachedExecute()).toBe(true);
    expect(ctx.output).toBe("executed");
  });

  it("never screens read-category calls (skips straight to permission)", async () => {
    const bus = new EventBus();
    // Even a BLOCK verdict must not apply — read tools bypass the gatekeeper.
    const { p, reachedExecute } = pipelineWith(verdictProvider("BLOCK"), [readTool], bus);
    const ctx = await p.run({ call: { id: "c3", name: "read", arguments: {} } });
    expect(reachedExecute()).toBe(true);
    expect(ctx.isError).toBeUndefined();
  });

  it("fails open when the gatekeeper model errors", async () => {
    const bus = new EventBus();
    const throwing: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      chat(): AsyncIterable<ChatChunk> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(new Error("model down")),
            };
          },
        };
      },
    };
    const { p, reachedExecute } = pipelineWith(throwing, [runTool], bus);
    const ctx = await p.run({ call: { id: "c4", name: "run", arguments: {} } });
    expect(reachedExecute()).toBe(true); // fail-open — the call still reaches permission
    expect(ctx.isError).toBeUndefined();
  });
});
