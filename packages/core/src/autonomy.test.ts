import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { registerAgentDefinitions } from "./agentRegistry.js";
import { AutonomyEngine, type AutonomyFleetRunner, type AutonomyTask } from "./autonomy.js";
import { Blackboard } from "./blackboard.js";
import { RunBudget } from "./budget.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { MemberMemory } from "./memberMemory.js";
import { PermissionManager } from "./permissions.js";
import type { AutonomyMode, ChatProvider, Tool } from "./types.js";
import { type Verifier, makeCommandVerifier, makeCompositeVerifier } from "./verify.js";

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
  /** Prompts passed to plan() — decompose/roster/assign/phase-plan all go through it. */
  planPrompts: string[] = [];
  private planN = 0;
  async plan(prompt?: string): Promise<string> {
    if (prompt !== undefined) this.planPrompts.push(prompt);
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
    teamRounds?: number;
    runFleet?: AutonomyFleetRunner;
    blackboard?: Blackboard;
    memberMemory?: MemberMemory;
    verify?: Verifier;
    verifyAttempts?: number;
    verifyPersist?: boolean;
    cycleGapMs?: number;
  },
) {
  // Tests drive steps synchronously — the eternal breathing gap would only
  // slow them down (or hang fake-timer tests), so it is off by default here.
  return new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
    cycleGapMs: 0,
    ...opts,
  });
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

