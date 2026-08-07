import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, planPath } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanTool } from "./plan.js";

let home: string;
let tool: ReturnType<typeof createPlanTool>;
const ctx = () => ({ cwd: process.cwd() });

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "arterm-plantool-"));
  tool = createPlanTool(new PlanStore(planPath("s1", home)));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("the plan tool", () => {
  it("defaults to reading", async () => {
    const res = await tool.execute({}, ctx());
    expect(res.output).toContain("no plan");
    expect(res.isError).toBeFalsy();
  });

  it("writes and reads back", async () => {
    await tool.execute({ action: "set", title: "port the parser", body: "move it to core" }, ctx());
    const res = await tool.execute({ action: "get" }, ctx());
    expect(res.output).toContain("port the parser");
    expect(res.output).toContain("move it to core");
  });

  it("reports the plan's age, because an old plan reads differently", async () => {
    await tool.execute({ action: "set", title: "t", body: "b" }, ctx());
    const res = await tool.execute({ action: "get" }, ctx());
    expect(res.output).toMatch(/written (just now|\d+[mhd] ago)/);
  });

  it("insists on both halves of a plan", async () => {
    expect((await tool.execute({ action: "set", title: "only a title" }, ctx())).isError).toBe(
      true,
    );
    expect((await tool.execute({ action: "set", body: "only a body" }, ctx())).isError).toBe(true);
  });

  it("clears", async () => {
    await tool.execute({ action: "set", title: "t", body: "b" }, ctx());
    await tool.execute({ action: "clear" }, ctx());
    expect((await tool.execute({}, ctx())).output).toContain("no plan");
  });

  it("rejects an action it does not have instead of guessing", async () => {
    const res = await tool.execute({ action: "append" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unknown action");
  });

  it("writes into the agent's own directory, so it needs no prompt", async () => {
    // It touches a file — which the permission inspector should say — but the
    // file is the run's own notes, not the user's project.
    expect(tool.permission).toBe("allow");
    expect(tool.mutating).toBe(true);
  });
});
