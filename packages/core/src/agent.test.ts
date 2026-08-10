import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, readAssessment } from "./agent.js";
import { RunBudget } from "./budget.js";
import { DEFAULT_CONTEXT_WINDOW } from "./config.js";
import type { ContextStrategy } from "./contextStrategy.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { Container, RunController, Tokens, createPipelines } from "./kernel/index.js";
import { PermissionManager } from "./permissions.js";
import { ProviderError } from "./providerError.js";
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
  lastTools?: unknown;
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
    this.lastTools = req.tools;
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

  it("clears stale tool results with placeholders past the clear threshold, keeping recent ones", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const big = "x".repeat(400);
    const tool: Tool = {
      name: "read",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: big }),
    };
    // Four tool turns then a final answer — four tool results accrue in history.
    const provider = new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name: "read", arguments: { n: 1 } } }],
      [{ type: "tool_call", call: { id: "c2", name: "read", arguments: { n: 2 } } }],
      [{ type: "tool_call", call: { id: "c3", name: "read", arguments: { n: 3 } } }],
      [{ type: "tool_call", call: { id: "c4", name: "read", arguments: { n: 4 } } }],
      [{ type: "text", delta: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [tool],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      contextWindow: 1,
      clearAtPercent: 0, // any history is "over the clear line"
      keepRecentToolResults: 2,
    });
    await agent.run("go");
    const cleared = agent.history.filter(
      (m) => m.role === "tool" && m.content.includes("[cleared"),
    );
    const intact = agent.history.filter((m) => m.role === "tool" && m.content === big);
    // Oldest two collapsed to placeholders; newest two kept verbatim.
    expect(cleared.length).toBe(2);
    expect(intact.length).toBe(2);
    expect(events.some((e) => e.type === "tool_results_cleared")).toBe(true);
  });

  it("does not clear when clearToolResults is disabled", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const tool: Tool = {
      name: "read",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: "y".repeat(400) }),
    };
    const provider = new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name: "read", arguments: {} } }],
      [{ type: "tool_call", call: { id: "c2", name: "read", arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [tool],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      contextWindow: 1,
      clearAtPercent: 0,
      keepRecentToolResults: 0,
      clearToolResults: false,
    });
    await agent.run("go");
    expect(events.some((e) => e.type === "tool_results_cleared")).toBe(false);
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

describe("Agent project-instruction auto-load (AGENTS.md)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-agents-"));
    await fs.writeFile(join(dir, "AGENTS.md"), "Always run the linter before finishing.", "utf8");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("injects the project instruction file into the system prompt", async () => {
    const provider = new StubProvider();
    const agent = new Agent({
      provider,
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: dir,
    });
    await agent.run("hi");
    const system = provider.lastMessages?.[0]?.content ?? "";
    expect(system).toContain("Project instructions from AGENTS.md");
    expect(system).toContain("Always run the linter before finishing.");
  });

  it("omits the instruction section when no file is present", async () => {
    const empty = await fs.mkdtemp(join(tmpdir(), "arterm-empty-"));
    try {
      const provider = new StubProvider();
      const agent = new Agent({
        provider,
        model: "m",
        tools: [],
        permissions: new PermissionManager({}, "yolo"),
        ask: async () => "allow",
        bus: new EventBus(),
        cwd: empty,
      });
      await agent.run("hi");
      expect(provider.lastMessages?.[0]?.content ?? "").not.toContain("Project instructions from");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
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

  it("plan() does not tell the model it has tools it was not given", async () => {
    // `plan()` passes no `tools`. Sending the agentic system prompt anyway asks a
    // capable model to act with tools it does not have, and it answers by
    // NARRATING the call — a real Opus run replied to "write a spec and a task
    // graph" with "Let me inspect the log file first. **Tool: read**". That parses
    // as neither, so /sdd fell back to one task with a garbage spec and called it
    // a success. Small local models never showed it.
    const provider = new StubProvider();
    const tool: Tool = {
      name: "ls",
      description: "list files",
      parameters: { type: "object", properties: {} },
      permission: "allow",
      execute: async () => ({ output: "" }),
    };
    const agent = makeAgent(provider, new EventBus(), [tool]);

    await agent.plan("Reply with ONLY a JSON array.");

    const system = provider.lastMessages?.[0];
    expect(system?.role).toBe("system");
    const text = String(system?.content);
    expect(text).not.toContain("ls: list files");
    expect(text).toMatch(/no tools/i);
    // The project layout still goes along — planning needs to know what is there.
    expect(text).toContain("Working directory");
    // And no tools were offered on the request either.
    expect(provider.lastTools).toBeUndefined();
  });
});

describe("Agent loop guards & limits (loopGuard stage / run_limit event)", () => {
  const failing: Tool = {
    name: "boom",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    execute: async () => ({ output: "boom: file not found", isError: true }),
  };
  const echo: Tool = {
    name: "echo",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    execute: async () => ({ output: "ok" }),
  };
  const call = (id: string, name: string): ChatChunk[] => [
    { type: "tool_call", call: { id, name, arguments: {} } },
  ];

  it("flags the second consecutive identical tool failure with a loop-guard note", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      call("c1", "boom"),
      call("c2", "boom"),
      [{ type: "text", delta: "giving up" }],
    ]);
    await makeAgent(provider, bus, [failing]).run("go");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect((results[0] as { output: string }).output).not.toContain("[loop-guard]");
    expect((results[1] as { output: string }).output).toContain("[loop-guard]");
    expect((results[1] as { output: string }).output).toContain("failed 2x");
  });

  it("a success in between resets the failure streak", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const flaky: Tool = {
      ...failing,
      execute: (() => {
        let n = 0;
        return async () => (++n === 2 ? { output: "ok" } : { output: "err", isError: true });
      })(),
    };
    const provider = new StubProvider([
      call("c1", "boom"),
      call("c2", "boom"),
      call("c3", "boom"),
      [{ type: "text", delta: "done" }],
    ]);
    await makeAgent(provider, bus, [flaky]).run("go");
    const results = events.filter((e) => e.type === "tool_result");
    // fail, ok, fail — the SAME-ERROR streak never reaches 2, so the failure
    // note never fires. (The repeat-window half may still flag the third
    // identical call — that is repetition, a different fact than failure.)
    for (const r of results) {
      expect((r as { output: string }).output).not.toContain("in a row");
    }
    expect((results[1] as { output: string }).output).not.toContain("[loop-guard]");
  });

  it("flags the third identical successful call as no-progress", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      call("c1", "echo"),
      call("c2", "echo"),
      call("c3", "echo"),
      [{ type: "text", delta: "done" }],
    ]);
    await makeAgent(provider, bus, [echo]).run("go");
    const results = events.filter((e) => e.type === "tool_result");
    expect((results[1] as { output: string }).output).not.toContain("[loop-guard]");
    expect((results[2] as { output: string }).output).toContain("identical arguments");
  });

  it("stops the turn and emits run_limit(tokens) once the budget is spent", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "echo", arguments: {} } },
        { type: "done", usage: { promptTokens: 90, completionTokens: 20 } },
      ],
      [{ type: "text", delta: "should never run" }],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [echo],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      turnTokenBudget: 100,
    });
    await agent.run("go");
    expect(provider.calls).toBe(1); // the second iteration never starts
    const limit = events.find((e) => e.type === "run_limit");
    expect(limit).toMatchObject({ kind: "tokens", limit: 100, used: 110 });
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  it("emits run_limit(iterations) when the cap is exhausted mid-work", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([call("c1", "echo"), call("c2", "echo")]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [echo],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      maxIterations: 2,
    });
    await agent.run("go");
    const limit = events.find((e) => e.type === "run_limit");
    expect(limit).toMatchObject({ kind: "iterations", limit: 2, used: 2 });
  });

  it("a clean run emits no run_limit", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(new StubProvider(), bus).run("hi");
    expect(events.some((e) => e.type === "run_limit")).toBe(false);
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

describe("error event taxonomy", () => {
  /** A provider that fails the way a real one does — with a typed error. */
  class FailingProvider implements ChatProvider {
    readonly id = "failing";
    constructor(private readonly err: unknown) {}
    supportsNativeTools(): boolean {
      return true;
    }
    async listModels() {
      return [];
    }
    // biome-ignore lint/correctness/useYield: it fails before producing anything
    async *chat(): AsyncIterable<ChatChunk> {
      throw this.err;
    }
  }

  it("carries the provider taxonomy so a UI can tell quota from a dead key", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const agent = makeAgent(
      new FailingProvider(
        new ProviderError("rate limited", { provider: "anthropic", kind: "quota", status: 429 }),
      ),
      bus,
    );

    await agent.run("hello");

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({
      kind: "quota",
      provider: "anthropic",
      status: 429,
      retryable: true,
    });
  });

  it("leaves the taxonomy absent for a failure that isn't a provider's", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const agent = makeAgent(new FailingProvider(new Error("something local broke")), bus);

    await agent.run("hello");

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ error: "something local broke" });
    expect((error as { kind?: string }).kind).toBeUndefined();
  });
});