describe("AutonomyEngine completion verifier (verify hook)", () => {
  function makeVerifyEngine(agent: FakeAgent, bus: EventBus, verify: Verifier, maxSteps = 10) {
    return new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps,
      verify,
    });
  }

  it("accepts task_done when the verifier passes", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"]];
    const events = collect(bus);
    let calls = 0;
    const engine = makeVerifyEngine(agent, bus, async () => {
      calls++;
      return { pass: true, reason: "looks complete", by: "judge" as const };
    });

    await engine.start("g");

    expect(calls).toBe(1);
    expect(engine.state).toBe("done");
    expect(events.some((e) => e.type === "autonomy_verify" && e.pass)).toBe(true);
  });

  it("rejects once, feeds back a steer note, then completes on the retry", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"]];
    let n = 0;
    const engine = makeVerifyEngine(agent, bus, async () => {
      n++;
      return n === 1
        ? { pass: false, reason: "tests still failing", mustFix: ["make the suite green"] }
        : { pass: true, reason: "now green" };
    });

    await engine.start("g");

    expect(engine.state).toBe("done");
    // The rejection was injected as a steer note into the retry's prompt.
    expect(agent.prompts[1]).toContain("tests still failing");
  });

  it("stops after two verifier rejections and keeps a resumable checkpoint", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"], ["task_done"]];
    const events = collect(bus);
    const cleared: boolean[] = [];
    const engine = makeVerifyEngine(agent, bus, async () => ({
      pass: false,
      reason: "still not done",
    }));
    engine.setCheckpointSink((snap) => {
      cleared.push(snap === null);
    });

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    expect(events.some((e) => e.type === "autonomy_stopped")).toBe(true);
    // A rejected-but-claimed goal stays resumable — the checkpoint was never cleared.
    expect(cleared).not.toContain(true);
  });

  it("keeps working past the rejection cap under verifyPersist, bounded by maxSteps", async () => {
    // Without this the run gives up on the second rejection, which is the wrong
    // answer for "keep going until the suite is green": the repair note is already
    // queued, so there is work to do. The step cap — not the verifier — ends it.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = Array.from({ length: 6 }, () => ["task_done"]);
    const events = collect(bus);
    let n = 0;
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 4,
      verifyAttempts: 2,
      verifyPersist: true,
      verify: async () => {
        n += 1;
        return { pass: false, reason: `still red (${n})` };
      },
    });

    await engine.start("g");

    // Four rejections, not two: it kept going and only the step cap stopped it.
    expect(n).toBe(4);
    expect(engine.state).toBe("stopped");
    const stop = events.find((e) => e.type === "autonomy_stopped");
    expect(stop && "reason" in stop && stop.reason).toContain("step limit");
    // Every lap still carried the reviewer's complaint into the next prompt.
    expect(agent.prompts[3]).toContain("still red");
  });

  it("still stops at the cap when verifyPersist is off", async () => {
    // The default has to stay a give-up — persisting is opt-in, and a run that
    // cannot satisfy the reviewer twice usually needs a human, not another lap.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = Array.from({ length: 6 }, () => ["task_done"]);
    const events = collect(bus);
    let n = 0;
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 6,
      verifyAttempts: 2,
      verify: async () => {
        n += 1;
        return { pass: false, reason: "still red" };
      },
    });

    await engine.start("g");

    expect(n).toBe(2);
    const stop = events.find((e) => e.type === "autonomy_stopped");
    expect(stop && "reason" in stop && stop.reason).toContain("rejected the result");
  });

  it("setUnattended flips persist on a LIVE engine (the Shift+Tab arm path)", async () => {
    // Constructed supervised, armed at runtime: the run must behave exactly as
    // if verifyPersist had been set at build time — the arm path is not a
    // second implementation, it is the same switch flipped later.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = Array.from({ length: 6 }, () => ["task_done"]);
    let n = 0;
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 4,
      verifyAttempts: 2,
      verify: async () => {
        n += 1;
        return { pass: false, reason: "still red" };
      },
    });

    engine.setUnattended({ verifyPersist: true });
    await engine.start("g");
    // Persisted to the step cap (4 rejections), not the attempt cap (2).
    expect(n).toBe(4);

    // And disarming restores the give-up: a fresh run stops at the attempt cap.
    agent.steps = Array.from({ length: 6 }, () => ["task_done"]);
    n = 0;
    engine.setUnattended({ verifyPersist: false });
    await engine.start("g");
    expect(n).toBe(2);
  });

  it("blocks a claim with the REAL deterministic gate, then accepts when it passes", async () => {
    // End-to-end through the composite: no stub verdict, an actual exit code.
    // The goal declares the command, which is the only way one is ever obtained.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"]];
    const events = collect(bus);
    const attempt = 0;
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 4,
      verify: makeCompositeVerifier([
        makeCommandVerifier({ cwd: process.cwd(), timeoutMs: 20_000 }),
        async () => ({ pass: true, by: "judge" as const }),
      ]),
    });

    await engine.start('do the work\nverify: node -e "process.exit(5)"');

    expect(engine.state).toBe("stopped");
    const rejected = events.filter((e) => e.type === "autonomy_verify" && !e.pass);
    expect(rejected.length).toBe(2);
    expect(rejected[0]).toMatchObject({ by: "command" });
    // The worker was told what to fix, in the prompt of the following attempt.
    expect(agent.prompts[1]).toContain("must exit 0");
  });

  it("emits a visible skipped verdict when the verifier itself crashes", async () => {
    // The old silent catch made a crashed verifier look identical to a verified
    // pass. Accepting the claim is right; hiding it is not.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"]];
    const events = collect(bus);
    const engine = makeVerifyEngine(agent, bus, async () => {
      throw new Error("verifier crashed");
    });

    await engine.start("g");

    expect(engine.state).toBe("done");
    expect(events.some((e) => e.type === "autonomy_verify" && e.pass && e.skipped)).toBe(true);
  });

  it("resets the rejection count after a pass", async () => {
    // Without the reset, two unrelated rejections rounds apart kill a long run.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"], ["task_done"]];
    let n = 0;
    const engine = makeVerifyEngine(agent, bus, async () => {
      n++;
      // reject, pass, reject — the third must not be treated as "twice rejected".
      if (n === 2) return { pass: true, reason: "fine" };
      return { pass: false, reason: `no #${n}` };
    });

    await engine.start("g");

    // The run ended on the pass, not on a two-strikes stop.
    expect(engine.state).toBe("done");
    expect(n).toBe(2);
  });

  it("fails open: a throwing verifier accepts the completion claim", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"]];
    const engine = makeVerifyEngine(agent, bus, async () => {
      throw new Error("verifier crashed");
    });

    await engine.start("g");

    expect(engine.state).toBe("done");
  });
});

