import { describe, expect, it } from "vitest";
import { PermissionManager } from "./permissions.js";
import { availableRoles, roleInstruction, runFleet, runSubagent } from "./subagent.js";
import type { ChatProvider, Tool } from "./types.js";

/** Stub provider that immediately calls task_done with a fixed summary. */
function doneProvider(summary: string): ChatProvider {
  return {
    id: "stub",
    supportsNativeTools: () => true,
    listModels: async () => [],
    async *chat() {
      yield {
        type: "tool_call",
        call: { id: "1", name: "task_done", arguments: { summary } },
      };
      yield { type: "done" };
    },
  };
}

const taskDone: Tool = {
  name: "task_done",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "done" }),
};

describe("roles", () => {
  it("lists the preset roles", () => {
    expect(availableRoles()).toEqual([
      "reviewer",
      "researcher",
      "tester",
      "implementer",
      "explorer",
    ]);
  });

  it("returns an instruction for a known role, undefined otherwise", () => {
    expect(roleInstruction("reviewer")).toContain("code reviewer");
    expect(roleInstruction("nope")).toBeUndefined();
    expect(roleInstruction(undefined)).toBeUndefined();
  });
});

describe("runSubagent", () => {
  it("runs a sub-agent to completion and returns the task_done summary", async () => {
    // Stub provider: first turn calls task_done, then ends.
    let call = 0;
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        call += 1;
        if (call === 1) {
          yield {
            type: "tool_call",
            call: { id: "1", name: "task_done", arguments: { summary: "fixed the bug" } },
          };
        }
        yield { type: "done" };
      },
    };

    const output = await runSubagent("fix the bug", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 5,
    });

    expect(output).toBe("fixed the bug");
  });

  it("prepends a role instruction to the task prompt", async () => {
    let seenPrompt = "";
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat(req) {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user") seenPrompt = last.content;
        yield {
          type: "tool_call",
          call: { id: "1", name: "task_done", arguments: { summary: "ok" } },
        };
        yield { type: "done" };
      },
    };

    await runSubagent("review auth.ts", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      role: "reviewer",
      maxSteps: 3,
    });

    expect(seenPrompt).toContain("code reviewer");
    expect(seenPrompt).toContain("review auth.ts");
  });
});

describe("runFleet", () => {
  const base = {
    provider: doneProvider("completed"),
    model: "x",
    tools: [] as Tool[],
    permissions: new PermissionManager({}, "yolo" as const),
    ask: async () => "deny" as const,
    cwd: process.cwd(),
    taskDone,
    maxSteps: 3,
  };

  it("runs tasks concurrently and returns results in input order", async () => {
    const results = await runFleet([{ task: "A" }, { task: "B" }, { task: "C" }], {
      ...base,
      concurrency: 2,
    });
    expect(results.map((r) => r.task)).toEqual(["A", "B", "C"]);
    expect(results.every((r) => r.output === "completed")).toBe(true);
  });

  it("invokes onStart/onDone once per task", async () => {
    const starts: number[] = [];
    const dones: number[] = [];
    await runFleet([{ task: "A" }, { task: "B" }], {
      ...base,
      onStart: (i) => starts.push(i),
      onDone: (i) => dones.push(i),
    });
    expect(starts.sort()).toEqual([0, 1]);
    expect(dones.sort()).toEqual([0, 1]);
  });
});