describe("run budget (agent pipeline stages)", () => {
  const noop: Tool = {
    name: "noop",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    execute: async () => ({ output: "ok" }),
  };

  function agentWith(budget: RunBudget, provider: StubProvider, bus: EventBus): Agent {
    return new Agent({
      provider,
      model: "m",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
      budget,
    });
  }

  it("meters from the provider's OWN usage, never an estimate of the history", async () => {
    // Every iteration resends the conversation, so estimating from the message
    // list would re-bill the whole history on each lap.
    const bus = new EventBus();
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "1", name: "noop", arguments: {} } },
        { type: "done", usage: { promptTokens: 700, completionTokens: 300, totalTokens: 1000 } },
      ],
      [
        { type: "text", delta: "finished" },
        { type: "done", usage: { totalTokens: 500 } },
      ],
    ]);
    const budget = new RunBudget({ tokens: 100_000, catalog: [] });
    await agentWith(budget, provider, bus).run("go");
    expect(budget.state().tokens).toBe(1500);
  });

  it("refuses the next request once the ceiling is reached, instead of paying past it", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    // Each response asks for another tool call, so nothing but the budget ends this.
    const provider = new StubProvider(
      Array.from({ length: 10 }, () => [
        { type: "tool_call" as const, call: { id: "1", name: "noop", arguments: {} } },
        { type: "done" as const, usage: { totalTokens: 400 } },
      ]),
    );
    const budget = new RunBudget({ tokens: 1000, catalog: [] });
    await agentWith(budget, provider, bus).run("go");

    // Three calls: the third crosses 1000, the fourth is refused before it is
    // sent — the gate is pre-spend, so a breach costs nothing.
    expect(provider.calls).toBe(3);
    expect(events.some((e) => e.type === "budget_exceeded")).toBe(true);
    expect(budget.breached).toBe(true);
  });

  it("announces the soft threshold once per run", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider(
      Array.from({ length: 10 }, () => [
        { type: "tool_call" as const, call: { id: "1", name: "noop", arguments: {} } },
        { type: "done" as const, usage: { totalTokens: 300 } },
      ]),
    );
    const budget = new RunBudget({ tokens: 1200, softRatio: 0.5, catalog: [] });
    await agentWith(budget, provider, bus).run("go");

    expect(events.filter((e) => e.type === "budget_warning")).toHaveLength(1);
  });

  it("tells the model how much wall-clock time is left, on every request", async () => {
    let t = 1_000_000;
    const bus = new EventBus();
    const provider = new StubProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const budget = new RunBudget({ seconds: 600, now: () => t, catalog: [] });
    t += 60_000;
    await agentWith(budget, provider, bus).run("go");
    const system = provider.lastMessages?.[0]?.content ?? "";
    expect(system).toContain("TIME:");
    expect(system).toContain("~540s left");
    expect(system).not.toContain("reserve phase");
  });

  // Being killed mid-edit is strictly worse than stopping with the same work
  // reported, so the last stretch stops starting things.
  it("switches the clock line to a reserve-phase instruction past the soft ratio", async () => {
    let t = 1_000_000;
    const bus = new EventBus();
    const provider = new StubProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const budget = new RunBudget({ seconds: 600, softRatio: 0.75, now: () => t, catalog: [] });
    t += 500_000;
    await agentWith(budget, provider, bus).run("go");
    const system = provider.lastMessages?.[0]?.content ?? "";
    expect(system).toContain("reserve phase");
    expect(system).toContain("do NOT start new work");
  });

  it("says nothing about time when no wall-clock ceiling is set", async () => {
    const bus = new EventBus();
    const provider = new StubProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const budget = new RunBudget({ tokens: 100_000, catalog: [] });
    await agentWith(budget, provider, bus).run("go");
    expect(provider.lastMessages?.[0]?.content ?? "").not.toContain("TIME:");
  });

  it("refuses the next request once the wall clock is spent, and says why", async () => {
    let t = 1_000_000;
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider(
      Array.from({ length: 5 }, () => [
        { type: "tool_call" as const, call: { id: "1", name: "noop", arguments: {} } },
        { type: "done" as const },
      ]),
    );
    const budget = new RunBudget({ seconds: 300, now: () => t, catalog: [] });
    t += 301_000;
    await agentWith(budget, provider, bus).run("go");
    expect(provider.calls).toBe(0);
    expect(events.some((e) => e.type === "budget_exceeded")).toBe(true);
  });

  it("meters spend with no ceiling configured, but gates and announces nothing", async () => {
    // Accounting used to be installed only when a limit existed, which made
    // every unlimited run report zero tokens and zero cost — indistinguishable
    // from a backend that counts nothing, and wrong for anything that reads
    // spend (the `--json` usage block, GenAI token metrics, a bench trial).
    // Reporting is not conditional on limiting; only the guard is.
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "text", delta: "hi" },
        { type: "done", usage: { totalTokens: 9_999_999 } },
      ],
    ]);
    const budget = new RunBudget({ catalog: [] });
    await agentWith(budget, provider, bus).run("go");

    expect(budget.state().tokens).toBe(9_999_999);
    expect(budget.breached).toBe(false);
    expect(events.some((e) => e.type.startsWith("budget_"))).toBe(false);
  });
});