describe("AutonomyEngine checkpoints (setCheckpointSink)", () => {
  it("checkpoints every step and clears on task_done", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });
    const seen: (string | null)[] = [];
    engine.setCheckpointSink((snap) => {
      seen.push(snap === null ? null : `${snap.goal}@${snap.step}`);
    });

    await engine.start("hedef");

    // One snapshot per step, then the explicit clear when the goal completes.
    expect(seen).toEqual(["hedef@1", "hedef@2", null]);
  });

  it("keeps the checkpoint when the run dies at the step cap (crash-resume case)", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 2 });
    const seen: (string | null)[] = [];
    engine.setCheckpointSink((snap) => {
      seen.push(snap === null ? null : `step${snap.step}`);
    });

    await engine.start("g");

    // Step-cap stop is resumable — no null must have been written.
    expect(seen).toEqual(["step1", "step2"]);
  });

  it("clears the checkpoint on a deliberate user stop", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });
    const seen: (string | null)[] = [];
    engine.setCheckpointSink((snap) => {
      seen.push(snap === null ? null : `step${snap.step}`);
    });
    agent.onRun = (n) => {
      if (n === 2) engine.stop();
    };

    await engine.start("g");

    expect(seen.at(-1)).toBeNull();
  });

  it("a throwing sink never disturbs the run", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const engine = makeEngine(agent, bus, { mode: "once", maxSteps: 10 });
    engine.setCheckpointSink(() => {
      throw new Error("disk full");
    });

    await engine.start("g");

    expect(engine.state).toBe("done");
  });
});

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

    // Every dispatched subtask carries a round-scoped id — that is what the
    // live board keys its rows on, and what the per-task telemetry quotes.
    expect(dispatched).toEqual([
      { task: "a", role: undefined, id: "r1-1" },
      { task: "b", role: "tester", id: "r1-2" },
    ]);
    expect(engine.state).toBe("done");
    expect(events.some((e) => e.type === "autonomy_fleet_round")).toBe(true);
    expect(events.some((e) => e.type === "autonomy_aggregate")).toBe(true);
  });

  it("scopes subtask ids to their round and publishes them on the round event", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    // Two rounds: the second must not reuse the first round's ids, or a board
    // keyed on them would merge both rounds' subtasks into one set of rows.
    agent.plans = ['[{"task":"a"},{"task":"b"}]', '[{"task":"c"}]'];
    agent.assessVerdicts = [
      { done: false, note: "keep going" },
      { done: true, note: "DONE" },
    ];
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t) => ({ ...t, output: "ok" }));
    const events = collect(bus);
    const engine = makeEngine(agent, bus, { mode: "parallel", maxSteps: 5, runFleet });

    await engine.start("g");

    const rounds = events.filter((e) => e.type === "autonomy_fleet_round");
    expect(rounds.map((r) => r.tasks.map((t) => t.id))).toEqual([["r1-1", "r1-2"], ["r2-1"]]);
    // Plain parallel subtasks are NOT team members — the composition root keys
    // the member-only extras (per-member tools, isolation, patch apply) on that.
    expect(rounds.flatMap((r) => r.tasks).every((t) => !("member" in t))).toBe(true);
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

  it("stops instead of claiming success when its own assessment says CONTINUE", async () => {
    // Phased used to discard `verdict.done` entirely, so every run that reached
    // the last phase reported success — even one that had just been told it was
    // not finished.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"title":"build","description":"build it","done":"built"}]'];
    agent.assessVerdict = { done: false, note: "the parser is still missing" };
    const events = collect(bus);
    const runFleet: AutonomyFleetRunner = async (tasks) =>
      tasks.map((t) => ({ ...t, output: "did some of it" }));
    const engine = makeEngine(agent, bus, { mode: "phased", maxSteps: 5, runFleet });

    await engine.start("ship the parser");

    expect(engine.state).toBe("stopped");
    expect(events.some((e) => e.type === "autonomy_done")).toBe(false);
    const stopped = events.find((e) => e.type === "autonomy_stopped");
    expect(stopped && stopped.type === "autonomy_stopped" && stopped.reason).toContain(
      "the parser is still missing",
    );
    // The reflection itself was never emitted either.
    expect(events.some((e) => e.type === "autonomy_reflect")).toBe(true);
  });

  it("re-runs a phase the verifier rejected, handing it the mustFix items", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"title":"build","description":"build it","done":"built"}]'];
    agent.assessVerdict = { done: true, note: "DONE" };
    let runs = 0;
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      runs += 1;
      return tasks.map((t) => ({ ...t, output: `attempt ${runs}` }));
    };
    let judged = 0;
    const engine = makeEngine(agent, bus, {
      mode: "phased",
      maxSteps: 5,
      runFleet,
      verify: async () => {
        judged += 1;
        return judged === 1
          ? { pass: false, reason: "no tests", mustFix: ["cover the parser"] }
          : { pass: true, reason: "ok" };
      },
    });

    await engine.start("ship the parser");

    expect(engine.state).toBe("done");
    // The phase ran twice, and the retry's task carries the reviewer's item.
    expect(runs).toBe(2);
    const retry = agent.prompts.find((t) => t.includes("cover the parser"));
    expect(retry).toBeDefined();
  });

  it("carries a phase forward when its repair attempts run out", async () => {
    // One bad phase must not kill a whole plan — the failure rides the handoff and
    // the final goal gate decides.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"title":"a","description":"first","done":"x"},{"title":"b","description":"second","done":"y"}]',
    ];
    agent.assessVerdict = { done: true, note: "DONE" };
    const dispatched: AutonomyTask[][] = [];
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      dispatched.push(tasks);
      return tasks.map((t) => ({ ...t, output: "partial" }));
    };
    let n = 0;
    const engine = makeEngine(agent, bus, {
      mode: "phased",
      maxSteps: 5,
      runFleet,
      verifyAttempts: 1,
      verify: async () => {
        n += 1;
        // Reject phase 1 only; phase 2 and the goal gate pass.
        return n === 1 ? { pass: false, reason: "incomplete" } : { pass: true };
      },
    });

    await engine.start("ship it");

    expect(engine.state).toBe("done");
    // Phase 2 ran, and its task carries phase 1's rejection in the handoff.
    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    expect(dispatched.at(-1)?.[0]?.task).toContain("verification rejected this phase");
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

