import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanStore, planAge, planPath } from "./plan.js";

let home: string;
let store: PlanStore;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "arterm-plan-"));
  store = new PlanStore(planPath("session-1", home));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("PlanStore", () => {
  it("returns nothing before anything is written", async () => {
    expect(await store.get()).toBeUndefined();
  });

  it("round-trips a plan and stamps when it was written", async () => {
    await store.set("port the parser", "move it to core, keep the old export");
    const doc = await store.get();
    expect(doc?.title).toBe("port the parser");
    expect(doc?.body).toContain("keep the old export");
    expect(doc?.updatedAt).toBeGreaterThan(0);
  });

  it("replaces rather than merges", async () => {
    // Same argument as the todo list: a partial update to a plan the model
    // half-remembers is the failure mode.
    await store.set("first", "a");
    await store.set("second", "b");
    const doc = await store.get();
    expect(doc?.title).toBe("second");
    expect(doc?.body).toBe("b");
  });

  it("keeps one plan per session", async () => {
    // A project-wide file would be read by a session started days later for
    // something unrelated, and a stale plan silently steering a run is worse
    // than no plan.
    const other = new PlanStore(planPath("session-2", home));
    await store.set("mine", "x");
    expect(await other.get()).toBeUndefined();
  });

  it("survives a corrupt file rather than failing the run", async () => {
    // A plan is an aid; a run that cannot start because its notes are
    // malformed is a worse outcome than a run without notes.
    const file = planPath("session-1", home);
    await fs.mkdir(join(home, "plans"), { recursive: true });
    await fs.writeFile(file, "{ not json");
    expect(await store.get()).toBeUndefined();
  });

  it("ignores a file that is JSON but not a plan", async () => {
    const file = planPath("session-1", home);
    await fs.mkdir(join(home, "plans"), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ something: "else" }));
    expect(await store.get()).toBeUndefined();
  });

  it("clears", async () => {
    await store.set("t", "b");
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });

  it("clearing something that was never there is not an error", async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

describe("planAge", () => {
  it("scales with the distance a reader cares about", () => {
    const now = 1_000_000_000;
    expect(planAge(now, now)).toBe("just now");
    expect(planAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(planAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(planAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("never reports the future", () => {
    expect(planAge(2_000, 1_000)).toBe("just now");
  });
});