describe("context usage reporting", () => {
  const noop: Tool = {
    name: "noop",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    execute: async () => ({ output: "ok" }),
  };

  it("reports the provider's figure when there is one", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "1", name: "noop", arguments: {} } },
        { type: "done", usage: { promptTokens: 1234, totalTokens: 1234 } },
      ],
      [{ type: "text", delta: "done" }, { type: "done" }],
    ]);
    await new Agent({
      provider,
      model: "m",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
      contextWindow: 10_000,
    }).run("go");

    const usage = events.filter((e) => e.type === "context_usage");
    const last = usage.at(-1);
    expect(last && "used" in last && last.used).toBe(1234);
    expect(last && "estimated" in last && last.estimated).toBe(false);
  });

  it("estimates when the provider reports nothing — a 0% gauge is a lie, not a default", async () => {
    // Plenty of local servers send no usage at all. The meter used to read 0%
    // right up until the agent compacted, which says "there is room" while
    // there is none.
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([[{ type: "text", delta: "hello" }, { type: "done" }]]);
    await new Agent({
      provider,
      model: "m",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
      contextWindow: 10_000,
    }).run("a reasonably long user message that certainly costs some tokens");

    const first = events.find((e) => e.type === "context_usage");
    expect(first && "used" in first && first.used).toBeGreaterThan(0);
    expect(first && "estimated" in first && first.estimated).toBe(true);
  });

  it("agrees with the compaction decision — one definition, not two", async () => {
    // The gauge and the auto-compactor read the same method, so the bar can
    // never say "plenty of room" on the turn the agent decides to compact.
    const bus = new EventBus();
    const agent = new Agent({
      provider: new StubProvider(),
      model: "m",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
      contextWindow: 10_000,
    });
    const usage = agent.contextUsage();
    expect(usage.window).toBe(10_000);
    expect(usage.estimated).toBe(true);
  });
});

