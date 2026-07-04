import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import type { ContextStrategy } from "./contextStrategy.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { Container, RunController, Tokens, createPipelines } from "./kernel/index.js";
import { PermissionManager } from "./permissions.js";
import type { ChatChunk, ChatProvider, ChatRequest, Message, Tool } from "./types.js";

/**
 * A scriptable provider: each `chat()` call emits the next entry from `script`
 * (a list of chunks), defaulting to a single final-answer text chunk. Records the
 * signal it was handed so tests can assert cancellation is threaded through.
 */
class StubProvider implements ChatProvider {
  readonly id = "stub";
  calls = 0;
  lastSignal?: AbortSignal;
  lastMessages?: Message[];
  constructor(private readonly script: ChatChunk[][] = []) {}
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels() {
    return [];
  }
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.lastSignal = req.signal;
    this.lastMessages = req.messages;
    const chunks = this.script[this.calls] ?? [{ type: "text", delta: "done" }];
    this.calls += 1;
    for (const chunk of chunks) yield chunk;
  }
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

function makeAgent(provider: ChatProvider, bus: EventBus, tools: Tool[] = []): Agent {
  return new Agent({
    provider,
    model: "m",
    tools,
    permissions: new PermissionManager({}, "yolo"),
    ask: async () => "allow",
    bus,
    cwd: process.cwd(),
  });
}

describe("Agent initialMessages (resume)", () => {
  it("seeds conversation history from initialMessages", () => {
    const seeded: Message[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const agent = new Agent({
      provider: new StubProvider(),
      model: "test-model",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: process.cwd(),
      initialMessages: seeded,
    });
    expect(agent.history).toEqual(seeded);
  });

  it("starts with empty history when no initialMessages are given", () => {
    const agent = makeAgent(new StubProvider(), new EventBus());
    expect(agent.history).toEqual([]);
  });
});

describe("Agent run lifecycle (RunController)", () => {
  it("emits turn_start and exactly one turn_end on a clean run", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(new StubProvider(), bus).run("hi");
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_end");
  });

  it("a pre-aborted external signal short-circuits the loop but still finishes cleanly", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider();
    const controller = new AbortController();
    controller.abort();
    await makeAgent(provider, bus).run("hi", controller.signal);
    // The model is never asked (loop breaks before streaming), yet turn_end fires once.
    expect(provider.calls).toBe(0);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  it("an external abort mid-run stops further iterations", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    let exec = 0;
    const noop: Tool = {
      name: "noop",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => {
        exec += 1;
        controller.abort(); // cancel the turn from inside the first tool call
        return { output: "" };
      },
    };
    // Every round asks to call `noop`; without the abort this would loop to maxIterations.
    const provider = new StubProvider(
      Array.from({ length: 12 }, () => [
        { type: "tool_call", call: { id: "c", name: "noop", arguments: {} } } as ChatChunk,
      ]),
    );
    await makeAgent(provider, bus, [noop]).run("go", controller.signal);
    // The tool ran once; the linked abort broke the outer loop before a second round.
    expect(exec).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("threads the run's signal into the provider stream", async () => {
    const bus = new EventBus();
    const provider = new StubProvider();
    await makeAgent(provider, bus).run("hi");
    expect(provider.lastSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("Agent auto-compaction (contextWindow pipeline)", () => {
  /** A strategy that drops the oldest message each time it is asked to compact. */
  const dropOldest: ContextStrategy = {
    id: "drop-oldest",
    compact: async (messages: Message[]) => {
      const after = Math.max(1, messages.length - 1);
      return { messages: messages.slice(messages.length - after), before: messages.length, after };
    },
  };

  it("fires compaction through the pipeline once the threshold is crossed", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const agent = new Agent({
      provider: new StubProvider(),
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      context: dropOldest,
      contextWindow: 1,
      compactAtPercent: 0, // any non-empty history is "over budget"
    });
    await agent.run("a"); // history: [user, assistant] — single msg at compact time, no-op
    await agent.run("b"); // now >1 msg at the top of the turn → compaction emits
    expect(events.some((e) => e.type === "context_compacted")).toBe(true);
  });

  it("uses a pre-registered contextWindow stage instead of installing its own", async () => {
    const bus = new EventBus();
    const pipelines = createPipelines();
    let ran = 0;
    pipelines.contextWindow.use("autoCompact", async (_ctx, next) => {
      ran += 1;
      await next();
    });
    const container = new Container();
    container.bind(Tokens.Pipelines, () => pipelines);
    container.bind(Tokens.RunController, () => new RunController(container));
    const agent = new Agent({
      provider: new StubProvider(),
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      container,
    });
    await agent.run("hi"); // one no-tool turn → one loop iteration → stage runs once
    expect(ran).toBe(1);
  });
});

describe("Agent tool calls (toolCall pipeline)", () => {
  /** A provider that emits one tool_call on the first turn, then a final text answer. */
  function callThenDone(name: string): StubProvider {
    return new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name, arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
  }

  it("executes an allowed tool through the pipeline and records its output", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const echo: Tool = {
      name: "echo",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: "hello" }),
    };
    await makeAgent(callThenDone("echo"), bus, [echo]).run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "echo", output: "hello", isError: false });
  });

  it("records an error for an unknown tool without a permission prompt", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callThenDone("ghost"), bus, []).run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "ghost", isError: true });
    expect((result as { output: string }).output).toContain("Unknown tool");
    expect(events.some((e) => e.type === "tool_denied")).toBe(false);
  });

  it("emits tool_denied and an error result when permission is refused", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const danger: Tool = {
      name: "danger",
      description: "",
      parameters: {},
      permission: "ask",
      category: "edit",
      execute: async () => ({ output: "should not run" }),
    };
    const agent = new Agent({
      provider: callThenDone("danger"),
      model: "m",
      tools: [danger],
      permissions: new PermissionManager({}, "ask"),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
    });
    await agent.run("go");
    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "danger", isError: true });
  });

  it("uses a pre-registered execute stage instead of running the tool", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const pipelines = createPipelines();
    pipelines.toolCall.use("execute", async (ctx, next) => {
      ctx.output = "OVERRIDE";
      ctx.isError = false;
      await next();
    });
    const container = new Container();
    container.bind(Tokens.Pipelines, () => pipelines);
    container.bind(Tokens.RunController, () => new RunController(container));
    let ran = false;
    const echo: Tool = {
      name: "echo",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => {
        ran = true;
        return { output: "real" };
      },
    };
    const agent = new Agent({
      provider: callThenDone("echo"),
      model: "m",
      tools: [echo],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      container,
    });
    await agent.run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ output: "OVERRIDE" });
    expect(ran).toBe(false); // the default execute stage was replaced
  });

  it("leaves a tool result for every call when aborted mid-tool-loop (no orphan)", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "t", arguments: {} } },
        { type: "tool_call", call: { id: "c2", name: "t", arguments: {} } },
      ],
      [{ type: "text", delta: "done" }],
    ]);
    const controller = new AbortController();
    const t: Tool = {
      name: "t",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      // Abort the turn once the first call starts executing.
      execute: async () => {
        controller.abort();
        return { output: "ok" };
      },
    };
    await makeAgent(provider, bus, [t]).run("go", controller.signal);

    const results = events.filter((e) => e.type === "tool_result") as Array<{
      callId: string;
      isError: boolean;
      output: string;
    }>;
    // Both recorded tool_calls must have a matching tool result, or the next turn's
    // history would have an assistant tool_call with no tool message.
    expect(results.map((r) => r.callId).sort()).toEqual(["c1", "c2"]);
    const c2 = results.find((r) => r.callId === "c2");
    expect(c2?.isError).toBe(true);
    expect(c2?.output).toContain("cancelled");
  });
});