/**
 * Verification in the fan-out modes. Neither needs a bespoke repair loop: their
 * "continue" already means another round of work, and the repair note is queued
 * where the next decompose/assign prompt reads it.
 */
describe("AutonomyEngine verification in fan-out modes", () => {
  const runFleet: AutonomyFleetRunner = async (tasks) =>
    tasks.map((t) => ({ ...t, output: `did ${t.task}` }));

  it("parallel: a rejected round runs another one, carrying the mustFix items", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"task":"port the parser"}]', '[{"task":"add the tests"}]'];
    agent.assessVerdicts = [
      { done: true, note: "looks done" },
      { done: true, note: "really done" },
    ];
    let n = 0;
    const engine = makeEngine(agent, bus, {
      mode: "parallel",
      maxSteps: 4,
      runFleet,
      verify: async () => {
        n += 1;
        return n === 1
          ? { pass: false, reason: "no tests", mustFix: ["cover the parser"] }
          : { pass: true };
      },
    });

    await engine.start("ship the parser");

    expect(engine.state).toBe("done");
    expect(n).toBe(2);
    // The second decompose prompt carries the reviewer's item.
    expect(agent.planPrompts.some((t) => t.includes("cover the parser"))).toBe(true);
  });

  it("parallel: shows the reviewer which slots failed, not just the leader's prose", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = ['[{"task":"a"},{"task":"b"}]'];
    agent.assessVerdict = { done: true, note: "all good" };
    let claim = "";
    const engine = makeEngine(agent, bus, {
      mode: "parallel",
      maxSteps: 2,
      runFleet: async (tasks) =>
        tasks.map((t, i) => ({ ...t, output: "x", ...(i === 1 ? { error: true } : {}) })),
      verify: async (req) => {
        claim = req.claim;
        return { pass: true };
      },
    });

    await engine.start("do a and b");

    expect(claim).toContain("all good");
    expect(claim).toContain("✓");
    expect(claim).toContain("✗");
  });

  it("team: a rejected round does not report the team run as finished", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.plans = [
      '[{"name":"builder","instruction":"build"}]',
      '[{"member":"builder","task":"port it"}]',
      '[{"member":"builder","task":"test it"}]',
    ];
    agent.assessVerdicts = [
      { done: true, note: "done" },
      { done: true, note: "really done" },
    ];
    const events = collect(bus);
    let n = 0;
    const engine = makeEngine(agent, bus, {
      mode: "team",
      teamRounds: 3,
      runFleet,
      verify: async () => {
        n += 1;
        return n === 1 ? { pass: false, reason: "not yet" } : { pass: true };
      },
    });

    await engine.start("ship it");

    // team_done marks a finished run; the rejected round must not emit one.
    expect(events.filter((e) => e.type === "team_done")).toHaveLength(1);
    expect(engine.state).toBe("done");
  });
});

