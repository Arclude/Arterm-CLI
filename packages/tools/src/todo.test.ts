import { TodoStore } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { createTodoTool } from "./todo.js";

const ctx = () => ({ cwd: process.cwd() });

describe("the todo tool", () => {
  it("never asks a human to approve a plan", async () => {
    // A confirmation prompt would make the list expensive enough that the
    // model stops keeping one — which is the failure this exists to fix.
    const tool = createTodoTool(new TodoStore());
    expect(tool.permission).toBe("allow");
    expect(tool.mutating).toBe(false);
  });

  it("writes the list and echoes it back", async () => {
    // Echoed rather than counted: the model's next turn may be on the far side
    // of a compaction, and this result is what it will see.
    const store = new TodoStore();
    const res = await createTodoTool(store).execute(
      {
        todos: [
          { id: "1", text: "read the parser", status: "done" },
          { id: "2", text: "port it", status: "in_progress" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("1/2 done");
    expect(res.output).toContain("port it");
    expect(store.list()).toHaveLength(2);
  });

  it("passes the store's refusal through with its reason", async () => {
    const res = await createTodoTool(new TodoStore()).execute(
      {
        todos: [
          { id: "1", text: "a", status: "in_progress" },
          { id: "2", text: "b", status: "in_progress" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("only one todo may be in_progress");
  });

  it("rejects an unknown status instead of guessing", async () => {
    const res = await createTodoTool(new TodoStore()).execute(
      { todos: [{ id: "1", text: "a", status: "blocked" }] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown status");
  });

  it("clears on an empty list", async () => {
    const store = new TodoStore();
    const tool = createTodoTool(store);
    await tool.execute({ todos: [{ id: "1", text: "a", status: "pending" }] }, ctx());
    const res = await tool.execute({ todos: [] }, ctx());
    expect(res.output).toContain("cleared");
    expect(store.list()).toEqual([]);
  });

  it("insists on an array — a partial write would be a partial plan", async () => {
    const res = await createTodoTool(new TodoStore()).execute({ todos: "1. do it" }, ctx());
    expect(res.isError).toBe(true);
  });
});
