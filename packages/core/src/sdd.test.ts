import { describe, expect, it } from "vitest";
import type { Agent } from "./agent.js";
import type { AutonomyTask, AutonomyTaskResult } from "./autonomy.js";
import { EventBus } from "./eventBus.js";
import { SddRunner, type SddSpec, parseGraph, parseStringArray } from "./sdd.js";
import type { SddStore } from "./sddStore.js";
import type { Verifier } from "./verify.js";

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
  opts: { verify?: Verifier; cwd?: string; handoffChars?: number; specChars?: number } = {},
) {
  return new SddRunner(agent as unknown as Agent, bus, runFleet, store, {
    now: () => "TEST-ID",
    fanout: 8,
    ...opts,
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
      tasks.map((t) => ({ ...t, output: "sub-agent failed: boom", error: true }));
    const runner = makeRunner(agent, bus, runFleet, memStore());
    let doneEvent: { done: number; failed: number; blocked: number } | undefined;
    bus.on((e) => {
      if (e.type === "sdd_done") doneEvent = { done: e.done, failed: e.failed, blocked: e.blocked };
    });

    await runner.execute({
      tasks: [
        { id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" },
        { id: "t2", title: "second", description: "d", dependsOn: ["t1"], state: "pending" },
        { id: "t3", title: "third", description: "d", dependsOn: ["t2"], state: "pending" },
      ],
    });

    // t1 ran and failed. t2 and t3 can never run — and saying so is the point:
    // reporting "0 done, 1 failed" while two tasks silently never ran is a lie by
    // omission, and it used to be exactly what happened (no event at all for them).
    expect(states.some((s) => s.id === "t1" && s.state === "failed")).toBe(true);
    expect(states.some((s) => s.id === "t2" && s.state === "blocked")).toBe(true);
    expect(states.some((s) => s.id === "t3" && s.state === "blocked")).toBe(true);
    expect(doneEvent).toEqual({ done: 0, failed: 1, blocked: 2 });
  });

  it("counts a patch conflict as failed, not done", async () => {
    // runFleet flags a conflict with `error` WITHOUT changing the output text, so
    // the old prefix sniff ("sub-agent failed…") scored those as successes.
    const bus = new EventBus();
    const agent = new FakeAgent();
    const states: { id: string; state: string }[] = [];
    bus.on((e) => {
      if (e.type === "sdd_task_state") states.push({ id: e.id, state: e.state });
    });
    const runFleet = async (tasks: AutonomyTask[]) =>
      tasks.map((t) => ({ ...t, output: "patch did not apply cleanly", error: true }));
    const runner = makeRunner(agent, bus, runFleet, memStore());

    await runner.execute({
      tasks: [{ id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" }],
    });

    expect(states.some((s) => s.id === "t1" && s.state === "failed")).toBe(true);
  });

  it("leaves a stopped run's tasks pending rather than calling them blocked", async () => {
    // A user /stop cancels work; it does not make it unreachable.
    const bus = new EventBus();
    const agent = new FakeAgent();
    const states: { id: string; state: string }[] = [];
    bus.on((e) => {
      if (e.type === "sdd_task_state") states.push({ id: e.id, state: e.state });
    });
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) => tasks.map((t) => ({ ...t, output: "ok" })),
      memStore(),
    );
    runner.stop();

    await runner.execute({
      tasks: [
        { id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" },
        { id: "t2", title: "second", description: "d", dependsOn: ["t1"], state: "pending" },
      ],
    });

    expect(states.some((s) => s.state === "blocked")).toBe(false);
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

/** Runs a graph, returning the prompt dispatched for each task id. */
async function dispatch(
  tasks: { id: string; title: string; description: string; dependsOn: string[] }[],
  outputs: Record<string, string>,
  opts: { handoffChars?: number; specChars?: number; spec?: string } = {},
): Promise<Map<string, string>> {
  const { spec, ...runnerOpts } = opts;
  const prompts = new Map<string, string>();
  const titles = new Map(tasks.map((t) => [t.title, t.id]));
  const runner = makeRunner(
    new FakeAgent(),
    new EventBus(),
    async (dispatched: AutonomyTask[]) => {
      for (const d of dispatched) {
        const id = titles.get(d.task.split("\n")[0] ?? "");
        if (id) prompts.set(id, d.task);
      }
      return dispatched.map((d) => ({
        ...d,
        output: outputs[titles.get(d.task.split("\n")[0] ?? "") ?? ""] ?? "ok",
      }));
    },
    memStore(),
    runnerOpts,
  );
  await runner.execute({ tasks: tasks.map((t) => ({ ...t, state: "pending" as const })) }, spec);
  return prompts;
}

describe("SddRunner dependency handoff", () => {
  it("hands a finished dependency's output to the task that depends on it", async () => {
    // The motivating case: read → analyze → fix. Without this, the fix step was
    // handed the analysis step's *title*, never a word of what it found.
    const prompts = await dispatch(
      [
        { id: "t1", title: "analyze", description: "read the logs", dependsOn: [] },
        { id: "t2", title: "fix", description: "fix what analyze found", dependsOn: ["t1"] },
      ],
      { t1: "The crash comes from a null cursor in paginate()." },
    );

    const fix = prompts.get("t2") ?? "";
    expect(fix).toContain("null cursor in paginate()");
    expect(fix).toContain("### t1 — analyze");
    // The upstream task itself has no upstream.
    expect(prompts.get("t1")).not.toContain("tasks you depend on");
  });

  it("hands over every dependency, and only the dependencies", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "schema", description: "d", dependsOn: [] },
        { id: "t2", title: "api", description: "d", dependsOn: [] },
        { id: "t3", title: "unrelated", description: "d", dependsOn: [] },
        { id: "t4", title: "client", description: "d", dependsOn: ["t1", "t2"] },
      ],
      { t1: "SCHEMA-OUTPUT", t2: "API-OUTPUT", t3: "UNRELATED-OUTPUT" },
    );

    const client = prompts.get("t4") ?? "";
    expect(client).toContain("SCHEMA-OUTPUT");
    expect(client).toContain("API-OUTPUT");
    expect(client).not.toContain("UNRELATED-OUTPUT");
  });

  it("keeps both ends of an output too long for the budget", async () => {
    // Losing the tail would drop the conclusion, which is usually the whole point.
    const long = `HEAD-MARKER${"x".repeat(5000)}TAIL-MARKER`;
    const prompts = await dispatch(
      [
        { id: "t1", title: "survey", description: "d", dependsOn: [] },
        { id: "t2", title: "act", description: "d", dependsOn: ["t1"] },
      ],
      { t1: long },
      { handoffChars: 1000 },
    );

    const act = prompts.get("t2") ?? "";
    expect(act).toContain("HEAD-MARKER");
    expect(act).toContain("TAIL-MARKER");
    expect(act).toContain("characters omitted from the middle");
    expect(act.length).toBeLessThan(long.length);
  });

  it("gives each dependency a share rather than letting the first spend it all", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "first", description: "d", dependsOn: [] },
        { id: "t2", title: "second", description: "d", dependsOn: [] },
        { id: "t3", title: "join", description: "d", dependsOn: ["t1", "t2"] },
      ],
      { t1: `A${"a".repeat(4000)}A-END`, t2: `B${"b".repeat(4000)}B-END` },
      { handoffChars: 4000 },
    );

    const join = prompts.get("t3") ?? "";
    expect(join).toContain("A-END");
    expect(join).toContain("B-END");
  });

  it("keeps the verify gate last, after the handoff", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "analyze", description: "d", dependsOn: [] },
        { id: "t2", title: "fix", description: "verify: pnpm test", dependsOn: ["t1"] },
      ],
      { t1: "FINDINGS" },
    );

    const fix = prompts.get("t2") ?? "";
    expect(fix.indexOf("FINDINGS")).toBeLessThan(fix.indexOf("only accepted when"));
  });

  it("omits the handoff when the budget is zero", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "analyze", description: "d", dependsOn: [] },
        { id: "t2", title: "fix", description: "d", dependsOn: ["t1"] },
      ],
      { t1: "FINDINGS" },
      { handoffChars: 0 },
    );

    expect(prompts.get("t2")).not.toContain("FINDINGS");
  });

  it("does not quote a dependency that produced nothing", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "analyze", description: "d", dependsOn: [] },
        { id: "t2", title: "fix", description: "d", dependsOn: ["t1"] },
      ],
      { t1: "   " },
    );

    expect(prompts.get("t2")).not.toContain("tasks you depend on");
  });
});

