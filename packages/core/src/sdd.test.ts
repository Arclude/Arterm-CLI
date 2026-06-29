import { describe, expect, it } from "vitest";
import type { Agent } from "./agent.js";
import type { AutonomyTask, AutonomyTaskResult } from "./autonomy.js";
import { EventBus } from "./eventBus.js";
import { SddRunner, type SddSpec, parseGraph, parseStringArray } from "./sdd.js";
import type { SddStore } from "./sddStore.js";

/** Scriptable Agent stand-in: plan() returns successive scripted strings. */
class FakeAgent {
  plans: string[] = [];
  private n = 0;
  async plan(): Promise<string> {
    const out = this.plans[this.n] ?? "[]";
    this.n += 1;
    return out;
  }
  async run(): Promise<void> {}
}

function memStore(): SddStore & { saved: SddSpec[] } {
  const saved: SddSpec[] = [];
  return {
    saved,
    async save(spec) {
      saved.push(spec);
      return `/tmp/sdd/${spec.id}`;
    },
    async load(id) {
      return saved.find((s) => s.id === id);
    },
    async list() {
      return saved.map((s) => ({ id: s.id, brief: s.brief, createdAt: s.createdAt }));
    },
  };
}

function makeRunner(
  agent: FakeAgent,
  bus: EventBus,
  runFleet: (t: AutonomyTask[], s: AbortSignal) => Promise<AutonomyTaskResult[]>,
  store: SddStore,
) {
  return new SddRunner(agent as unknown as Agent, bus, runFleet, store, {
    now: () => "TEST-ID",
    fanout: 8,
  });
}

describe("parseGraph", () => {
  it("parses a fenced ```json block", () => {
    const raw = 'Some spec.\n```json\n{"tasks":[{"id":"t1","title":"A","dependsOn":[]}]}\n```';
    expect(parseGraph(raw).tasks).toHaveLength(1);
    expect(parseGraph(raw).tasks[0]?.title).toBe("A");
  });
  it("falls back to a bare object", () => {
    const raw = '{"tasks":[{"title":"X"}]}';
    expect(parseGraph(raw).tasks[0]?.title).toBe("X");
  });
  it("returns empty on garbage", () => {
    expect(parseGraph("no json here").tasks).toEqual([]);
  });
});

describe("parseStringArray", () => {
  it("extracts a string array amid prose", () => {
    expect(parseStringArray('Here: ["a","b"] ok')).toEqual(["a", "b"]);
  });
  it("drops non-strings and empties", () => {
    expect(parseStringArray('["a", 2, "", "b"]')).toEqual(["a", "b"]);
  });
});

describe("SddRunner.buildSpec", () => {
  it("drops unknown deps, breaks cycles, clamps roles", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    agent.plans = [
      '# Spec\n```json\n{"tasks":[' +
        '{"id":"t1","title":"a","dependsOn":["t2"],"role":"tester"},' +
        '{"id":"t2","title":"b","dependsOn":["t1"]},' +
        '{"id":"t3","title":"c","dependsOn":["nope"],"role":"wizard"}' +
        "]}\n```",
    ];
    const runner = makeRunner(agent, bus, async () => [], memStore());

    const spec = await runner.buildSpec("do x", []);
    const byId = new Map(spec.graph.tasks.map((t) => [t.id, t]));

    // One of the t1<->t2 cycle edges is dropped (graph stays a DAG).
    const t1 = byId.get("t1");
    const t2 = byId.get("t2");
    const cyclic = (t1?.dependsOn.includes("t2") ? 1 : 0) + (t2?.dependsOn.includes("t1") ? 1 : 0);
    expect(cyclic).toBeLessThan(2);
    // Unknown dep "nope" removed.
    expect(byId.get("t3")?.dependsOn).toEqual([]);
    // Valid role kept, invalid role cleared.
    expect(t1?.role).toBe("tester");
    expect(byId.get("t3")?.role).toBeUndefined();
    // Markdown spec excludes the json block.
    expect(spec.spec).toContain("# Spec");
    expect(spec.spec).not.toContain("```json");
  });

  it("falls back to a single task when no graph parses", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    agent.plans = ["just prose, no json"];
    const runner = makeRunner(agent, bus, async () => [], memStore());

    const spec = await runner.buildSpec("build a thing", []);
    expect(spec.graph.tasks).toHaveLength(1);
    expect(spec.graph.tasks[0]?.title).toBe("build a thing");
  });
});

