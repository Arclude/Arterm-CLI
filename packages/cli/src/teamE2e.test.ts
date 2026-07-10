/**
 * Real-model end-to-end test for /team: builds the actual session (user config,
 * stored provider key), runs a small team goal in a scratch git repo, and checks
 * that the roster forms, members run, and worktree patches land on the main tree.
 *
 * Gated behind ARTERM_TEAM_E2E=1 — it spends real tokens and needs a reachable
 * provider, so it never runs in CI or a plain `pnpm test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentEvent, loadConfig, registerAgentDefinitions } from "@arterm/core";
import { AgentDefLoader } from "@arterm/tools";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

const run = promisify(execFile);
const enabled = process.env.ARTERM_TEAM_E2E === "1";

describe.skipIf(!enabled)("team mode e2e (real model)", () => {
  it(
    "assembles a team, runs members in worktrees, and applies patches to the main tree",
    { timeout: 540_000 },
    async () => {
      // Scratch repo: a tiny library plus a project agent definition, all committed
      // so `git status` afterwards shows ONLY what team members changed.
      const repo = await fs.mkdtemp(join(tmpdir(), "arterm-team-e2e-"));
      await run("git", ["init"], { cwd: repo });
      await run("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
      await run("git", ["config", "user.name", "E2E"], { cwd: repo });
      await fs.writeFile(
        join(repo, "util.js"),
        "export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
      );
      const agentsDir = join(repo, ".arterm", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(
        join(agentsDir, "doc-writer.md"),
        "---\nname: doc-writer\ndescription: writes README and documentation files\ntools: read, ls, glob, grep, write, edit\n---\nYou write concise, accurate documentation. Verify claims against the code first.\n",
      );
      await run("git", ["add", "-A"], { cwd: repo });
      await run("git", ["commit", "-m", "seed"], { cwd: repo });

      // Mirror main.ts startup: load definitions into the core registry.
      const loader = new AgentDefLoader(agentsDir, join(repo, "no-global"));
      registerAgentDefinitions(await loader.load());

      const config = await loadConfig();
      config.mode = "yolo";
      config.memory = { ...config.memory, mode: "off" };
      config.session = { mode: "off" };
      config.autonomy = { ...config.autonomy, maxSteps: 6 };
      config.team = { ...config.team, fanout: 2, maxRounds: 2 };

      const { session } = await buildSession({ config, cwd: repo, yolo: true });
      session.setAsker(async () => "allow");

      const events: AgentEvent[] = [];
      session.bus.on((e) => {
        if (e.type === "text_delta") return;
        events.push(e);
        if (
          e.type.startsWith("team_") ||
          e.type === "fleet_worktree" ||
          e.type === "subagent_start" ||
          e.type === "autonomy_done" ||
          e.type === "autonomy_stopped" ||
          e.type === "error"
        ) {
          console.log(`[e2e] ${JSON.stringify(e).slice(0, 240)}`);
        }
      });

      expect(session.autonomy.setMode("team")).toBe(true);
      await session.autonomy.start(
        "Create a README.md documenting this tiny math library, and add JSDoc comments " +
          "to both functions in util.js. Keep the changes small and focused.",
      );

      const types = events.map((e) => e.type);
      expect(types).toContain("team_plan");
      expect(types).toContain("team_round");
      expect(types).toContain("team_member_state");
      expect(types).toContain("team_done");
      expect(["done", "stopped"]).toContain(session.autonomy.state);

      // Members completed rather than failed.
      const states = events.filter((e) => e.type === "team_member_state");
      expect(states.some((s) => s.type === "team_member_state" && s.state === "done")).toBe(true);

      // Worktree patches were auto-applied: the MAIN tree actually changed.
      const { stdout } = await run("git", ["status", "--porcelain"], { cwd: repo });
      console.log(`[e2e] main-tree changes:\n${stdout}`);
      expect(stdout.trim().length).toBeGreaterThan(0);

      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    },
  );
});