/**
 * `usageHint` is the long-form "how to use this well" text. It is deliberately
 * NOT in the roster the model sees every turn — the roster is paid for on every
 * request, so a paragraph per tool would cost far more than it teaches.
 */
describe("usage hints", () => {
  const failing = (usageHint?: string): Tool => ({
    name: "picky",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    ...(usageHint ? { usageHint } : {}),
    execute: async () => ({ output: "no.", isError: true }),
  });

  /** A provider that calls the tool once, then answers. */
  function callOnce(name: string): StubProvider {
    return new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name, arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
  }

  /** A provider that calls the same tool twice, then answers. */
  function callTwice(name: string): StubProvider {
    return new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name, arguments: {} } }],
      [{ type: "tool_call", call: { id: "c2", name, arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
  }

  it("attaches the hint to the tool's FIRST failure, where it is needed", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnce("picky"), bus, [failing("hold it by the handle")]).run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect((result as { output: string }).output).toContain("hold it by the handle");
  });

  it("says it once — a hint repeated on every failure is just a longer error", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callTwice("picky"), bus, [failing("hold it by the handle")]).run("go");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect((results[0] as { output: string }).output).toContain("hold it by the handle");
    expect((results[1] as { output: string }).output).not.toContain("hold it by the handle");
  });

  it("stays out of a SUCCESSFUL call's output", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const ok: Tool = { ...failing("never shown"), execute: async () => ({ output: "fine" }) };
    await makeAgent(callOnce("picky"), bus, [ok]).run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect((result as { output: string }).output).toBe("fine");
  });

  it("is absent for a tool that does not define one", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnce("picky"), bus, [failing()]).run("go");
    const result = events.find((e) => e.type === "tool_result");
    expect((result as { output: string }).output).toBe("no.");
  });
});

/**
 * The ceiling on what a tool may put into the context, enforced where every
 * tool passes rather than inside each one — including MCP and plugin tools,
 * written by someone else and capped at nothing.
 */
describe("tool output ceiling", () => {
  const loud = (bytes: number, max?: number): Tool => ({
    name: "loud",
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    ...(max !== undefined ? { maxOutputBytes: max } : {}),
    execute: async () => ({ output: `HEAD${"x".repeat(bytes)}TAIL` }),
  });

  function callOnceNamed(name: string): StubProvider {
    return new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name, arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
  }

  it("clamps a tool past its own ceiling, keeping both ends", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnceNamed("loud"), bus, [loud(50_000, 2000)]).run("go");
    const result = events.find((e) => e.type === "tool_result") as { output: string };
    expect(result.output.length).toBeLessThan(5000);
    expect(result.output).toContain("HEAD");
    expect(result.output).toContain("TAIL");
    expect(result.output).toContain("cut from the middle");
  });

  it("points at the full output on disk, so the command need not be re-run", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnceNamed("loud"), bus, [loud(50_000, 2000)]).run("go");
    const result = events.find((e) => e.type === "tool_result") as { output: string };
    expect(result.output).toMatch(/\[full output: .+\]/);
  });

  it("leaves output under the ceiling exactly as the tool returned it", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnceNamed("loud"), bus, [loud(10, 2000)]).run("go");
    const result = events.find((e) => e.type === "tool_result") as { output: string };
    expect(result.output).toBe(`HEAD${"x".repeat(10)}TAIL`);
  });

  it("applies a backstop to a tool that declares no ceiling", async () => {
    // The MCP/plugin case: a megabyte of JSON from a third-party tool used to
    // land in the context whole.
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(callOnceNamed("loud"), bus, [loud(400_000)]).run("go");
    const result = events.find((e) => e.type === "tool_result") as { output: string };
    expect(result.output).toContain("cut from the middle");
  });

  /**
   * The retrieval end of the spool, which is invisible to either unit alone:
   * `read` admits `ctx.spooled` and the agent fills it, and each side passes
   * its own tests while the announced path stays unopenable. That is exactly
   * how the feature shipped decorative the first time.
   */
  const announced = (output: string): string | undefined =>
    /\[full output: (.+)\]/.exec(output)?.[1];

  it("admits the path it announced on the NEXT call, so the model can open it", async () => {
    /** Records the spool allowance it is handed, which is the seam under test. */
    let handed: ReadonlySet<string> | undefined;
    const peek: Tool = {
      name: "peek",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async (_args, ctx) => {
        handed = new Set(ctx.spooled ?? []);
        return { output: "ok" };
      },
    };
    const provider = new StubProvider([
      [{ type: "tool_call", call: { id: "c1", name: "loud", arguments: {} } }],
      [{ type: "tool_call", call: { id: "c2", name: "peek", arguments: {} } }],
      [{ type: "text", delta: "done" }],
    ]);
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(provider, bus, [loud(50_000, 2000), peek]).run("go");

    const first = events.find((e) => e.type === "tool_result") as { output: string };
    const path = announced(first.output);
    expect(path).toBeTruthy();
    expect(handed?.has(path as string)).toBe(true);
  });

  it("keeps the allowance to what THIS run spooled, never the directory", async () => {
    let handed: ReadonlySet<string> | undefined;
    const peek: Tool = {
      name: "peek",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async (_args, ctx) => {
        handed = new Set(ctx.spooled ?? []);
        return { output: "ok" };
      },
    };
    const bus = new EventBus();
    await makeAgent(callOnceNamed("peek"), bus, [peek]).run("go");
    // A sibling session's spool sits in the same directory; a run that spooled
    // nothing must be handed nothing.
    expect(handed?.size).toBe(0);
  });

  it("points a re-read of a spool at the same file instead of minting another", async () => {
    /** Calls `loud`, then calls it again naming the path the first announced. */
    class ReadBackProvider implements ChatProvider {
      readonly id = "stub";
      calls = 0;
      supportsNativeTools(): boolean {
        return true;
      }
      async listModels() {
        return [];
      }
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        const n = this.calls++;
        if (n === 0) {
          yield { type: "tool_call", call: { id: "c1", name: "loud", arguments: {} } };
          return;
        }
        if (n === 1) {
          const said = req.messages
            .flatMap((m) => (typeof m.content === "string" ? [m.content] : []))
            .map(announced)
            .find((p): p is string => p !== undefined);
          yield {
            type: "tool_call",
            call: { id: "c2", name: "loud", arguments: { path: said ?? "" } },
          };
          return;
        }
        yield { type: "text", delta: "done" };
      }
    }
    const bus = new EventBus();
    const events = collect(bus);
    await makeAgent(new ReadBackProvider(), bus, [loud(50_000, 2000)]).run("go");

    const results = events.filter((e) => e.type === "tool_result") as { output: string }[];
    expect(results).toHaveLength(2);
    const first = announced(results[0]?.output ?? "");
    expect(first).toBeTruthy();
    expect(announced(results[1]?.output ?? "")).toBe(first);
  });
});

