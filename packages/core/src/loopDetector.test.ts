import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import type { ResponseCtx, ToolCallCtx } from "./kernel/pipeline.js";
import { createLoopDetector, tailCycle } from "./loopDetector.js";
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

describe("result-aware repetition", () => {
  const iterate = async (
    det: ReturnType<typeof createLoopDetector>,
    calls: ToolCall[],
    result: string,
  ): Promise<void> => {
    const res: ResponseCtx = { text: "", calls };
    await det.responseStage(res, async () => {});
    for (const c of calls) {
      const ctx: ToolCallCtx = { call: c, output: result };
      await det.toolCallStage(ctx, async () => {});
    }
  };

  it("does not count identical calls whose RESULTS keep changing", async () => {
    // The false positive that makes people disable a detector outright: a build
    // watcher, a debugger step, a poll — identical calls by design, and every
    // one of them is progress.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 0; i < 8; i++) {
      await iterate(det, [call("bash", { command: "gdb next" })], `stopped at line ${i}`);
    }
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
    expect(events.filter((e) => e.type === "loop_cut")).toHaveLength(0);
  });

  it("still catches identical calls with identical results", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 0; i < 3; i++) {
      await iterate(det, [call("read", { path: "a" })], "same output every time");
    }
    expect(events.filter((e) => e.type === "loop_detected").length).toBeGreaterThan(0);
  });

  it("ignores volatile noise — a timestamp is not progress", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 0; i < 3; i++) {
      await iterate(det, [call("bash", { command: "date" })], `done in ${i * 7}ms at 12:00:0${i}`);
    }
    expect(events.filter((e) => e.type === "loop_detected").length).toBeGreaterThan(0);
  });

  it("does not read a GUARD'S OWN note as progress", async () => {
    // The bug this exists for, measured before it was fixed: `loopGuard`
    // appends "…has now failed 3x in a row…" to a failing tool's output, and
    // `repeatWindow` runs after it in the chain and hashed that output. The
    // count moves every iteration, so the results looked like they were
    // changing, the streak reset to 1 every time, and the CUT never fired — on
    // the most common real stall there is. Twelve identical failing calls
    // produced twelve steers and zero cuts, and the step cap, not the guard,
    // ended the run.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 1; i <= 6; i++) {
      const note =
        i >= 2 ? `\n\n[loop-guard] bash has now failed ${i}x in a row with the same error.` : "";
      await iterate(det, [call("bash", { command: "pnpm build" })], `Tool error: boom${note}`);
    }
    expect(events.filter((e) => e.type === "loop_cut").length).toBeGreaterThan(0);
  });

  it("keeps a tool result that merely QUOTES the marker mid-line", async () => {
    // Reading this very file, or grepping for the marker, must not have its
    // content silently truncated out of the hash — that would make two
    // different reads look identical and invent a loop.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 5 });
    for (let i = 0; i < 4; i++) {
      await iterate(
        det,
        [call("read", { path: "loopDetector.ts" })],
        `line ${i}: const note = "[loop-guard] take a different approach";`,
      );
    }
    // Results genuinely differ line by line, so this is progress, not a loop.
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
  });

  it("exempts tools that repeat by design", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 3, exempt: ["poll"] });
    for (let i = 0; i < 6; i++) {
      const ctx: ToolCallCtx = { call: call("poll"), output: "same" };
      await det.toolCallStage(ctx, async () => {});
    }
    expect(events).toHaveLength(0);
  });
});