describe("Agent streaming seams (userInput / request / response / assistantOutput)", () => {
  it("records the user message via the userInput pipeline", async () => {
    const bus = new EventBus();
    const agent = makeAgent(new StubProvider(), bus);
    await agent.run("remember this");
    expect(agent.history[0]).toMatchObject({ role: "user", content: "remember this" });
  });

  it("recovers a JSON tool call from the text body via the response pipeline", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    let ran = false;
    const echo: Tool = {
      name: "echo",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => {
        ran = true;
        return { output: "ok" };
      },
    };
    // First turn: no native tool_call, just text carrying a {name,arguments} call.
    // Second turn: a plain final answer so the loop terminates.
    const provider = new StubProvider([
      [{ type: "text", delta: '{"name": "echo", "arguments": {}}' }],
      [{ type: "text", delta: "done" }],
    ]);
    await makeAgent(provider, bus, [echo]).run("go");
    expect(ran).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
  });

  it("sends the request pipeline's system message to the provider", async () => {
    const bus = new EventBus();
    const pipelines = createPipelines();
    pipelines.request.use("buildSystem", async (ctx, next) => {
      ctx.system = { role: "system", content: "SENTINEL-SYSTEM" };
      await next();
    });
    const container = new Container();
    container.bind(Tokens.Pipelines, () => pipelines);
    container.bind(Tokens.RunController, () => new RunController(container));
    const provider = new StubProvider();
    const agent = new Agent({
      provider,
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      container,
    });
    await agent.run("hi");
    expect(provider.lastMessages?.[0]).toMatchObject({ content: "SENTINEL-SYSTEM" });
  });

  it("lets a pre-registered assistantOutput stage suppress the announcement", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const pipelines = createPipelines();
    pipelines.assistantOutput.use("record", async (_ctx, next) => {
      // Swallow the message: neither record nor emit. Proves the seam is replaceable.
      await next();
    });
    const container = new Container();
    container.bind(Tokens.Pipelines, () => pipelines);
    container.bind(Tokens.RunController, () => new RunController(container));
    const agent = new Agent({
      provider: new StubProvider(),
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      container,
    });
    await agent.run("hi");
    expect(events.some((e) => e.type === "assistant_message")).toBe(false);
    expect(agent.history.some((m) => m.role === "assistant")).toBe(false);
  });
});

/** A provider whose `chat()` rejects on first iteration — models a network outage. */
class ThrowingProvider implements ChatProvider {
  readonly id = "boom";
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels() {
    return [];
  }
  chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatChunk> {
        return { next: () => Promise.reject(new Error("network down")) };
      },
    };
  }
}

describe("Agent.assess / plan resilience", () => {
  it("assess() resolves not-done instead of rejecting when the provider throws", async () => {
    const agent = makeAgent(new ThrowingProvider(), new EventBus());
    const verdict = await agent.assess("ship it");
    expect(verdict.done).toBe(false);
    expect(verdict.note).toMatch(/assessment failed/i);
  });

  it("plan() resolves an empty string instead of rejecting when the provider throws", async () => {
    const agent = makeAgent(new ThrowingProvider(), new EventBus());
    expect(await agent.plan("decompose the goal")).toBe("");
  });
});

describe("Agent.run pre-try I/O safety", () => {
  it("surfaces a failed user-message persist as an error event and still fires turn_end", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const agent = new Agent({
      provider: new StubProvider(),
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      onMessage: (m) => {
        if (m.role === "user") throw new Error("disk full");
      },
    });
    // Must not reject — a transcript-write failure should degrade gracefully.
    await expect(agent.run("hello")).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });
});