/**
 * The leader's own two calls. Both are "best effort" by design — the tolerant
 * parsers fall back to running the goal whole — and both used to be best effort
 * in a way that made a total failure indistinguishable from a decision.
 */
describe("Agent.plan / Agent.assess — the leader's own calls", () => {
  class DeadProvider implements ChatProvider {
    readonly id = "ollama";
    supportsNativeTools(): boolean {
      return false;
    }
    async listModels() {
      return [];
    }
    // biome-ignore lint/correctness/useYield: it throws before it can yield
    async *chat(): AsyncIterable<ChatChunk> {
      throw new ProviderError("ollama: fetch failed (ECONNREFUSED)", {
        provider: "ollama",
        kind: "network",
      });
    }
  }

  it("says the planning call failed instead of returning a silent empty plan", async () => {
    // The bug: an unreachable provider returned "", the team loop read that as
    // "the leader proposed no work", and the run exited 0 saying so. The empty
    // plan is still the right RETURN — the loop keeps control — but the failure
    // has to leave a trace, or a dead provider reads as a decision.
    const bus = new EventBus();
    const events = collect(bus);
    const agent = makeAgent(new DeadProvider(), bus);

    expect(await agent.plan("decompose this")).toBe("");

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error" });
    const text = (errors[0] as { error: string }).error;
    expect(text).toContain("planning call failed");
    expect(text).toContain("ollama");
    expect(text).toContain("ECONNREFUSED");
  });

  it("stays quiet when the failure is the caller's own cancellation", async () => {
    // A stopped run is not a provider fault, and an error line per aborted
    // planning call would make /stop look like a crash.
    const bus = new EventBus();
    const events = collect(bus);
    const agent = makeAgent(new DeadProvider(), bus);
    const ctrl = new AbortController();
    ctrl.abort();

    expect(await agent.plan("decompose this", ctrl.signal)).toBe("");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("counts what the leader spends — planning tokens are not free", async () => {
    // A whole /team run reported `usd: 0, reported: false`: every token it burned
    // was the leader's, and plan() read only the text chunks.
    const bus = new EventBus();
    const events = collect(bus);
    const budget = new RunBudget({ tokens: 1_000_000 });
    const provider = new StubProvider([
      [
        { type: "text", delta: "1. do a thing" },
        { type: "done", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
      ],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      budget,
    });

    await agent.plan("decompose this");

    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const state = budget.state();
    expect(state.tokens).toBe(120);
    // `reported: false` beside a nonzero cost is the row that made a real /team
    // run look free. It has to flip the moment the leader is billed at all.
    expect(state.reported).toBe(true);
  });

  it("counts what an assessment spends too", async () => {
    const bus = new EventBus();
    const budget = new RunBudget({ tokens: 1_000_000 });
    const provider = new StubProvider([
      [
        { type: "text", delta: "DONE" },
        { type: "done", usage: { promptTokens: 40, completionTokens: 2, totalTokens: 42 } },
      ],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
      budget,
    });

    const verdict = await agent.assess("ship it");
    expect(verdict.done).toBe(true);
    expect(budget.state().tokens).toBe(42);
  });
});

describe("readAssessment — the leader's completion verdict", () => {
  it("does not read the word 'done' out of a sentence that says the opposite", () => {
    // The real reply that ended a real run. It is a model saying it is NOT
    // finished; `\bDONE\b` found the word inside "declaring done" and returned
    // the opposite of what the sentence means.
    const reply = "Let me verify the actual state of the main working tree before declaring done.";
    expect(readAssessment(reply).done).toBe(false);
  });

  it("accepts the one-word answer the prompt asks for, however it is decorated", () => {
    for (const reply of ["DONE", "done", "DONE.", "**DONE**", '"DONE"', "DONE — all three exist"]) {
      expect(readAssessment(reply).done, reply).toBe(true);
    }
  });

  it("accepts a verdict a reasoning model puts on the last line", () => {
    expect(readAssessment("Checked all three modules and the gate.\n\nDONE").done).toBe(true);
  });

  it("CONTINUE wins wherever it sits, and prose alone is never done", () => {
    expect(readAssessment("DONE\n\nCONTINUE: one test still fails").done).toBe(false);
    expect(readAssessment("The first two files are done, the third is not.").done).toBe(false);
    expect(readAssessment("Nothing is done yet.").done).toBe(false);
    expect(readAssessment("").done).toBe(false);
  });

  it("keeps the reply as the note either way", () => {
    expect(readAssessment("CONTINUE: write the table module").note).toContain("table module");
  });
});

describe("concurrent tool calls", () => {
  /** A tool that takes `delayMs` and logs when it starts and finishes. */
  function timedTool(name: string, delayMs: number, log: string[], over: Partial<Tool> = {}): Tool {
    return {
      name,
      description: name,
      parameters: { type: "object" },
      permission: "allow",
      category: "read",
      concurrent: true,
      execute: async () => {
        log.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        log.push(`end:${name}`);
        return { output: name };
      },
      ...over,
    };
  }

  /** One assistant turn asking for every call at once, then a final answer. */
  function turnCalling(...calls: Array<[string, string]>): StubProvider {
    return new StubProvider([
      calls.map(([id, name]) => ({ type: "tool_call", call: { id, name, arguments: {} } })),
      [{ type: "text", delta: "done" }],
    ]);
  }

  function agentWith(
    provider: ChatProvider,
    bus: EventBus,
    tools: Tool[],
    perms?: PermissionManager,
  ) {
    return new Agent({
      provider,
      model: "m",
      tools,
      permissions: perms ?? new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus,
      cwd: process.cwd(),
    });
  }

  it("overlaps safe calls instead of waiting for each in turn", async () => {
    const log: string[] = [];
    // `slow` is asked for first but finishes last. Serially that is impossible;
    // the finish order IS the proof, with no wall-clock threshold to go flaky.
    const tools = [timedTool("slow", 40, log), timedTool("quick", 1, log)];
    await agentWith(turnCalling(["c1", "slow"], ["c2", "quick"]), new EventBus(), tools).run("go");

    expect(log).toEqual(["start:slow", "start:quick", "end:quick", "end:slow"]);
  });

  it("records results in the order ASKED, not the order they finished", async () => {
    // The hazard the batch introduces. A provider pairs tool_use with
    // tool_result, and a history that answers the second call first is a
    // transcript no run can reproduce — and one some native APIs reject.
    const log: string[] = [];
    const bus = new EventBus();
    const tools = [timedTool("slow", 40, log), timedTool("quick", 1, log)];
    const agent = agentWith(turnCalling(["c1", "slow"], ["c2", "quick"]), bus, tools);
    await agent.run("go");

    const results = agent.history.filter((m) => m.role === "tool");
    expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    expect(results.map((m) => m.content)).toEqual(["slow", "quick"]);
  });

  // Admission by the paths a CALL touches. `category: "read"` was standing in
  // for "cannot conflict", which is false for two writes to unrelated files.
  it("overlaps two writes to DIFFERENT files", async () => {
    const log: string[] = [];
    const writer = (name: string, delay: number, path: string): Tool => ({
      ...timedTool(name, delay, log, { category: "edit", mutating: true }),
      reservation: () => ({ reads: [], writes: [path] }),
    });
    const tools = [writer("slow", 40, "/p/a.ts"), writer("quick", 1, "/p/b.ts")];
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "slow", arguments: {} } },
        { type: "tool_call", call: { id: "c2", name: "quick", arguments: {} } },
      ],
      [{ type: "text", delta: "done" }],
    ]);
    await agentWith(provider, new EventBus(), tools).run("go");
    expect(log).toEqual(["start:slow", "start:quick", "end:quick", "end:slow"]);
  });

  it("serializes two writes to the SAME file", async () => {
    const log: string[] = [];
    const writer = (name: string, delay: number): Tool => ({
      ...timedTool(name, delay, log, { category: "edit", mutating: true }),
      reservation: () => ({ reads: [], writes: ["/p/same.ts"] }),
    });
    const tools = [writer("slow", 40), writer("quick", 1)];
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "slow", arguments: {} } },
        { type: "tool_call", call: { id: "c2", name: "quick", arguments: {} } },
      ],
      [{ type: "text", delta: "done" }],
    ]);
    await agentWith(provider, new EventBus(), tools).run("go");
    expect(log).toEqual(["start:slow", "end:slow", "start:quick", "end:quick"]);
  });

  // The relaxation is a PREDICTION of the permission stage's answer, sound only
  // while nothing ahead of that stage can change it. An arbiter is exactly such
  // a stage, and eight predicted allows becoming eight prompts is the failure.
  it("withdraws write admission when a stage sits before permission", async () => {
    const log: string[] = [];
    const writer = (name: string, delay: number, path: string): Tool => ({
      ...timedTool(name, delay, log, { category: "edit", mutating: true }),
      reservation: () => ({ reads: [], writes: [path] }),
    });
    const tools = [writer("slow", 40, "/p/a.ts"), writer("quick", 1, "/p/b.ts")];
    const provider = new StubProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "slow", arguments: {} } },
        { type: "tool_call", call: { id: "c2", name: "quick", arguments: {} } },
      ],
      [{ type: "text", delta: "done" }],
    ]);
    const pipelines = createPipelines();
    pipelines.toolCall.before("permission", async (_ctx, next) => {
      await next();
    });
    const container = new Container();
    container.bind(Tokens.Pipelines, () => pipelines);
    container.bind(Tokens.RunController, () => new RunController(container));
    const agent = new Agent({
      provider,
      model: "m",
      tools,
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: process.cwd(),
      container,
    });
    await agent.run("go");
    expect(log).toEqual(["start:slow", "end:slow", "start:quick", "end:quick"]);
  });

  it("keeps a tool that did not declare itself concurrent serial", async () => {
    // Absent means no. `bash` and every tool added later stay one at a time
    // until someone has thought about whether they may overlap.
    const log: string[] = [];
    const tools = [
      timedTool("slow", 40, log, { concurrent: undefined }),
      timedTool("quick", 1, log, { concurrent: undefined }),
    ];
    await agentWith(turnCalling(["c1", "slow"], ["c2", "quick"]), new EventBus(), tools).run("go");

    expect(log).toEqual(["start:slow", "end:slow", "start:quick", "end:quick"]);
  });

  it("will not overlap calls that would each raise a permission prompt", async () => {
    // Eight prompts at once into one terminal is the failure. `evaluate` returns
    // `prompt` as a distinct outcome precisely so this is answerable without
    // asking anyone.
    const log: string[] = [];
    const tools = [timedTool("slow", 40, log), timedTool("quick", 1, log)];
    const asking = new PermissionManager({ slow: "ask", quick: "ask" }, "ask");
    await agentWith(
      turnCalling(["c1", "slow"], ["c2", "quick"]),
      new EventBus(),
      tools,
      asking,
    ).run("go");

    expect(log).toEqual(["start:slow", "end:slow", "start:quick", "end:quick"]);
  });

  it("does not hoist safe calls past an unsafe one between them", async () => {
    const log: string[] = [];
    const tools = [
      timedTool("r1", 20, log),
      timedTool("gate", 1, log, { concurrent: undefined }),
      timedTool("r2", 1, log),
    ];
    await agentWith(
      turnCalling(["c1", "r1"], ["c2", "gate"], ["c3", "r2"]),
      new EventBus(),
      tools,
    ).run("go");

    // r1 alone, then the gate, then r2 — the slow read must still complete
    // before the gate starts, or the ordering the model wrote is not honored.
    expect(log).toEqual(["start:r1", "end:r1", "start:gate", "end:gate", "start:r2", "end:r2"]);
  });
});

