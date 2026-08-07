import { describe, expect, it } from "vitest";
import { FleetRegistry, type WorkerRunner } from "./fleetRegistry.js";

/** A worker whose task completion the test controls. */
function controllable() {
  const gates = new Map<string, { resolve: (out: string) => void; reject: (e: Error) => void }>();
  const started: string[] = [];
  const aborted: string[] = [];
  const runner: WorkerRunner = {
    run(task, signal) {
      started.push(task);
      return new Promise<string>((resolve, reject) => {
        gates.set(task, { resolve, reject });
        signal?.addEventListener("abort", () => {
          aborted.push(task);
          resolve("(aborted)");
        });
      });
    },
    stop() {},
  };
  return {
    runner,
    started,
    aborted,
    finish: (task: string, out = `did: ${task}`) => gates.get(task)?.resolve(out),
    fail: (task: string, why: string) => gates.get(task)?.reject(new Error(why)),
  };
}

/** A registry over one controllable runner per worker. */
function harness(opts: { maxWorkers?: number } = {}) {
  const controls = new Map<string, ReturnType<typeof controllable>>();
  const registry = new FleetRegistry({
    ...(opts.maxWorkers !== undefined ? { maxWorkers: opts.maxWorkers } : {}),
    createWorker(spec) {
      const c = controllable();
      controls.set(spec.id, c);
      return c.runner;
    },
  });
  return { registry, controls };
}

