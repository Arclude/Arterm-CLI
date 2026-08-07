import { FleetRegistry, NEVER_SUBAGENT_TOOLS, subagentRoster } from "@arterm/core";
import type { Tool, WorkerRunner } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { FLEET_TOOL_NAMES, createFleetTools } from "./fleet.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fleet whose workers finish when the test says so. */
function harness(
  opts: {
    rollUp?: (p: Array<{ label: string; text: string }>, f?: string) => Promise<string>;
  } = {},
) {
  const gates = new Map<string, (out: string) => void>();
  const registry = new FleetRegistry({
    createWorker(): WorkerRunner {
      return {
        run(task, signal) {
          return new Promise<string>((resolve) => {
            gates.set(task, resolve);
            signal?.addEventListener("abort", () => resolve("(aborted)"));
          });
        },
        stop() {},
      };
    },
  });
  const tools = createFleetTools({
    registry,
    ...(opts.rollUp ? { rollUp: opts.rollUp } : {}),
  });
  const byName = (name: string) => tools.find((t) => t.name === name) as Tool;
  const ctx = { cwd: process.cwd() };
  return {
    registry,
    tools,
    ctx,
    finish: (task: string, out: string) => gates.get(task)?.(out),
    call: (name: string, args: Record<string, unknown>) => byName(name).execute(args, ctx),
  };
}

/** The worker id out of spawn_subagent's confirmation. */
const idOf = (output: string) => output.match(/worker (\w+)/)?.[1] ?? "";
const taskOf = (output: string) => output.match(/task (\w+)/)?.[1] ?? "";

describe("the fleet family is exactly six tools", () => {
  it("registers each one once", () => {
    const names = createFleetTools({
      registry: new FleetRegistry({ createWorker: () => ({ run: async () => "", stop() {} }) }),
    }).map((t) => t.name);
    expect(names).toEqual([...FLEET_TOOL_NAMES]);
  });

  it("a worker can never receive any of them", () => {
    // A worker that can spawn is a fan-out with nothing counting it — the same
    // reason `spawn` was already excluded, one level up.
    for (const name of FLEET_TOOL_NAMES) {
      expect(NEVER_SUBAGENT_TOOLS.has(name), `${name} is reachable from a worker`).toBe(true);
    }
    const parent = [...FLEET_TOOL_NAMES, "read"].map((name) => ({ name }));
    expect(subagentRoster(parent).map((t) => t.name)).toEqual(["read"]);
  });

  it("an explicit allowlist cannot grant them back", () => {
    const parent = [{ name: "spawn_subagent" }, { name: "read" }];
    expect(subagentRoster(parent, ["spawn_subagent", "read"]).map((t) => t.name)).toEqual(["read"]);
  });
});

describe("spawn_subagent", () => {
  it("returns an id without running anything", async () => {
    const h = harness();
    const res = await h.call("spawn_subagent", { name: "parser" });
    expect(res.isError).toBeFalsy();
    expect(idOf(res.output)).toBeTruthy();
    expect(h.registry.listTasks()).toEqual([]);
  });

  it("reports the cap rather than silently queueing", async () => {
    const registry = new FleetRegistry({
      maxWorkers: 1,
      createWorker: () => ({ run: async () => "", stop() {} }),
    });
    const [spawn] = createFleetTools({ registry });
    const ctx = { cwd: process.cwd() };
    await (spawn as Tool).execute({ name: "a" }, ctx);
    const res = await (spawn as Tool).execute({ name: "b" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("fleet is full");
  });
});

describe("assign_task returns before the work is done", () => {
  it("hands back a task id immediately", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    const res = await h.call("assign_task", { worker: w, task: "read it" });
    expect(res.output).toContain("queued");
    // Nothing has finished; the tool returned anyway. That is the difference
    // from `spawn`, which blocks the whole turn.
    await tick();
    expect(h.registry.listTasks()[0]?.state).toBe("running");
  });

  it("names an unknown worker", async () => {
    const h = harness();
    const res = await h.call("assign_task", { worker: "w99", task: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no such worker");
  });
});

describe("await_tasks", () => {
  it("returns results once they settle", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: w, task: "read it" });
    await tick();
    h.finish("read it", "found three call sites");

    const res = await h.call("await_tasks", {});
    expect(res.output).toContain("found three call sites");
  });

  it("a timeout says the work is not lost", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    const t = taskOf((await h.call("assign_task", { worker: w, task: "slow" })).output);
    const res = await h.call("await_tasks", { timeout_ms: 10 });
    expect(res.output).toContain("still running");
    expect(res.output).toContain(t);
    expect(res.output).toContain("not lost");
  });

  it("mode 'any' returns the first finisher and names what is still going", async () => {
    const h = harness();
    const a = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    const b = idOf((await h.call("spawn_subagent", { name: "b" })).output);
    await h.call("assign_task", { worker: a, task: "slow" });
    await h.call("assign_task", { worker: b, task: "fast" });
    await tick();

    const waiting = h.call("await_tasks", { mode: "any" });
    h.finish("fast", "quick answer");
    const res = await waiting;
    expect(res.output).toContain("quick answer");
    expect(res.output).toContain("still running");
  });

  it("says so when there is nothing outstanding", async () => {
    const h = harness();
    await h.call("spawn_subagent", { name: "a" });
    expect((await h.call("await_tasks", {})).output).toBe("No outstanding tasks.");
  });

  it("clips a long result and points at the id instead", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    const t = taskOf((await h.call("assign_task", { worker: w, task: "big" })).output);
    const other = idOf((await h.call("spawn_subagent", { name: "b" })).output);
    await h.call("assign_task", { worker: other, task: "small" });
    await tick();
    h.finish("big", "x".repeat(50_000));
    h.finish("small", "ok");

    const res = await h.call("await_tasks", {});
    // Five workers returning 20 KB each must not cost the leader 100 KB before
    // the leader has decided what matters.
    expect(res.output.length).toBeLessThan(10_000);
    expect(res.output).toContain(t);
  });
});

