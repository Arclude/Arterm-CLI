import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { AutonomyEngine, type AutonomyFleetRunner, type AutonomyTask } from "./autonomy.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { PermissionManager } from "./permissions.js";
import type { AutonomyMode, ChatProvider, Tool } from "./types.js";

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
  history: { role: string; content: string }[] = [];
  assessVerdict = { done: false, note: "CONTINUE" };
  onRun?: (n: number) => void;
  private n = 0;
  constructor(private bus: EventBus) {}
  setTools(t: Tool[]): void {
    this.tools = t;
  }
  async run(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    // Mirror the real Agent: a run appends an assistant message (echoed here so the
    // phased handoff — read from history.at(-1) — carries the aggregated content).
    this.history.push({ role: "assistant", content: prompt });
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
  // Scripted decomposition output, one entry per round (defaults to "[]").
  plans: string[] = [];
  private planN = 0;
  async plan(): Promise<string> {
    const out = this.plans[this.planN] ?? "[]";
    this.planN += 1;
    return out;
  }
}

function makeEngine(
  agent: FakeAgent,
  bus: EventBus,
  opts?: {
    mode?: AutonomyMode;
    maxSteps?: number;
    fanout?: number;
    runFleet?: AutonomyFleetRunner;
  },
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

describe("AutonomyEngine (parallel mode)", () => {
  it("decomposes a round, dispatches the fleet, and finishes on assess-done", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"task":"a"},{"task":"b","role":"tester"}]'];
    agent.assessVerdict = { done: true, note: "DONE" };
    let dispatched: AutonomyTask[] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      dispatched = tasks;
      return tasks.map((t) => ({ ...t, output: `did ${t.task}` }));
    };
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("ship it");

    expect(dispatched).toEqual([
      { task: "a", role: undefined },
      { task: "b", role: "tester" },
    ]);
    expect(engine.state).toBe("done");
    expect(events.some((e) => e.type === "autonomy_fleet_round")).toBe(true);
    expect(events.some((e) => e.type === "autonomy_aggregate")).toBe(true);
  });

  it("caps the fan-out at 16 subtasks per round", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    const twenty = Array.from({ length: 20 }, (_, i) => ({ task: `t${i}` }));
    agent.plans = [JSON.stringify(twenty)];
    agent.assessVerdict = { done: true, note: "DONE" };
    let count = -1;
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      count = tasks.length;
      return tasks.map((t) => ({ ...t, output: "" }));
    };
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("g");

    expect(count).toBe(16);
  });

  it("feeds the fleet results back into the leader's history", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"task":"alpha"}]'];
    agent.assessVerdict = { done: true, note: "DONE" };
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t) => ({ ...t, output: "RESULT-XYZ" }));
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("g");

    // aggregate() calls agent.run with the subtask outputs embedded.
    expect(agent.prompts.some((p) => p.includes("RESULT-XYZ"))).toBe(true);
  });

  it("stop aborts the in-flight fleet and exits stopped", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"task":"a"}]'];
    // biome-ignore lint/style/useConst: assigned after the runFleet closure that references it
    let engine!: AutonomyEngine;
    let abortedSignal = false;
    const runFleet: AutonomyFleetRunner = async (_tasks, signal) => {
      engine.stop();
      abortedSignal = signal.aborted;
      throw new Error("aborted");
    };
    engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("g");

    expect(abortedSignal).toBe(true);
    expect(engine.state).toBe("stopped");
  });

  it("treats malformed decomposition as no work and falls back to assess", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ["this is not json"];
    agent.assessVerdict = { done: true, note: "DONE" };
    let called = false;
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      called = true;
      return tasks.map((t) => ({ ...t, output: "" }));
    };
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("g");

    expect(called).toBe(false);
    expect(engine.state).toBe("done");
  });

  it("requires a fleet runner", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5 });

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    expect(events.some((e) => e.type === "autonomy_stopped" && /fleet runner/.test(e.reason))).toBe(
      true,
    );
  });
});

describe("AutonomyEngine (phased mode)", () => {
  it("plans phases and runs them sequentially, threading the handoff forward", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"title":"plan","description":"design it","done":"designed"},{"title":"build","description":"build it","done":"built"}]',
    ];
    agent.assessVerdict = { done: true, note: "DONE" };
    const dispatched: AutonomyTask[][] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      dispatched.push(tasks);
      return tasks.map((t) => ({ ...t, output: `OUT-${dispatched.length}` }));
    };
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "phased", maxSteps: 5, runFleet });

    await engine.start("ship the feature");

    expect(engine.state).toBe("done");
    // One fleet dispatch per phase, in order.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.[0]?.task).toContain("design it");
    // Phase 2's task carries the handoff from phase 1 (which embedded OUT-1).
    expect(dispatched[1]?.[0]?.task).toContain("OUT-1");
    expect(events.some((e) => e.type === "phase_plan")).toBe(true);
    expect(events.filter((e) => e.type === "phase_start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "phase_done")).toHaveLength(2);
  });

  it("falls back to a single phase when the plan is malformed", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ["not json at all"];
    agent.assessVerdict = { done: true, note: "DONE" };
    let phases = 0;
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      phases += 1;
      return tasks.map((t) => ({ ...t, output: "" }));
    };
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "phased", maxSteps: 5, runFleet });

    await engine.start("just do it");

    expect(phases).toBe(1);
    const plan = events.find((e) => e.type === "phase_plan");
    expect(plan && plan.type === "phase_plan" && plan.phases).toHaveLength(1);
    expect(engine.state).toBe("done");
  });

  it("requires a fleet runner", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "phased", maxSteps: 5 });

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    expect(events.some((e) => e.type === "autonomy_stopped" && /fleet runner/.test(e.reason))).toBe(
      true,
    );
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