describe("SddRunner.execute", () => {
  it("respects dependencies: a dependent task waits for its dep", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    const waves: string[][] = [];
    const runFleet = async (tasks: AutonomyTask[]) => {
      waves.push(tasks.map((t) => t.task.split("\n")[0] ?? ""));
      return tasks.map((t) => ({ ...t, output: "ok" }));
    };
    const runner = makeRunner(agent, bus, runFleet, memStore());

    await runner.execute({
      tasks: [
        { id: "t1", title: "first", description: "d1", dependsOn: [], state: "pending" },
        { id: "t2", title: "second", description: "d2", dependsOn: ["t1"], state: "pending" },
        { id: "t3", title: "indep", description: "d3", dependsOn: [], state: "pending" },
      ],
    });

    // Wave 1: t1 + t3 (both ready). Wave 2: t2 (after t1).
    expect(waves).toHaveLength(2);
    expect(waves[0]).toEqual(["first", "indep"]);
    expect(waves[1]).toEqual(["second"]);
  });

  it("blocks a task whose dependency failed", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    const states: { id: string; state: string }[] = [];
    bus.on((e) => {
      if (e.type === "sdd_task_state") states.push({ id: e.id, state: e.state });
    });
    const runFleet = async (tasks: AutonomyTask[]) =>
      tasks.map((t) => ({ ...t, output: "sub-agent failed: boom" }));
    const runner = makeRunner(agent, bus, runFleet, memStore());

    await runner.execute({
      tasks: [
        { id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" },
        { id: "t2", title: "second", description: "d", dependsOn: ["t1"], state: "pending" },
      ],
    });

    // t1 ran and failed; t2 never ran (blocked).
    expect(states.some((s) => s.id === "t1" && s.state === "failed")).toBe(true);
    expect(states.some((s) => s.id === "t2")).toBe(false);
  });

  it("emits sdd_done with done/failed counts", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    let done = -1;
    let failed = -1;
    bus.on((e) => {
      if (e.type === "sdd_done") {
        done = e.done;
        failed = e.failed;
      }
    });
    const runFleet = async (tasks: AutonomyTask[]) => tasks.map((t) => ({ ...t, output: "ok" }));
    const runner = makeRunner(agent, bus, runFleet, memStore());

    await runner.execute({
      tasks: [{ id: "t1", title: "a", description: "d", dependsOn: [], state: "pending" }],
    });

    expect(done).toBe(1);
    expect(failed).toBe(0);
  });
});

describe("SddRunner.run", () => {
  it("skips the interview when no ask callback is given", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    // Only buildSpec consumes a plan() (interview skipped).
    agent.plans = ['```json\n{"tasks":[{"id":"t1","title":"a","dependsOn":[]}]}\n```'];
    let interviewed = false;
    bus.on((e) => {
      if (e.type === "sdd_interview") interviewed = true;
    });
    const runFleet = async (tasks: AutonomyTask[]) => tasks.map((t) => ({ ...t, output: "ok" }));
    const store = memStore();
    const runner = makeRunner(agent, bus, runFleet, store);

    const spec = await runner.run("brief", undefined);

    expect(interviewed).toBe(false);
    expect(spec.id).toBe("TEST-ID");
    expect(store.saved).toHaveLength(1);
    expect(runner.state).toBe("done");
  });
});
