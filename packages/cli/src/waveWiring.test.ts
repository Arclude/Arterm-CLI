import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

/**
 * Every tool the session ADDS at runtime is invisible to `defaultTools()`, so
 * no test in @arterm/tools can tell whether it was registered and
 * `permissions list` cannot show it. A tool that is never handed to the agent
 * is indistinguishable from one that was never written — this is the only place
 * that difference is observable.
 */
describe("the session's full roster", () => {
  const cwd = mkdtempSync(join(tmpdir(), "arterm-roster-"));

  it("carries every runtime-added tool from waves 3 through 11", async () => {
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const names = new Set(session.agent.tools.map((t) => t.name));
    const expected = [
      // waves 3-4
      "todo",
      "plan",
      "task",
      // wave 7 — the model-driven fleet
      "spawn",
      "spawn_parallel",
      "spawn_subagent",
      "assign_task",
      "await_tasks",
      "ask_subagent",
      "roll_up",
      "fleet",
      // wave 9
      "exec",
      // wave 10
      "llm",
      "tool_help",
      "tool_use",
      "batch",
      "set_working_dir",
      // wave 11
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_screenshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_select",
      "browser_drag",
      "browser_upload",
      "browser_evaluate",
      "browser_wait",
      "browser_list",
      "browser_status",
      "browser_close",
    ];
    for (const name of expected) expect(names, `${name} was never registered`).toContain(name);
  });

  it("gives a sub-agent none of the fleet family", async () => {
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const { subagentRoster } = await import("@arterm/core");
    const worker = new Set(subagentRoster(session.agent.tools).map((t) => t.name));
    for (const name of ["spawn", "spawn_subagent", "assign_task", "fleet"]) {
      expect(worker, `${name} leaked into a worker`).not.toContain(name);
    }
  });

  it("keeps browser_evaluate gated — it runs arbitrary JS in the page", async () => {
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const evaluate = session.agent.tools.find((t) => t.name === "browser_evaluate");
    expect(evaluate?.permission).toBe("ask");
    expect(evaluate?.riskTier).toBe("destructive");
  });
});
