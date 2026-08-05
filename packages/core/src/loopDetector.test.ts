import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import type { ResponseCtx, ToolCallCtx } from "./kernel/pipeline.js";
import { createLoopDetector } from "./loopDetector.js";
import { PermissionManager } from "./permissions.js";
import type { ChatChunk, ChatProvider, ChatRequest, Tool, ToolCall } from "./types.js";

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: "x",
  name,
  arguments: args,
});

describe("createLoopDetector — iteration fingerprint (response stage)", () => {
  async function runIteration(
    det: ReturnType<typeof createLoopDetector>,
    calls: ToolCall[],
  ): Promise<ResponseCtx> {
    const ctx: ResponseCtx = { text: "", calls };
    await det.responseStage(ctx, async () => {});
    return ctx;
  }

  it("steers at steerAfter identical iterations (note delivered on the next tool result)", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    await runIteration(det, [call("read", { path: "a" })]);
    await runIteration(det, [call("read", { path: "a" })]);
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
    await runIteration(det, [call("read", { path: "a" })]);
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
    // The note rides the iteration's first tool result.
    const tctx: ToolCallCtx = { call: call("read", { path: "a" }), output: "data" };
    await det.toolCallStage(tctx, async () => {});
    expect(tctx.output).toContain("[loop-guard]");
    expect(tctx.output).toContain("DIFFERENT approach");
  });

  it("cuts at cutAfter identical iterations by emptying the calls", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 0; i < 4; i++) await runIteration(det, [call("read")]);
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(0);
    const ctx = await runIteration(det, [call("read")]);
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(1);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.text).toContain("[loop-cut]");
  });

  it("a different batch resets the streak; text-only iterations are skipped, not resets", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 5 });
    await runIteration(det, [call("read", { path: "a" })]);
    await runIteration(det, [call("read", { path: "b" })]); // different args → streak back to 1
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
    await runIteration(det, []); // text-only (a step ending) — streak unchanged
    await runIteration(det, [call("read", { path: "b" })]); // same as before the gap → streak 2
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
  });
});

describe("createLoopDetector — sliding window (toolCall stage)", () => {
  async function runCall(
    det: ReturnType<typeof createLoopDetector>,
    c: ToolCall,
  ): Promise<ToolCallCtx> {
    const ctx: ToolCallCtx = { call: c, output: "out" };
    await det.toolCallStage(ctx, async () => {});
    return ctx;
  }

  it("catches A-B-A-B alternation a consecutive counter misses", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5, window: 10 });
    await runCall(det, call("a"));
    await runCall(det, call("b"));
    await runCall(det, call("a"));
    await runCall(det, call("b"));
    const third = await runCall(det, call("a")); // third "a" within the window
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
    expect(third.output).toContain("identical arguments");
  });

  it("evicts old calls: repeats spread wider than the window never trip it", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 5, window: 2 });
    await runCall(det, call("a"));
    await runCall(det, call("b"));
    await runCall(det, call("c"));
    await runCall(det, call("a")); // the first "a" already left the 2-slot window
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
  });

  it("window repeats reaching cutAfter cut the NEXT iteration, not mid-batch", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 3, window: 10 });
    for (let i = 0; i < 3; i++) await runCall(det, call("a"));
    // No cut yet — cutting mid-batch would orphan recorded tool_calls.
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(0);
    const ctx: ResponseCtx = { text: "", calls: [call("anything")] };
    await det.responseStage(ctx, async () => {});
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(1);
    expect(ctx.calls).toHaveLength(0);
  });

  it("resetTurn clears the window but keeps the iteration fingerprint", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 9, window: 10 });
    await runCall(det, call("a"));
    det.resetTurn();
    await runCall(det, call("a")); // window emptied → count 1, no note
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
    // Fingerprint survives resetTurn: two identical iterations across a "turn
    // boundary" still count as a streak of 2.
    const it1: ResponseCtx = { text: "", calls: [call("a")] };
    await det.responseStage(it1, async () => {});
    det.resetTurn();
    const it2: ResponseCtx = { text: "", calls: [call("a")] };
    await det.responseStage(it2, async () => {});
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
  });
});

/** Scriptable provider (agent.test.ts pattern): one chunk list per chat() call. */
class StubProvider implements ChatProvider {
  readonly id = "stub";
  calls = 0;
  constructor(private readonly script: ChatChunk[][] = []) {}
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels() {
    return [];
  }
  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    const chunks = this.script[this.calls] ?? [{ type: "text", delta: "done" }];
    this.calls += 1;
    for (const chunk of chunks) yield chunk;
  }
}

const echo: Tool = {
  name: "echo",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "ok" }),
};

const sameCall = (): ChatChunk[] => [
  { type: "tool_call", call: { id: "c", name: "echo", arguments: { n: 1 } } },
];

describe("loop detector wired into the Agent (default stages)", () => {
  function makeAgent(provider: ChatProvider, bus: EventBus): Agent {
    // No session container — this is the sub-agent construction path, proving
    // fleet workers get the detector too.
    return new Agent({
      provider,
      model: "m",
      tools: [echo],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      loopDetect: { steerAfter: 2, cutAfter: 3 },
    });
  }

  it("cuts a run that repeats the same call every iteration", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([sameCall(), sameCall(), sameCall(), sameCall()]);
    await makeAgent(provider, bus).run("go");
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(1);
    // Iterations 1-3 ran (the third was cut before its calls executed).
    expect(events.filter((e) => e.type === "tool_result").length).toBe(2);
  });

  it("fingerprint streak persists ACROSS run() calls (the eternal-step case)", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    // Each run() makes one identical iteration then ends: only the cross-turn
    // fingerprint can see the repetition.
    const script: ChatChunk[][] = [];
    for (let i = 0; i < 3; i++) {
      script.push(sameCall(), [{ type: "text", delta: "step over" }]);
    }
    const agent = makeAgent(new StubProvider(script), bus);
    await agent.run("step 1");
    await agent.run("step 2");
    expect(events.filter((e) => e.type === "loop_detected").length).toBeGreaterThan(0);
  });

  it("{ enabled: false } installs no detector stages", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([sameCall(), sameCall(), sameCall(), sameCall(), []]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [echo],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      loopDetect: { enabled: false, steerAfter: 2, cutAfter: 3 },
    });
    await agent.run("go");
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(0);
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
  });
});