describe("AutonomyEngine progress-gated step extension (autoExtend)", () => {
  it("extends past the cap when progress happened, then finishes normally", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"], ["task_done"]];
    const events = collect(bus);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 2,
      autoExtend: true,
      extendBy: 5,
    });
    await engine.start("g");
    const extended = events.filter((e) => e.type === "autonomy_extended");
    expect(extended.length).toBeGreaterThanOrEqual(1);
    expect(extended[0]).toMatchObject({ newLimit: 7 });
    expect(events.some((e) => e.type === "autonomy_done")).toBe(true);
  });

  it("denies the extension when nothing happened since the last one", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [[]]; // one idle step, then the cap
    const events = collect(bus);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 1,
      autoExtend: true,
    });
    await engine.start("g");
    expect(events.some((e) => e.type === "autonomy_extended")).toBe(false);
    const stopped = events.find((e) => e.type === "autonomy_stopped") as { reason: string };
    expect(stopped.reason).toContain("no progress since the last extension");
  });

  it("keeps today's hard cap when autoExtend is off", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"]];
    const events = collect(bus);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 2,
    });
    await engine.start("g");
    expect(events.some((e) => e.type === "autonomy_extended")).toBe(false);
    const stopped = events.find((e) => e.type === "autonomy_stopped") as { reason: string };
    expect(stopped.reason).toBe("reached step limit (2)");
  });
});

