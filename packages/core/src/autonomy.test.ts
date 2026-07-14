import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { registerAgentDefinitions } from "./agentRegistry.js";
import { AutonomyEngine, type AutonomyFleetRunner, type AutonomyTask } from "./autonomy.js";
import { Blackboard } from "./blackboard.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { MemberMemory } from "./memberMemory.js";
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
  // Optional per-call verdicts (consumed in order); falls back to assessVerdict.
  assessVerdicts?: { done: boolean; note: string }[];
  private assessN = 0;
  async assess(): Promise<{ done: boolean; note: string }> {
    if (this.assessVerdicts) return this.assessVerdicts[this.assessN++] ?? this.assessVerdict;
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
    blackboard?: Blackboard;
    memberMemory?: MemberMemory;
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

describe("team mode", () => {
  it("assembles a roster, dispatches assignments with member identity, and finishes", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"name": "coder", "description": "writes code", "instruction": "Write the code."}]',
      '[{"member": "coder", "task": "implement it"}]',
    ];
    agent.assessVerdict = { done: true, note: "finished" };
    const fleetCalls: AutonomyTask[][] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      fleetCalls.push(tasks);
      return tasks.map((t) => ({ ...t, output: "ok" }));
    };
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "team", runFleet });

    await engine.start("build the feature");

    expect(engine.state).toBe("done");
    expect(fleetCalls).toHaveLength(1);
    const task = fleetCalls[0]?.[0];
    expect(task?.id).toBe("m1-coder");
    expect(task?.role).toBe("coder");
    // Ad-hoc member → brief travels as a task-instruction prefix, not a system prompt.
    expect(task?.instruction).toBe("Write the code.");
    expect(task?.systemPrompt).toBeUndefined();

    const types = events.map((e) => e.type);
    expect(types.indexOf("team_plan")).toBeGreaterThan(-1);
    expect(types.indexOf("team_plan")).toBeLessThan(types.indexOf("team_round"));
    expect(types.indexOf("team_round")).toBeLessThan(types.indexOf("team_done"));
    expect(types).toContain("autonomy_done");
    const done = events.find((e) => e.type === "team_done");
    expect(done?.type === "team_done" && done.done).toBe(1);
    expect(engine.snapshot().team.map((m) => m.name)).toEqual(["coder"]);
  });

  it("posts round results to the blackboard and prefixes next-round tasks with the brief", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      // roster
      '[{"name": "coder", "description": "writes", "instruction": "Write."},' +
        '{"name": "reviewer", "description": "reviews", "instruction": "Review."}]',
      // round 1 assignments
      '[{"member": "coder", "task": "implement"},{"member": "reviewer", "task": "review"}]',
      // round 2 assignments
      '[{"member": "coder", "task": "fix the review notes"}]',
    ];
    // Not done after round 1, done after round 2.
    agent.assessVerdicts = [
      { done: false, note: "keep going" },
      { done: true, note: "finished" },
    ];
    const fleetCalls: AutonomyTask[][] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      fleetCalls.push(tasks);
      return tasks.map((t) => ({ ...t, output: `${t.role} output` }));
    };
    const board = new Blackboard();
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "team", runFleet, blackboard: board });

    await engine.start("build it");

    expect(engine.state).toBe("done");
    expect(fleetCalls).toHaveLength(2);

    // Round 1 results landed on the board (round 2 also posts coder's result).
    const round1 = board.entries().filter((e) => e.kind === "result" && e.round === 1);
    expect(round1.map((e) => e.from).sort()).toEqual(["m1-coder", "m2-reviewer"]);

    // Round 2's coder task is prefixed with the board brief carrying the reviewer's
    // round-1 result (teammate work), while the raw assignment is preserved.
    const coderRound2 = fleetCalls[1]?.[0];
    expect(coderRound2?.id).toBe("m1-coder");
    expect(coderRound2?.task).toContain("Team board");
    expect(coderRound2?.task).toContain("reviewer output");
    expect(coderRound2?.task).toContain("fix the review notes");
    // A member never sees its own posting echoed back.
    expect(coderRound2?.task).not.toContain("coder output");

    // Each posted result also surfaces as a team_message event (topology graph):
    // 2 from round 1 + 1 from round 2, all of kind "result".
    const msgs = events.filter((e) => e.type === "team_message");
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.type === "team_message" && m.kind === "result")).toBe(true);
  });

  it("recaps a member's own result into its private memory and hands it back next round", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      // roster
      '[{"name": "coder", "description": "writes", "instruction": "Write."},' +
        '{"name": "reviewer", "description": "reviews", "instruction": "Review."}]',
      // round 1 assignments
      '[{"member": "coder", "task": "implement"},{"member": "reviewer", "task": "review"}]',
      // round 2 assignments
      '[{"member": "coder", "task": "keep going"}]',
    ];
    agent.assessVerdicts = [
      { done: false, note: "keep going" },
      { done: true, note: "finished" },
    ];
    const fleetCalls: AutonomyTask[][] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      fleetCalls.push(tasks);
      return tasks.map((t) => ({ ...t, output: `${t.role} output` }));
    };
    const memory = new MemberMemory();
    // No blackboard: memory is independently switchable, so the recall must reach the
    // member on its own.
    const engine = makeEngine(agent, bus, { mode: "team", runFleet, memberMemory: memory });

    await engine.start("build it");

    expect(engine.state).toBe("done");
    expect(memory.entries("m1-coder").map((e) => e.kind)).toEqual(["recap", "recap"]);

    // Unlike the board — which never echoes a member's own posting back — the member's
    // private memory carries its own round-1 output into round 2.
    const coderRound2 = fleetCalls[1]?.[0];
    expect(coderRound2?.task).toContain("private memory");
    expect(coderRound2?.task).toContain("coder output");
    expect(coderRound2?.task).toContain("keep going");
    // And strictly its own: the reviewer's output is the board's job, not memory's.
    expect(coderRound2?.task).not.toContain("reviewer output");
  });

  it("does not recap failed member slots", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"name": "coder", "description": "writes", "instruction": "Write."}]',
      '[{"member": "coder", "task": "implement"}]',
    ];
    agent.assessVerdict = { done: true, note: "finished" };
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t) => ({ ...t, output: "member crashed", error: true }));
    const memory = new MemberMemory();
    const engine = makeEngine(agent, bus, { mode: "team", runFleet, memberMemory: memory });

    await engine.start("build it");

    expect(memory.entries("m1-coder")).toHaveLength(0);
  });

  it("a definition-backed member carries its body as a system prompt and its allowlist", async () => {
    registerAgentDefinitions([
      {
        name: "auditor",
        description: "security audits",
        instruction: "SYSTEM BRIEF",
        tools: ["read"],
        source: "project",
      },
    ]);
    try {
      const bus = new EventBus();
      const agent = new FakeAgent(bus);
      agent.plans = ['[{"name": "auditor"}]', '[{"member": "auditor", "task": "scan"}]'];
      agent.assessVerdict = { done: true, note: "clean" };
      const fleetCalls: AutonomyTask[][] = [];
      const runFleet: AutonomyFleetRunner = async (tasks) => {
        fleetCalls.push(tasks);
        return tasks.map((t) => ({ ...t, output: "ok" }));
      };
      const engine = makeEngine(agent, bus, { mode: "team", runFleet });

      await engine.start("audit the repo");

      const task = fleetCalls[0]?.[0];
      expect(task?.systemPrompt).toBe("SYSTEM BRIEF");
      expect(task?.instruction).toBeUndefined();
      expect(task?.toolNames).toEqual(["read"]);
    } finally {
      registerAgentDefinitions([]);
    }
  });

  it("stops after two idle rounds, still emitting a team summary", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"name": "coder", "instruction": "x"}]', "[]", "[]"];
    agent.assessVerdict = { done: false, note: "CONTINUE" };
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t) => ({ ...t, output: "ok" }));
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "team", runFleet });

    await engine.start("vague goal");

    expect(engine.state).toBe("stopped");
    const types = events.map((e) => e.type);
    expect(types).toContain("team_done");
    const stop = events.find((e) => e.type === "autonomy_stopped");
    expect(stop?.type === "autonomy_stopped" && stop.reason).toContain("no further team work");
  });

  it("counts failed members in the team summary", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"name": "a", "instruction": "x"}, {"name": "b", "instruction": "y"}]',
      '[{"member": "a", "task": "t1"}, {"member": "b", "task": "t2"}]',
    ];
    agent.assessVerdict = { done: true, note: "over" };
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t, i) => ({ ...t, output: i === 0 ? "ok" : "boom", error: i === 1 }));
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "team", runFleet });

    await engine.start("mixed result");

    const done = events.find((e) => e.type === "team_done");
    expect(done?.type === "team_done" && done.done).toBe(1);
    expect(done?.type === "team_done" && done.failed).toBe(1);
  });
});
