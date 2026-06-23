import { describe, expect, it, vi } from "vitest";
import { createSpawnTool } from "./spawn.js";

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