describe("SddRunner spec context", () => {
  const SPEC =
    "# Auth rewrite\n\nSessions are cookie-backed. Never store the token in localStorage.";
  const GRAPH = [
    { id: "t1", title: "login", description: "d", dependsOn: [] },
    { id: "t2", title: "logout", description: "d", dependsOn: ["t1"] },
  ];

  it("gives every task the spec its graph was cut from", async () => {
    // The point of spec-driven development: the shared decisions live in the spec,
    // and a task description is a sentence, not a design. Before this, the document
    // was written to disk for the human and shown to no worker at all.
    const prompts = await dispatch(GRAPH, {}, { spec: SPEC });

    for (const id of ["t1", "t2"]) {
      expect(prompts.get(id)).toContain("Never store the token in localStorage");
    }
  });

  it("tells the worker to implement only its own task", async () => {
    // Handing over the whole design invites implementing the whole design; two
    // workers building the same section concurrently is worse than one doing it.
    const prompts = await dispatch(GRAPH, {}, { spec: SPEC });

    expect(prompts.get("t1")).toContain("implement ONLY the task above");
  });

  it("clips a spec too long for its budget, keeping both ends", async () => {
    const long = `SPEC-HEAD${"y".repeat(5000)}SPEC-TAIL`;
    const prompts = await dispatch(GRAPH, {}, { spec: long, specChars: 800 });

    const t1 = prompts.get("t1") ?? "";
    expect(t1).toContain("SPEC-HEAD");
    expect(t1).toContain("SPEC-TAIL");
    expect(t1).toContain("characters omitted from the middle");
  });

  it("orders the prompt: task, then spec, then upstream, then the gate", async () => {
    const prompts = await dispatch(
      [
        { id: "t1", title: "analyze", description: "d", dependsOn: [] },
        { id: "t2", title: "fix", description: "verify: pnpm test", dependsOn: ["t1"] },
      ],
      { t1: "UPSTREAM-FINDINGS" },
      { spec: SPEC },
    );

    const fix = prompts.get("t2") ?? "";
    expect(fix.indexOf("cookie-backed")).toBeLessThan(fix.indexOf("UPSTREAM-FINDINGS"));
    expect(fix.indexOf("UPSTREAM-FINDINGS")).toBeLessThan(fix.indexOf("only accepted when"));
  });

  it("omits the spec when the budget is zero", async () => {
    const prompts = await dispatch(GRAPH, {}, { spec: SPEC, specChars: 0 });

    expect(prompts.get("t1")).not.toContain("localStorage");
  });

  it("dispatches unchanged when no spec is supplied", async () => {
    const prompts = await dispatch(GRAPH, {});

    expect(prompts.get("t1")).not.toContain("The spec this task comes from");
  });

  it("carries the spec through the full run(), not just execute()", async () => {
    // The production path builds the spec and the graph in one step; a handoff that
    // only works when execute() is called by hand would help nobody.
    const bus = new EventBus();
    const agent = new FakeAgent();
    agent.plans = [
      '# Design\n\nUse a ring buffer, not a list.\n```json\n{"tasks":[{"id":"t1","title":"a","dependsOn":[]}]}\n```',
    ];
    const dispatched: string[] = [];
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) => {
        for (const t of tasks) dispatched.push(t.task);
        return tasks.map((t) => ({ ...t, output: "ok" }));
      },
      memStore(),
    );

    await runner.run("build it", undefined);

    expect(dispatched[0]).toContain("Use a ring buffer, not a list.");
  });
});