describe("streamed reasoning", () => {
  it("announces thinking without ever recording it", async () => {
    // The rule the chunk kind exists for. `text` becomes the assistant message,
    // which becomes the transcript, the next request's history, and every later
    // compaction — so reasoning that leaked into it would be re-sent, re-billed
    // and re-summarized for the rest of the session.
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "thinking", delta: "the user wants the parser" },
        { type: "text", delta: "here it is" },
      ],
    ]);
    const agent = makeAgent(provider, bus);
    await agent.run("go");

    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
    const assistant = agent.history.filter((m) => m.role === "assistant");
    expect(assistant.map((m) => m.content)).toEqual(["here it is"]);
    expect(JSON.stringify(agent.history)).not.toContain("the user wants the parser");
  });

  it("ends the turn on the answer, not on the reasoning that preceded it", async () => {
    // A `thinking` chunk must not read as "the model produced no text", which
    // is the condition the loop breaks on. `run()` records rather than returns,
    // so the committed assistant message is the observable.
    const bus = new EventBus();
    const events = collect(bus);
    const provider = new StubProvider([
      [
        { type: "thinking", delta: "thinking hard" },
        { type: "text", delta: "done" },
      ],
    ]);
    const agent = makeAgent(provider, bus);
    await agent.run("go");

    const committed = events.filter((e) => e.type === "assistant_message");
    expect(committed).toHaveLength(1);
    expect(agent.history.at(-1)?.content).toBe("done");
    // One provider call: the reasoning did not send the loop round again.
    expect(provider.calls).toBe(1);
  });
});

