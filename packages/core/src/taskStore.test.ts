import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore, taskPath, validateGraph } from "./taskStore.js";

let home: string;
let store: TaskStore;

const task = (id: string, dependsOn: string[] = [], state = "pending" as const) => ({
  id,
  title: `task ${id}`,
  description: "",
  dependsOn,
  state,
});

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "arterm-tasks-"));
  store = new TaskStore(taskPath("s1", home));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("validateGraph", () => {
  it("accepts a well-formed graph", () => {
    expect(validateGraph([task("a"), task("b", ["a"])])).toBeUndefined();
  });

  it("rejects an edge to a task that does not exist", () => {
    expect(validateGraph([task("a", ["ghost"])])).toContain("does not exist");
  });

  it("rejects a cycle, naming the path", () => {
    // The important one: nothing in a cycle is ever ready, so a run holding a
    // cyclic graph waits forever on work it has already been given — and the
    // symptom (an idle fleet) points nowhere near the cause.
    const error = validateGraph([task("a", ["c"]), task("b", ["a"]), task("c", ["b"])]);
    expect(error).toContain("cycle");
    expect(error).toContain("→");
  });

  it("rejects a self-dependency", () => {
    expect(validateGraph([task("a", ["a"])])).toContain("cycle");
  });

  it("rejects duplicates and empty fields", () => {
    expect(validateGraph([task("a"), task("a")])).toContain("duplicate");
    expect(validateGraph([{ ...task("a"), title: "" }])).toContain("id and a title");
  });
});

describe("TaskStore.ready", () => {
  it("offers only tasks whose dependencies are all done", async () => {
    await store.replace([task("a"), task("b", ["a"]), task("c", ["a", "b"])]);
    expect(store.ready().map((t) => t.id)).toEqual(["a"]);

    await store.setState("a", "done");
    expect(store.ready().map((t) => t.id)).toEqual(["b"]);

    await store.setState("b", "done");
    expect(store.ready().map((t) => t.id)).toEqual(["c"]);
  });

  it("offers independent tasks together — the reason the graph exists", async () => {
    // A flat list cannot answer "what can run NOW, in parallel".
    await store.replace([task("a"), task("b"), task("c", ["a"])]);
    expect(store.ready().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("never unblocks work whose dependency FAILED", async () => {
    // Work built on something that did not happen is work built on nothing,
    // and letting it start is how a fan-out produces confidently wrong output.
    await store.replace([task("a"), task("b", ["a"])]);
    await store.setState("a", "failed");
    expect(store.ready()).toEqual([]);
    expect(store.blocked().map((t) => t.id)).toEqual(["b"]);
  });

  it("reports nothing blocked when nothing failed", async () => {
    await store.replace([task("a"), task("b", ["a"])]);
    expect(store.blocked()).toEqual([]);
  });

  it("does not re-offer a task that is already running", async () => {
    await store.replace([task("a")]);
    await store.setState("a", "running");
    expect(store.ready()).toEqual([]);
  });
});

describe("TaskStore persistence", () => {
  it("survives a reload", async () => {
    await store.replace([task("a"), task("b", ["a"])]);
    await store.setState("a", "done");

    const reopened = new TaskStore(taskPath("s1", home));
    await reopened.load();
    expect(reopened.ready().map((t) => t.id)).toEqual(["b"]);
  });

  it("refuses a bad graph without disturbing the stored one", async () => {
    await store.replace([task("a")]);
    const result = await store.replace([task("x", ["nope"])]);
    expect(result.ok).toBe(false);
    expect(store.list().map((t) => t.id)).toEqual(["a"]);
  });

  it("starts empty rather than failing on an unreadable file", async () => {
    await fs.mkdir(join(home, "tasks"), { recursive: true });
    await fs.writeFile(taskPath("s2", home), "{{{");
    const broken = new TaskStore(taskPath("s2", home));
    await broken.load();
    expect(broken.list()).toEqual([]);
  });

  it("ignores a stored graph that no longer validates", async () => {
    // Hand-edited, or written by an older version: a cyclic graph loaded
    // silently would hang the run it was loaded into.
    await fs.mkdir(join(home, "tasks"), { recursive: true });
    await fs.writeFile(
      taskPath("s3", home),
      JSON.stringify({ tasks: [task("a", ["b"]), task("b", ["a"])] }),
    );
    const bad = new TaskStore(taskPath("s3", home));
    await bad.load();
    expect(bad.list()).toEqual([]);
  });

  it("says so when a state change names a task that is not there", async () => {
    const result = await store.setState("ghost", "done");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
  });
});