describe("SddRunner verification", () => {
  it("marks a rejected task failed and reports its stranded dependents", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    const states: { id: string; state: string }[] = [];
    let doneEvent: { done: number; failed: number; blocked: number } | undefined;
    bus.on((e) => {
      if (e.type === "sdd_task_state") states.push({ id: e.id, state: e.state });
      if (e.type === "sdd_done") doneEvent = { done: e.done, failed: e.failed, blocked: e.blocked };
    });
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) => tasks.map((t) => ({ ...t, output: "claims it works" })),
      memStore(),
      { verify: async () => ({ pass: false, reason: "no tests", by: "judge" as const }) },
    );

    await runner.execute({
      tasks: [
        { id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" },
        { id: "t2", title: "second", description: "d", dependsOn: ["t1"], state: "pending" },
      ],
    });

    // The worker said it worked; the reviewer disagreed, and the dependent is
    // reported rather than silently never running.
    expect(states.some((s) => s.id === "t1" && s.state === "failed")).toBe(true);
    expect(doneEvent).toEqual({ done: 0, failed: 1, blocked: 1 });
  });

  it("emits a task-scoped verdict", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    const verdicts: { scope?: string; id?: string; pass: boolean }[] = [];
    bus.on((e) => {
      if (e.type === "autonomy_verify") verdicts.push({ scope: e.scope, id: e.id, pass: e.pass });
    });
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) => tasks.map((t) => ({ ...t, output: "ok" })),
      memStore(),
      { verify: async () => ({ pass: true, by: "command" as const }) },
    );

    await runner.execute({
      tasks: [{ id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" }],
    });

    expect(verdicts).toEqual([{ scope: "task", id: "t1", pass: true }]);
  });

  it("does not verify a task the fleet already failed", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    let judged = 0;
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) =>
        tasks.map((t) => ({ ...t, output: "sub-agent failed: boom", error: true })),
      memStore(),
      {
        verify: async () => {
          judged += 1;
          return { pass: true };
        },
      },
    );

    await runner.execute({
      tasks: [{ id: "t1", title: "first", description: "d", dependsOn: [], state: "pending" }],
    });

    expect(judged).toBe(0);
  });

  it("tells the worker about the command that will gate it", async () => {
    const bus = new EventBus();
    const agent = new FakeAgent();
    const dispatched: string[] = [];
    const runner = makeRunner(
      agent,
      bus,
      async (tasks: AutonomyTask[]) => {
        for (const t of tasks) dispatched.push(t.task);
        return tasks.map((t) => ({ ...t, output: "ok" }));
      },
      memStore(),
    );

    await runner.execute({
      tasks: [
        {
          id: "t1",
          title: "port it",
          description: "verify: pnpm test",
          dependsOn: [],
          state: "pending",
        },
        {
          id: "t2",
          title: "doc it",
          description: "write the readme",
          dependsOn: [],
          state: "pending",
        },
      ],
    });

    expect(dispatched[0]).toContain("only accepted when `pnpm test` exits 0");
    expect(dispatched[1]).not.toContain("only accepted");
  });
});