/**
 * What the agent believes the context window is.
 *
 * The belief drives compaction, tool-result clearing and the gauge, and for a
 * model the catalog does not carry it was silently `context.window`'s default —
 * 8192, a number sized for a local GGUF. Measured against the live endpoint,
 * glm-5.2 accepted a 512,013-token prompt, so every GLM session had been
 * compacting against a window sixty times too small.
 */
describe("the context window, known and assumed", () => {
  /** Reports a fixed prompt-token count, the way every real provider does. */
  const reporting = (promptTokens: number): StubProvider =>
    new StubProvider([[{ type: "done", usage: { promptTokens, completionTokens: 1 } }]]);

  const agentWith = (provider: ChatProvider, contextWindow?: number): Agent =>
    new Agent({
      provider,
      model: "not-in-any-catalog",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: process.cwd(),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });

  it("never believes a window smaller than a prompt that was ACCEPTED", async () => {
    // The absurd state this fixes: 13,275 tokens in flight against a window of
    // 8,192, i.e. a gauge reading 162% and a threshold already behind us.
    const agent = agentWith(reporting(13_275), 8_192);
    expect(agent.effectiveContextWindow()).toBe(8_192);
    await agent.run("go");
    expect(agent.effectiveContextWindow()).toBe(13_275);
  });

  it("raises the floor only — a bigger stated window still wins", async () => {
    const agent = agentWith(reporting(9_000), 200_000);
    await agent.run("go");
    expect(agent.effectiveContextWindow()).toBe(200_000);
  });

  it("says the window is assumed, and names the number it assumed", () => {
    const note = agentWith(reporting(10), 8_192).contextWindowNote();
    expect(note).toContain("not in the model catalog");
    expect(note).toContain("8,192");
    expect(note).toContain("context.window");
  });

  it("adds the proof once it has one", async () => {
    const agent = agentWith(reporting(50_000), 8_192);
    await agent.run("go");
    // A floor it can prove beats an adjective: the note carries the number the
    // provider already accepted, which is what makes the warning actionable.
    expect(agent.contextWindowNote()).toContain("50,000");
  });

  it("stays quiet when nothing was assumed", () => {
    expect(agentWith(reporting(10)).contextWindowNote()).toBeUndefined();
  });
});

