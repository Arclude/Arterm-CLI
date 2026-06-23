import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { AutonomyEngine } from "./autonomy.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { PermissionManager } from "./permissions.js";
import type { ChatProvider, Tool } from "./types.js";

const taskDone: Tool = {
  name: "task_done",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "" }),
};

const writeTool: Tool = {
  name: "write",
  description: "",
  parameters: {},
  permission: "ask",
  category: "edit",
  execute: async () => ({ output: "" }),
};

/** A scriptable stand-in for Agent that emits tool_call events per step. */
class FakeAgent {
  tools: Tool[] = [writeTool];
  steps: string[][] = [];
  prompts: string[] = [];
  assessVerdict = { done: false, note: "CONTINUE" };
  onRun?: (n: number) => void;
  private n = 0;
  constructor(private bus: EventBus) {}
  setTools(t: Tool[]): void {
    this.tools = t;
  }
  async run(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    const names = this.steps[this.n] ?? [];
    this.n += 1;
    for (const name of names) {
      this.bus.emit({
        type: "tool_call",
        call: { id: "x", name, arguments: name === "task_done" ? { summary: "all done" } : {} },
      });
    }
    this.onRun?.(this.n);
  }
  async assess(): Promise<{ done: boolean; note: string }> {
    return this.assessVerdict;
  }
}

function makeEngine(
  agent: FakeAgent,
  bus: EventBus,
  opts?: { mode?: "once" | "eternal"; maxSteps?: number },
) {
  return new AutonomyEngine(agent as unknown as Agent, bus, taskDone, opts);
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

describe("AutonomyEngine", () => {
  it("completes in once mode when task_done is called", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });

    await engine.start("do the thing");

    expect(engine.state).toBe("done");
    expect(agent.prompts).toHaveLength(2);
    expect(events.some((e) => e.type === "autonomy_done")).toBe(true);
  });

  it("stops at the step cap in once mode", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"], ["write"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 3 });

    await engine.start("g");

    expect(agent.prompts).toHaveLength(3);
    expect(engine.state).toBe("stopped");
  });

  it("stops after two idle steps when assess says continue", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [[], []];
    agent.assessVerdict = { done: false, note: "CONTINUE" };
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });

    await engine.start("g");

    expect(agent.prompts).toHaveLength(2);
    expect(engine.state).toBe("stopped");
  });

  it("finishes when assess reports the goal done", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [[]];
    agent.assessVerdict = { done: true, note: "DONE" };
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });

    await engine.start("g");

    expect(agent.prompts).toHaveLength(1);
    expect(engine.state).toBe("done");
  });

  it("applies a steer note to the next step prompt", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });
    agent.onRun = (n) => {
      if (n === 1) engine.steer("focus on tests");
    };

    await engine.start("g");

    expect(agent.prompts[1]).toContain("focus on tests");
  });

  it("eternal mode ignores task_done and runs until stopped", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"], ["task_done"], ["task_done"]];
    const engine = makeEngine(agent, bus, { mode: "eternal" });
    agent.onRun = (n) => {
      if (n >= 3) engine.stop();
    };

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    expect(agent.prompts.length).toBeGreaterThanOrEqual(3);
  });

  it("pause then resume does not deadlock", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });
    const events = collect(bus);
    agent.onRun = (n) => {
      if (n === 1) {
        engine.pause();
        engine.resume();
      }
    };

    await engine.start("g");

    expect(events.some((e) => e.type === "autonomy_paused")).toBe(true);
    expect(events.some((e) => e.type === "autonomy_resumed")).toBe(true);
    expect(engine.state).toBe("done");
  });
});

describe("Agent.assess", () => {
  it("checks completion without mutating history", async () => {
    const bus = new EventBus();
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => false,
      listModels: async () => [],
      async *chat() {
        yield { type: "text", delta: "DONE" };
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager(),
      ask: async () => "deny",
      bus,
      cwd: process.cwd(),
    });

    await agent.run("hi");
    const before = agent.history.length;
    const verdict = await agent.assess("the goal");

    expect(verdict.done).toBe(true);
    expect(agent.history.length).toBe(before);
  });
});
