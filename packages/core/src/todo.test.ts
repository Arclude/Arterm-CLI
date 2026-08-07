import { describe, expect, it, vi } from "vitest";
import { TodoStore, formatTodos } from "./todo.js";

const item = (id: string, status: "pending" | "in_progress" | "done" = "pending") => ({
  id,
  text: `do ${id}`,
  status,
});

describe("TodoStore", () => {
  it("replaces the list wholesale rather than merging", () => {
    // Incremental updates need the model to track ids it invented several
    // turns ago; a half-applied update to a plan is worse than no plan.
    const store = new TodoStore();
    store.replace([item("1"), item("2")]);
    store.replace([item("3")]);
    expect(store.list().map((i) => i.id)).toEqual(["3"]);
  });

  it("accepts exactly one in_progress", () => {
    const store = new TodoStore();
    expect(store.replace([item("1", "in_progress"), item("2")]).ok).toBe(true);
  });

  it("refuses two in_progress rather than silently demoting one", () => {
    // Repairing it would leave the model believing something it can no longer
    // see — the exact failure the list exists to prevent.
    const store = new TodoStore();
    store.replace([item("keep")]);
    const result = store.replace([item("1", "in_progress"), item("2", "in_progress")]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("only one todo may be in_progress");
    // …and the store is untouched, so both sides still agree.
    expect(store.list().map((i) => i.id)).toEqual(["keep"]);
  });

  it("refuses duplicate ids and empty fields", () => {
    const store = new TodoStore();
    expect(store.replace([item("1"), item("1")]).ok).toBe(false);
    expect(store.replace([{ id: "", text: "x", status: "pending" }]).ok).toBe(false);
    expect(store.replace([{ id: "1", text: "", status: "pending" }]).ok).toBe(false);
  });

  it("treats an empty list as done, with no separate finish call to forget", () => {
    const store = new TodoStore();
    store.replace([item("1")]);
    expect(store.replace([]).ok).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("announces every accepted change and no rejected one", () => {
    const onChange = vi.fn();
    const store = new TodoStore(onChange);
    store.replace([item("1")]);
    expect(onChange).toHaveBeenCalledTimes(1);
    store.replace([item("1", "in_progress"), item("2", "in_progress")]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("hands out copies, so a caller cannot mutate the store through them", () => {
    const store = new TodoStore();
    store.replace([item("1")]);
    const taken = store.list();
    (taken[0] as { text: string }).text = "tampered";
    expect(store.list()[0]?.text).toBe("do 1");
  });

  it("summarises what a status line needs", () => {
    const store = new TodoStore();
    store.replace([item("1", "done"), item("2", "in_progress"), item("3")]);
    expect(store.summary()).toMatchObject({ done: 1, total: 3 });
    expect(store.summary().current?.id).toBe("2");
  });
});

describe("formatTodos", () => {
  it("marks each state distinctly", () => {
    const out = formatTodos([item("1", "done"), item("2", "in_progress"), item("3")]);
    expect(out.split("\n")).toHaveLength(3);
    expect(new Set(out.split("\n").map((l) => l[0])).size).toBe(3);
  });

  it("says so when there is nothing", () => {
    expect(formatTodos([])).toBe("(no todos)");
  });
});