/**
 * The warning must not become wallpaper. A value the user chose is a decision,
 * and repeating it every session is how a useful line turns into one people
 * learn to scroll past — so only the untouched default earns it.
 */
describe("the assumed-window warning stays rare", () => {
  const agentWindow = (contextWindow: number): Agent =>
    new Agent({
      provider: new StubProvider(),
      model: "not-in-any-catalog",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: process.cwd(),
      contextWindow,
    });

  it("warns about the default", () => {
    expect(agentWindow(DEFAULT_CONTEXT_WINDOW).contextWindowNote()).toBeDefined();
  });

  it("says nothing once a window has been chosen deliberately", () => {
    expect(agentWindow(512_000).contextWindowNote()).toBeUndefined();
    // Including a smaller deliberate one: the user's number is the user's.
    expect(agentWindow(4_096).contextWindowNote()).toBeUndefined();
  });
});

describe("Agent.note — the tool-less turn that stays in history", () => {
  it("offers NO tools on the wire, and keeps the exchange in history", async () => {
    // The quadrant aggregate() needed: run() is tools+history, plan()/assess()
    // are tool-less probes that leave no trace. Built on run() with a prose
    // "do not call any tools", the integration step did the fleet's job itself
    // on a live GLM run — 78 parent-side tool executions. Structural now.
    const provider = new StubProvider([[{ type: "text", delta: "integrated: A is done" }]]);
    const bus = new EventBus();
    const agent = makeAgent(provider, bus, [
      {
        name: "write",
        description: "w",
        parameters: { type: "object", properties: {} },
        permission: "allow",
        async execute() {
          return { output: "" };
        },
      },
    ]);

    const out = await agent.note("Round 1 produced these results: A built.");

    expect(out).toBe("integrated: A is done");
    // The seam the whole fix rests on: the request carried no tool schemas,
    // so there is nothing the model can execute, whatever it answers.
    expect(provider.lastTools).toBeUndefined();
    // And unlike plan(), the exchange accumulates for the next round.
    const history = agent.history;
    expect(history.at(-2)?.content).toContain("Round 1 produced");
    expect(history.at(-1)?.content).toBe("integrated: A is done");
  });

  it("records nothing on a failed call — no bare user turn left behind", async () => {
    const provider = new (class implements ChatProvider {
      readonly id = "dead";
      supportsNativeTools(): boolean {
        return false;
      }
      async listModels() {
        return [];
      }
      // biome-ignore lint/correctness/useYield: a provider that dies before its first chunk is the case under test
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error("ECONNREFUSED");
      }
    })();
    const bus = new EventBus();
    const events = collect(bus);
    const agent = makeAgent(provider, bus);

    const out = await agent.note("integrate this");

    expect(out).toBe("");
    expect(agent.history).toHaveLength(0);
    // Best-effort but never silent — plan()'s policy.
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
