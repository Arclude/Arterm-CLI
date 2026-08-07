import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEVER_SUBAGENT_TOOLS, defaultConfig, subagentRoster } from "@arterm/core";
import { FLEET_TOOL_NAMES } from "@arterm/tools";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

/**
 * The fleet family is added by the SESSION, not by `defaultTools()`, so nothing
 * in `@arterm/tools` can tell whether it was actually registered — and
 * `permissions list` cannot show it either. A tool that exists and is never
 * handed to the agent is indistinguishable from one that was never written.
 */
describe("the model-driven fleet reaches the agent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "arterm-fleet-"));

  it("registers every fleet tool on the session's roster", async () => {
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const names = session.agent.tools.map((t) => t.name);
    for (const name of FLEET_TOOL_NAMES) {
      expect(names, `${name} was never registered`).toContain(name);
    }
  });

  it("keeps the blocking spawn family beside it", async () => {
    // The non-blocking family ADDS a shape; it does not replace the one /team
    // and /sdd dispatch.
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const names = session.agent.tools.map((t) => t.name);
    expect(names).toContain("spawn");
    expect(names).toContain("spawn_parallel");
  });

  it("hands a worker none of them", async () => {
    // A worker holding `spawn_subagent` could build a fleet for free, with
    // nothing above it counting — the reason `spawn` was already excluded.
    const { session } = await buildSession({ config: defaultConfig(), cwd });
    const worker = subagentRoster(session.agent.tools).map((t) => t.name);
    for (const name of FLEET_TOOL_NAMES) {
      expect(worker, `${name} leaked into a worker's roster`).not.toContain(name);
      expect(NEVER_SUBAGENT_TOOLS.has(name)).toBe(true);
    }
  });
});