describe("AutonomyEngine eternal hardening", () => {
  function eternalEngine(
    agent: FakeAgent,
    bus: EventBus,
    opts: Record<string, unknown> = {},
  ): AutonomyEngine {
    return new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "eternal",
      hardCap: true,
      maxSteps: 2,
      cycleGapMs: 0,
      ...opts,
    });
  }

  it("feeds the journal of prior steps into the next directive", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], []];
    const events = collect(bus);
    await eternalEngine(agent, bus).start("g");
    expect(agent.prompts[1]).toContain("Recent iterations (newest last):");
    expect(agent.prompts[1]).toContain("[ok] used write");
    const journal = events.filter((e) => e.type === "autonomy_journal");
    expect(journal[0]).toMatchObject({ status: "ok" });
    expect(journal[1]).toMatchObject({ status: "idle" });
  });

  it("default eternalCompletion 'never' ignores task_done claims entirely", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["task_done"]];
    const events = collect(bus);
    let verifierCalls = 0;
    await eternalEngine(agent, bus, {
      verify: async () => {
        verifierCalls++;
        return { pass: true };
      },
    }).start("g");
    expect(verifierCalls).toBe(0);
    expect(events.some((e) => e.type === "autonomy_done")).toBe(false);
    expect(events.some((e) => e.type === "autonomy_stopped")).toBe(true);
  });

  it("eternalCompletion 'claim': an accepted claim ends the run through the gate", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"]];
    const events = collect(bus);
    const engine = eternalEngine(agent, bus, {
      eternalCompletion: "claim",
      verify: async () => ({ pass: true, reason: "verified", by: "judge" as const }),
    });
    await engine.start("g");
    expect(events.some((e) => e.type === "autonomy_done")).toBe(true);
    expect(engine.state).toBe("done");
  });

  it("eternalCompletion 'claim': a rejection queues the repair note and keeps looping", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["task_done"], ["write"]];
    const events = collect(bus);
    await eternalEngine(agent, bus, {
      eternalCompletion: "claim",
      verify: async () => ({ pass: false, reason: "tests fail", mustFix: ["fix the tests"] }),
    }).start("g");
    expect(events.some((e) => e.type === "autonomy_done")).toBe(false);
    const journal = events.filter((e) => e.type === "autonomy_journal");
    expect(journal[0]).toMatchObject({ status: "verify-fail" });
    // The mustFix repair note reaches the next step's prompt.
    expect(agent.prompts[1]).toContain("fix the tests");
  });

  it("pivots via plan() after the failure budget is spent", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [[], []];
    agent.plans = ["Read the failing test file and fix the assertion"];
    const events = collect(bus);
    await eternalEngine(agent, bus, { failureBudget: 2 }).start("g");
    expect(agent.planPrompts.some((p) => p.includes("stalled"))).toBe(true);
    const steers = events.filter((e) => e.type === "autonomy_steer") as { note: string }[];
    expect(steers.some((s) => s.note.startsWith("pivot:"))).toBe(true);
  });

  it("a provider that never succeeds stops after two exhausted budgets", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [[], [], []];
    agent.onRun = () => bus.emit({ type: "error", error: "invalid api key", retryable: false });
    const events = collect(bus);
    // Deliberately UNBOUNDED eternal: the stop must come from the dead-provider
    // guard, not the step cap.
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "eternal",
      failureBudget: 1,
      cycleGapMs: 0,
    });
    await engine.start("g");
    const stopped = events.find((e) => e.type === "autonomy_stopped") as { reason: string };
    expect(stopped.reason).toContain("no step has ever succeeded");
  });

  it("pauses cycleGapMs between eternal steps, so a fast provider cannot hot-loop", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const agent = new FakeAgent(bus);
      agent.steps = [["write"], ["write"]];
      const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
        mode: "eternal",
        hardCap: true,
        maxSteps: 2,
        failureBudget: 99,
        cycleGapMs: 1_000,
      });
      const run = engine.start("g");
      await vi.advanceTimersByTimeAsync(10); // step 1 runs, then the gap starts
      expect(agent.prompts.length).toBe(1); // step 2 is waiting out the gap
      await vi.advanceTimersByTimeAsync(1_100); // gap elapses -> step 2
      await vi.advanceTimersByTimeAsync(1_100); // step 2's gap, then the cap
      await run;
      expect(agent.prompts.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off on retryable provider errors and stop() interrupts the wait", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const agent = new FakeAgent(bus);
      agent.steps = [[], [], [], []];
      agent.onRun = () => bus.emit({ type: "error", error: "overloaded", retryable: true });
      const events = collect(bus);
      const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
        mode: "eternal",
        failureBudget: 99,
        cycleGapMs: 0,
      });
      const run = engine.start("g");
      await vi.advanceTimersByTimeAsync(2100); // first backoff (2s) elapses
      const backoffs = events.filter((e) => e.type === "autonomy_backoff") as {
        ms: number;
        attempt: number;
      }[];
      expect(backoffs[0]).toMatchObject({ ms: 2000, attempt: 1 });
      // Second backoff (4s) is pending — stop mid-wait; the ≤250ms slices notice.
      await vi.advanceTimersByTimeAsync(500);
      engine.stop();
      await vi.advanceTimersByTimeAsync(500);
      await run;
      expect(engine.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hung eternal step after stepTimeoutMs and journals an error", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const agent = new FakeAgent(bus);
      const events = collect(bus);
      let calls = 0;
      // First step hangs until the timeout aborts it; the second returns at once.
      (agent as unknown as { run: (p: string, s?: AbortSignal) => Promise<void> }).run = (
        _p,
        signal,
      ) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return Promise.resolve();
      };
      const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
        mode: "eternal",
        hardCap: true,
        maxSteps: 2,
        stepTimeoutMs: 5_000,
        failureBudget: 99,
        cycleGapMs: 0,
      });
      const run = engine.start("g");
      await vi.advanceTimersByTimeAsync(5_100);
      await run;
      const journal = events.filter((e) => e.type === "autonomy_journal") as {
        status: string;
        note: string;
      }[];
      expect(journal[0]?.status).toBe("error");
      expect(journal[0]?.note).toContain("aborted after 5s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AutonomyEngine loop-cut reaction (bounded modes)", () => {
  it("stops after two consecutive cut steps with reason 'loop detected'", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["write"]];
    agent.onRun = () => bus.emit({ type: "loop_cut", streak: 5 });
    const events = collect(bus);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 10,
    });
    await engine.start("g");
    const stopped = events.find((e) => e.type === "autonomy_stopped") as { reason: string };
    expect(stopped.reason).toBe("loop detected");
    // The first cut queued a pivot steer before the second one stopped the run.
    expect(events.some((e) => e.type === "autonomy_steer")).toBe(true);
  });
});