/** Let queued microtasks run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("spawning", () => {
  it("creates a worker without running anything", async () => {
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "parser" });
    expect(w.state).toBe("idle");
    await tick();
    // The whole difference from `spawn`: no model call has happened.
    expect(controls.get(w.id)?.started).toEqual([]);
  });

  it("refuses past the worker cap — a leader is a fan-out too", () => {
    const { registry } = harness({ maxWorkers: 2 });
    registry.spawn({ name: "a" });
    registry.spawn({ name: "b" });
    expect(() => registry.spawn({ name: "c" })).toThrow(/fleet is full/);
  });

  it("frees a slot when a worker is terminated", () => {
    const { registry } = harness({ maxWorkers: 1 });
    const a = registry.spawn({ name: "a" });
    expect(() => registry.spawn({ name: "b" })).toThrow();
    registry.terminate(a.id);
    expect(() => registry.spawn({ name: "b" })).not.toThrow();
  });
});

describe("assigning without blocking", () => {
  it("returns a task id immediately and starts the work", async () => {
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const t = registry.assign(w.id, "read the parser");
    expect(t.state).toBe("queued");
    await tick();
    expect(controls.get(w.id)?.started).toEqual(["read the parser"]);
    expect(registry.getTask(t.id)?.state).toBe("running");
  });

  it("runs one worker's tasks IN ORDER, never overlapping", async () => {
    // Two runs interleaving on one agent would braid two conversations into
    // one history.
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    registry.assign(w.id, "first");
    registry.assign(w.id, "second");
    await tick();
    const c = controls.get(w.id);
    expect(c?.started).toEqual(["first"]);

    c?.finish("first");
    await tick();
    expect(c?.started).toEqual(["first", "second"]);
  });

  it("runs different workers concurrently", async () => {
    const { registry, controls } = harness();
    const a = registry.spawn({ name: "a" });
    const b = registry.spawn({ name: "b" });
    registry.assign(a.id, "ta");
    registry.assign(b.id, "tb");
    await tick();
    expect(controls.get(a.id)?.started).toEqual(["ta"]);
    expect(controls.get(b.id)?.started).toEqual(["tb"]);
  });

  it("keeps a worker usable after one of its tasks fails", async () => {
    // A rejected chain link must not silently stop the worker.
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const bad = registry.assign(w.id, "boom");
    registry.assign(w.id, "next");
    await tick();
    controls.get(w.id)?.fail("boom", "provider exploded");
    await tick();

    expect(registry.getTask(bad.id)?.state).toBe("failed");
    expect(registry.getTask(bad.id)?.result).toContain("provider exploded");
    expect(controls.get(w.id)?.started).toEqual(["boom", "next"]);
  });

  it("refuses to queue on a terminated worker", () => {
    const { registry } = harness();
    const w = registry.spawn({ name: "a" });
    registry.terminate(w.id);
    expect(() => registry.assign(w.id, "x")).toThrow(/terminated/);
  });

  it("names an unknown worker rather than failing obscurely", () => {
    const { registry } = harness();
    expect(() => registry.assign("w99", "x")).toThrow(/no such worker/);
  });
});

describe("awaiting", () => {
  it("'all' waits for every named task", async () => {
    const { registry, controls } = harness();
    const a = registry.spawn({ name: "a" });
    const b = registry.spawn({ name: "b" });
    const ta = registry.assign(a.id, "ta");
    const tb = registry.assign(b.id, "tb");

    const waiting = registry.awaitTasks({ taskIds: [ta.id, tb.id], mode: "all" });
    await tick();
    controls.get(a.id)?.finish("ta");
    await tick();
    controls.get(b.id)?.finish("tb");

    const { settled, pending, timedOut } = await waiting;
    expect(settled.map((t) => t.id).sort()).toEqual([ta.id, tb.id].sort());
    expect(pending).toEqual([]);
    expect(timedOut).toBe(false);
  });

  it("'any' returns on the first result — that is what makes a pipeline", async () => {
    const { registry, controls } = harness();
    const a = registry.spawn({ name: "a" });
    const b = registry.spawn({ name: "b" });
    const ta = registry.assign(a.id, "slow");
    const tb = registry.assign(b.id, "fast");

    const waiting = registry.awaitTasks({ taskIds: [ta.id, tb.id], mode: "any" });
    await tick();
    controls.get(b.id)?.finish("fast", "quick answer");

    const { settled, pending } = await waiting;
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toBe("quick answer");
    expect(pending.map((t) => t.id)).toEqual([ta.id]);
  });

  it("a timeout returns what finished and keeps the rest collectable", async () => {
    // Throwing here would lose the ids of work that is still running.
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const t = registry.assign(w.id, "long");

    const first = await registry.awaitTasks({ taskIds: [t.id], timeoutMs: 10 });
    expect(first.timedOut).toBe(true);
    expect(first.settled).toEqual([]);
    expect(first.pending.map((p) => p.id)).toEqual([t.id]);

    controls.get(w.id)?.finish("long", "eventually");
    const second = await registry.awaitTasks({ taskIds: [t.id] });
    expect(second.settled[0]?.result).toBe("eventually");
  });

  it("with no ids waits only for OUTSTANDING work", async () => {
    // Otherwise `any` returns instantly with a result the caller already has.
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const oldTask = registry.assign(w.id, "old");
    await tick();
    controls.get(w.id)?.finish("old");
    await tick();

    const fresh = registry.assign(w.id, "new");
    await tick();
    const waiting = registry.awaitTasks({ mode: "any" });
    controls.get(w.id)?.finish("new", "the new one");
    const { settled } = await waiting;
    expect(settled.map((t) => t.id)).toEqual([fresh.id]);
    expect(settled.map((t) => t.id)).not.toContain(oldTask.id);
  });

  it("says so when there is nothing outstanding", async () => {
    const { registry } = harness();
    registry.spawn({ name: "a" });
    const r = await registry.awaitTasks({});
    expect(r.settled).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.timedOut).toBe(false);
  });
});

describe("terminating", () => {
  it("aborts what is running and cancels what is queued", async () => {
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const running = registry.assign(w.id, "running");
    const queued = registry.assign(w.id, "queued");
    await tick();

    registry.terminate(w.id);
    await tick();

    expect(controls.get(w.id)?.aborted).toEqual(["running"]);
    expect(registry.getTask(queued.id)?.state).toBe("cancelled");
    expect(registry.getTask(running.id)?.state).toBe("cancelled");
  });

  it("keeps the terminated worker's record and its finished results", async () => {
    // A fleet's history is how a leader accounts for what it spent.
    const { registry, controls } = harness();
    const w = registry.spawn({ name: "a" });
    const t = registry.assign(w.id, "done work");
    await tick();
    controls.get(w.id)?.finish("done work", "the finding");
    await tick();

    registry.terminate(w.id);
    expect(registry.getWorker(w.id)?.state).toBe("terminated");
    expect(registry.getTask(t.id)?.result).toBe("the finding");
  });

  it("wakes anyone waiting on a cancelled task instead of hanging", async () => {
    const { registry } = harness();
    const w = registry.spawn({ name: "a" });
    registry.assign(w.id, "one");
    const queued = registry.assign(w.id, "two");
    await tick();

    const waiting = registry.awaitTasks({ taskIds: [queued.id] });
    registry.terminate(w.id);
    const { settled } = await waiting;
    expect(settled[0]?.state).toBe("cancelled");
  });

  it("terminateAll reports how many were live", () => {
    const { registry } = harness();
    registry.spawn({ name: "a" });
    registry.spawn({ name: "b" });
    expect(registry.terminateAll()).toBe(2);
    expect(registry.terminateAll()).toBe(0);
  });
});

describe("change notifications", () => {
  it("fires on every state transition, so a board can follow", async () => {
    let changes = 0;
    const controls = new Map<string, ReturnType<typeof controllable>>();
    const registry = new FleetRegistry({
      createWorker(spec) {
        const c = controllable();
        controls.set(spec.id, c);
        return c.runner;
      },
      onChange: () => changes++,
    });
    const w = registry.spawn({ name: "a" });
    const before = changes;
    registry.assign(w.id, "t");
    await tick();
    controls.get(w.id)?.finish("t");
    await tick();
    expect(changes).toBeGreaterThan(before);
  });
});
