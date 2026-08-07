import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, taskPath } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskTool } from "./task.js";

let home: string;
let tool: ReturnType<typeof createTaskTool>;
const ctx = () => ({ cwd: process.cwd() });

const graph = [
  { id: "a", title: "read the parser", dependsOn: [] },
  { id: "b", title: "port it", dependsOn: ["a"] },
  { id: "c", title: "write docs", dependsOn: [] },
];

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "arterm-tasktool-"));
  tool = createTaskTool(new TaskStore(taskPath("s1", home)));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("the task tool", () => {
  it("writes a graph and lists it with its edges", async () => {
    const res = await tool.execute({ action: "set", tasks: graph }, ctx());
    expect(res.output).toContain("3 task(s)");
    expect(res.output).toContain("(after a)");
  });

  it("answers what can start now — the reason it is not a second todo list", async () => {
    await tool.execute({ action: "set", tasks: graph }, ctx());
    const res = await tool.execute({ action: "ready" }, ctx());
    expect(res.output).toContain("a:");
    expect(res.output).toContain("c:");
    expect(res.output).not.toContain("b:");
  });

  it("says what a completed task unblocked, without being asked", async () => {
    // Otherwise the model has to ask, and usually does not.
    await tool.execute({ action: "set", tasks: graph }, ctx());
    const res = await tool.execute({ action: "state", id: "a", state: "done" }, ctx());
    expect(res.output).toContain("a → done");
    expect(res.output).toContain("ready now");
    expect(res.output).toContain("port it");
  });

  it("distinguishes 'nothing ready yet' from 'nothing can ever be ready'", async () => {
    await tool.execute({ action: "set", tasks: graph }, ctx());
    await tool.execute({ action: "state", id: "a", state: "failed" }, ctx());
    await tool.execute({ action: "state", id: "c", state: "done" }, ctx());
    const res = await tool.execute({ action: "ready" }, ctx());
    expect(res.output).toContain("blocked by a failed dependency");
    expect(res.output).toContain("port it");
  });

  it("refuses a cyclic graph with the path in the message", async () => {
    const res = await tool.execute(
      {
        action: "set",
        tasks: [
          { id: "a", title: "a", dependsOn: ["b"] },
          { id: "b", title: "b", dependsOn: ["a"] },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("cycle");
  });

  it("rejects a state it does not have, and an id it does not know", async () => {
    await tool.execute({ action: "set", tasks: graph }, ctx());
    expect((await tool.execute({ action: "state", id: "a", state: "wat" }, ctx())).isError).toBe(
      true,
    );
    expect((await tool.execute({ action: "state", id: "zz", state: "done" }, ctx())).isError).toBe(
      true,
    );
  });

  it("defaults to listing, and says plainly when there is nothing", async () => {
    expect((await tool.execute({}, ctx())).output).toBe("(no tasks)");
  });
});