describe("AutonomyEngine run budget", () => {
  /**
   * Stands in for the agent's `response.budgetMeter` stage: spend, then emit
   * the soft signal exactly once — the engine only ever learns about the soft
   * threshold through that event.
   */
  function spender(bus: EventBus, budget: RunBudget, perStep: number) {
    return (): void => {
      budget.spend({ promptTokens: perStep, totalTokens: perStep }, "m", "p");
      if (budget.takeSoftSignal()) {
        bus.emit({ type: "budget_warning", spent: budget.describe() });
      }
    };
  }

  it("stops the run when the budget is spent, naming the figure", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    // Never claims done: only the budget can end this.
    agent.steps = Array.from({ length: 50 }, () => ["write"]);
    const events = collect(bus);
    const budget = new RunBudget({ tokens: 1000, catalog: [] });
    agent.onRun = spender(bus, budget, 400);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 50,
      budget,
    });

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    // The LAST stop event, not the first: a second one emitted after this would
    // be what a reader (and `--json`'s summary) actually reports, so asserting
    // on `find` would pass while the run explained itself wrongly.
    const stops = events.filter((e) => e.type === "autonomy_stopped");
    expect(stops).toHaveLength(1);
    const stop = stops.at(-1);
    expect(stop && "reason" in stop && stop.reason).toContain("run budget spent");
    expect(stop && "reason" in stop && stop.reason).toContain("1,200/1,000 tokens");
    // Stopped on the budget, nowhere near the step cap.
    expect(agent.prompts.length).toBeLessThan(10);
  });

  it("bounds eternal mode too — the run that cannot run out of steps must run out of money", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = Array.from({ length: 100 }, () => ["write"]);
    const budget = new RunBudget({ tokens: 500, catalog: [] });
    agent.onRun = spender(bus, budget, 200);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "eternal",
      // No hardCap: without a budget this loop is unbounded by construction.
      cycleGapMs: 0,
      budget,
    });

    await engine.start("g");

    expect(engine.state).toBe("stopped");
    expect(agent.prompts.length).toBeLessThan(10);
  });

  it("turns the soft threshold into a wrap-up steer, not a stop", async () => {
    // The soft signal must reach the NEXT prompt: pendingSteer is the channel a
    // verifier rejection already uses, which is why no mode needs its own
    // wrap-up plumbing.
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["write"], ["task_done"]];
    const budget = new RunBudget({ tokens: 1000, softRatio: 0.5, catalog: [] });
    agent.onRun = spender(bus, budget, 300);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 5,
      budget,
    });

    await engine.start("g");

    // Step 1 spends 300 (30%): no signal yet. Step 2 reaches 600 (60%) and the
    // wrap-up lands in step 3's prompt.
    expect(agent.prompts[1]).not.toContain("Wrap up NOW");
    expect(agent.prompts[2]).toContain("Wrap up NOW");
    expect(agent.prompts[2]).toContain("task_done");
    // Asked to land, not cut off: the run still reached its own completion.
    expect(engine.state).toBe("done");
  });

  it("does nothing at all when no ceiling is configured", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent(bus);
    agent.steps = [["write"], ["task_done"]];
    const budget = new RunBudget({ catalog: [] });
    agent.onRun = spender(bus, budget, 1_000_000);
    const engine = new AutonomyEngine(agent as unknown as Agent, bus, taskDone, {
      mode: "once",
      maxSteps: 5,
      budget,
    });

    await engine.start("g");

    expect(engine.state).toBe("done");
    expect(agent.prompts.some((p) => p.includes("Wrap up NOW"))).toBe(false);
  });
});
