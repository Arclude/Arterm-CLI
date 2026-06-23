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
