import type { Tool } from "@arterm/core";
import { optionalString, requireString } from "./paths.js";

/** Runs a sub-agent toward `task` (optionally with a role) and resolves its output. */
export type SpawnFn = (task: string, role?: string) => Promise<string>;

/**
 * Builds the `spawn` tool, which delegates a focused sub-task to a fresh
 * sub-agent. The actual sub-agent execution is injected (the session wires it),
 * so this stays decoupled from how agents are constructed. NOT included in the
 * sub-agent's own tool set (delegation is one level deep).
 */
export function createSpawnTool(spawn: SpawnFn): Tool {
  return {
    name: "spawn",
    description:
      "Delegate a focused sub-task to a fresh sub-agent that works autonomously and returns " +
      "its result. Use for independent or parallelizable chunks of work (e.g. 'review file X', " +
      "'research Y'). Optional role: reviewer | researcher | tester | implementer | explorer.",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The sub-task for the sub-agent to complete." },
        role: {
          type: "string",
          description: "Optional role: reviewer, researcher, tester, implementer, or explorer.",
        },
      },
      required: ["task"],
    },
    preview: (args) => `spawn sub-agent: ${String(args.task ?? "").slice(0, 60)}`,
    async execute(args) {
      const task = requireString(args, "task");
      const role = optionalString(args, "role");
      try {
        const output = await spawn(task, role);
        return { output: output || "(sub-agent produced no output)" };
      } catch (err) {
        return { output: `sub-agent failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** Runs several sub-tasks concurrently and resolves their results in order. */
export type FleetFn = (
  tasks: { task: string; role?: string }[],
) => Promise<{ task: string; output: string }[]>;

/**
 * Builds the `spawn_parallel` tool: dispatch several independent sub-tasks to run
 * concurrently and return their combined results. Injected into the main agent
 * only (sub-agents don't fan out further).
 */
export function createSpawnParallelTool(fleet: FleetFn): Tool {
  return {
    name: "spawn_parallel",
    description:
      "Dispatch several INDEPENDENT sub-tasks to sub-agents that run concurrently, then return " +
      "all their results. Use when work fans out across files/items that don't depend on each " +
      "other. Each task may set a role (reviewer | researcher | tester | implementer | explorer).",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Independent sub-tasks to run in parallel.",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              role: { type: "string" },
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },
    preview: (args) =>
      `spawn ${Array.isArray(args.tasks) ? args.tasks.length : 0} sub-agents in parallel`,
    async execute(args) {
      const raw = args.tasks;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { output: "spawn_parallel requires a non-empty 'tasks' array", isError: true };
      }
      const tasks = raw
        .map((t) => {
          const o = t as { task?: unknown; role?: unknown };
          return {
            task: typeof o.task === "string" ? o.task : "",
            role: typeof o.role === "string" ? o.role : undefined,
          };
        })
        .filter((t) => t.task);
      if (tasks.length === 0) {
        return { output: "no valid tasks in 'tasks' array", isError: true };
      }
      try {
        const results = await fleet(tasks);
        const out = results
          .map((r, i) => `### Sub-agent ${i + 1}: ${r.task}\n${r.output}`)
          .join("\n\n");
        return { output: out };
      } catch (err) {
        return { output: `fleet failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
