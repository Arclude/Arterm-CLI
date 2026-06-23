import { describe, expect, it, vi } from "vitest";
import { createSpawnParallelTool, createSpawnTool } from "./spawn.js";

describe("createSpawnTool", () => {
  it("is an ask/execute tool named spawn with a task param", () => {
    const tool = createSpawnTool(async () => "");
    expect(tool.name).toBe("spawn");
    expect(tool.permission).toBe("ask");
    expect(tool.category).toBe("execute");
    expect((tool.parameters as { required: string[] }).required).toEqual(["task"]);
  });

  it("calls the spawn fn with task + role and returns its output", async () => {
    const spawn = vi.fn().mockResolvedValue("reviewed: 2 issues");
    const tool = createSpawnTool(spawn);
    const res = await tool.execute({ task: "review x", role: "reviewer" }, { cwd: "." });
    expect(spawn).toHaveBeenCalledWith("review x", "reviewer");
    expect(res.output).toBe("reviewed: 2 issues");
    expect(res.isError).toBeFalsy();
  });

  it("returns an error result when the sub-agent throws", async () => {
    const tool = createSpawnTool(async () => {
      throw new Error("boom");
    });
    const res = await tool.execute({ task: "x" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("boom");
  });
});

describe("createSpawnParallelTool", () => {
  it("passes the task array through and combines the results", async () => {
    const fleet = vi.fn().mockResolvedValue([
      { task: "review a", output: "a ok" },
      { task: "review b", output: "b ok" },
    ]);
    const tool = createSpawnParallelTool(fleet);
    expect(tool.name).toBe("spawn_parallel");
    const res = await tool.execute(
      { tasks: [{ task: "review a", role: "reviewer" }, { task: "review b" }] },
      { cwd: "." },
    );
    expect(fleet).toHaveBeenCalledWith([
      { task: "review a", role: "reviewer" },
      { task: "review b", role: undefined },
    ]);
    expect(res.output).toContain("review a");
    expect(res.output).toContain("a ok");
    expect(res.output).toContain("b ok");
  });

  it("errors on a missing or empty tasks array", async () => {
    const tool = createSpawnParallelTool(async () => []);
    expect((await tool.execute({}, { cwd: "." })).isError).toBe(true);
    expect((await tool.execute({ tasks: [] }, { cwd: "." })).isError).toBe(true);
    expect((await tool.execute({ tasks: [{ notask: 1 }] }, { cwd: "." })).isError).toBe(true);
  });
});