describe("argument-agnostic error streak", () => {
  it("catches the same failure reached through DIFFERENT calls", async () => {
    // Structurally invisible to a call fingerprint, and the most common real
    // stall: five different commands, all failing the same way.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 9 });
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      const ctx: ToolCallCtx = {
        call: call("read", { path }),
        output: `ENOENT: no such file or directory, open '${path}'`,
        isError: true,
      };
      await det.toolCallStage(ctx, async () => {});
    }
    const notes = events.filter((e) => e.type === "loop_detected");
    expect(notes).toHaveLength(1);
    expect(notes[0] && "note" in notes[0] && notes[0].note).toContain("different calls");
  });

  it("nudges once per error identity, not once per step", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 2, cutAfter: 9 });
    for (let i = 0; i < 6; i++) {
      const ctx: ToolCallCtx = {
        call: call("bash", { command: `try-${i}` }),
        output: "permission denied",
        isError: true,
      };
      await det.toolCallStage(ctx, async () => {});
    }
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
  });

  it("a success resets the streak — the problem was fixed", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 9 });
    const fail = async (n: number): Promise<void> => {
      const ctx: ToolCallCtx = {
        call: call("read", { path: `${n}.ts` }),
        output: "ENOENT: missing",
        isError: true,
      };
      await det.toolCallStage(ctx, async () => {});
    };
    await fail(1);
    await fail(2);
    const ok: ToolCallCtx = { call: call("write", { path: "1.ts" }), output: "written" };
    await det.toolCallStage(ok, async () => {});
    await fail(3);
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
  });
});

describe("monologue (talking without acting)", () => {
  const textOnlyTurn = async (det: ReturnType<typeof createLoopDetector>): Promise<ResponseCtx> => {
    det.resetTurn();
    const ctx: ResponseCtx = { text: "Let me think about this.", calls: [] };
    await det.responseStage(ctx, async () => {});
    return ctx;
  };

  it("tells the model after 3 consecutive turns with no tool call", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, monologueAfter: 3 });
    await textOnlyTurn(det);
    await textOnlyTurn(det);
    expect(events).toHaveLength(0);
    const third = await textOnlyTurn(det);
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
    // No tool result exists to carry the note, so it rides the reply itself.
    expect(third.text).toContain("no tool call");
  });

  it("a turn that used a tool resets it — productive turns end in text too", async () => {
    // Every eternal step closes with a text-only reply; counting those would
    // fire on a perfectly healthy run.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, monologueAfter: 3 });
    for (let i = 0; i < 5; i++) {
      det.resetTurn();
      const ctx: ToolCallCtx = { call: call("read", { path: `${i}.ts` }), output: `file ${i}` };
      await det.toolCallStage(ctx, async () => {});
      const res: ResponseCtx = { text: "done", calls: [] };
      await det.responseStage(res, async () => {});
    }
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(0);
  });
});

describe("tailCycle", () => {
  it("finds the period of a repeating tail", () => {
    expect(tailCycle(["a", "a", "a"])).toMatchObject({ period: 1, repeats: 3 });
    expect(tailCycle(["a", "b", "a", "b", "a", "b"])).toMatchObject({ period: 2, repeats: 3 });
    expect(tailCycle(["a", "b", "c", "a", "b", "c"])).toMatchObject({ period: 3, repeats: 2 });
  });

  it("reports no cycle for a run that keeps moving", () => {
    expect(tailCycle(["a", "b", "c", "d", "e"]).repeats).toBe(1);
  });
});

describe("compaction does not erase the loop's evidence", () => {
  it("keeps the fingerprint streak across a context compaction", async () => {
    // A logged incident elsewhere: an agent looped ~50 identical iterations,
    // context overflowed, compaction succeeded — and it resumed the SAME loop
    // for 12 more iterations, because compaction had removed the evidence the
    // detector was counting. Our detector holds its state in its own closure
    // rather than in the message list, so compaction cannot reset it. That
    // immunity is incidental unless something pins it.
    const bus = new EventBus();
    const events = collect(bus);
    const det = createLoopDetector({ bus, steerAfter: 3, cutAfter: 9 });
    const iteration = async (): Promise<void> => {
      const ctx: ResponseCtx = { text: "", calls: [call("read", { path: "a" })] };
      await det.responseStage(ctx, async () => {});
    };
    await iteration();
    await iteration();
    // Compaction happens here: the agent rewrites `messages` wholesale. The
    // detector is not told, and must not care.
    await iteration();
    expect(events.filter((e) => e.type === "loop_detected")).toHaveLength(1);
  });
});