describe("ask_subagent", () => {
  it("returns the worker's answer in full", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    const asking = h.call("ask_subagent", { worker: w, question: "what did you find?" });
    await tick();
    // The question reaches the worker framed as a question, not as work.
    const queued = h.registry.listTasks()[0];
    expect(queued?.task).toContain("Do not start new work");
    h.finish(queued?.task ?? "", "the parser has two entry points");

    expect((await asking).output).toContain("the parser has two entry points");
  });

  it("says the worker is busy rather than hanging forever", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: w, task: "long job" });
    await tick();
    const res = await h.call("ask_subagent", { worker: w, question: "hi", timeout_ms: 10 });
    expect(res.output).toContain("has not answered");
    expect(res.output).toContain("await_tasks");
  });
});

describe("roll_up", () => {
  it("summarises without the results entering this conversation", async () => {
    let sawBytes = 0;
    const h = harness({
      rollUp: async (parts) => {
        sawBytes = parts.reduce((n, p) => n + p.text.length, 0);
        return "two workers agree, one disagrees about the cache";
      },
    });
    const a = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: a, task: "one" });
    await tick();
    h.finish("one", "y".repeat(30_000));
    await tick();

    const res = await h.call("roll_up", {});
    expect(sawBytes).toBe(30_000);
    expect(res.output).toContain("two workers agree");
    expect(res.output.length).toBeLessThan(1_000);
  });

  it("hands back the labelled results when no summariser is wired", async () => {
    // Losing the size saving beats losing the content.
    const h = harness();
    const a = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: a, task: "one" });
    await tick();
    h.finish("one", "the finding");
    await tick();

    const res = await h.call("roll_up", {});
    expect(res.output).toContain("the finding");
  });

  it("says there is nothing to roll up rather than summarising nothing", async () => {
    const h = harness();
    const res = await h.call("roll_up", {});
    expect(res.isError).toBe(true);
  });

  it("reports a summariser failure instead of swallowing it", async () => {
    const h = harness({
      rollUp: async () => {
        throw new Error("provider down");
      },
    });
    const a = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: a, task: "one" });
    await tick();
    h.finish("one", "x");
    await tick();
    const res = await h.call("roll_up", {});
    expect(res.isError).toBe(true);
    expect(res.output).toContain("provider down");
  });
});

describe("fleet", () => {
  it("status names each worker and what it is doing", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "parser", role: "explorer" })).output);
    await h.call("assign_task", { worker: w, task: "read it" });
    await tick();

    const res = await h.call("fleet", {});
    expect(res.output).toContain("parser");
    expect(res.output).toContain("explorer");
    expect(res.output).toContain("outstanding");
  });

  it("terminate stops a worker and cancels its queue", async () => {
    const h = harness();
    const w = idOf((await h.call("spawn_subagent", { name: "a" })).output);
    await h.call("assign_task", { worker: w, task: "running" });
    const queued = taskOf((await h.call("assign_task", { worker: w, task: "queued" })).output);
    await tick();

    const res = await h.call("fleet", { action: "terminate", worker: w });
    expect(res.output).toContain("terminated");
    expect(h.registry.getTask(queued)?.state).toBe("cancelled");
  });

  it("terminate_all reports the count", async () => {
    const h = harness();
    await h.call("spawn_subagent", { name: "a" });
    await h.call("spawn_subagent", { name: "b" });
    expect((await h.call("fleet", { action: "terminate_all" })).output).toContain("2");
  });

  it("says the fleet is empty rather than printing a bare header", async () => {
    const h = harness();
    expect((await h.call("fleet", {})).output).toContain("No workers");
  });
});
