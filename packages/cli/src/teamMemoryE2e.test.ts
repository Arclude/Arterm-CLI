/**
 * Real-model end-to-end test for per-member memory across team rounds.
 *
 * The sibling teamE2e test proves /team itself but cannot prove this feature: its
 * goal completes in a single round, and memory only exists to cross a round boundary
 * (a note to your next round is worthless when there is no next round — real members
 * correctly never call `memo` there). Two conditions have to hold before a member can
 * ever read its own memory, and the goal below is built to produce both:
 *
 *  1. the run reaches round 2 — hence the explicitly staged goal; and
 *  2. the SAME member runs in both rounds — hence per-file ownership. A staged goal
 *     alone is not enough: a leader handed "audit, then fix" will happily give the
 *     audit to one member and the fix to another, and then no member ever re-reads
 *     anything. Ownership is what makes a member outlive its own round.
 *
 * The load-bearing assertion is the engine-side guarantee rather than model goodwill:
 * every successful member's output is recapped automatically, so a returning member's
 * task MUST carry the recall prefix. Whether it also calls `memo` is the model's
 * choice, so that is reported, and only its wire shape is asserted.
 *
 * Note the observation point: the `team_round` event carries the leader's RAW
 * assignment (`a.task`), never the recall/brief-prefixed text. Only the task handed
 * to the fleet is prefixed, and `subagent_start` is what carries it.
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

/** The marker MemberMemory.recall() puts at the head of an injected digest. */
const RECALL_MARKER = "[Your private memory";

describe.skipIf(!enabled)("team member memory e2e (real model)", () => {
  it(
    "hands a returning member its own history from the previous round",
    { timeout: 540_000 },
    async () => {
      const repo = await fs.mkdtemp(join(tmpdir(), "arterm-team-memory-e2e-"));
      await run("git", ["init"], { cwd: repo });
      await run("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
      await run("git", ["config", "user.name", "E2E"], { cwd: repo });

      // Two files, one per member, each seeded with a real defect: div() ignores
      // divide-by-zero, avg() is wrong for an empty list. Two files is what lets the
      // leader hand each member a lasting piece of territory instead of a one-off job.
      await fs.writeFile(
        join(repo, "math.js"),
        ["export function div(a, b) {", "  return a / b;", "}", ""].join("\n"),
      );
      await fs.writeFile(
        join(repo, "stats.js"),
        [
          "export function avg(xs) {",
          "  return xs.reduce((a, b) => a + b, 0) / xs.length;",
          "}",
          "",
        ].join("\n"),
      );
      const agentsDir = join(repo, ".arterm", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(
        join(agentsDir, "auditor.md"),
        "---\nname: auditor\ndescription: audits one source file for defects and later fixes it\ntools: read, ls, glob, grep, write, edit, multi_edit\n---\n" +
          "You audit code carefully and fix what you find. Verify claims against the code.\n",
      );
      await run("git", ["add", "-A"], { cwd: repo });
      await run("git", ["commit", "-m", "seed"], { cwd: repo });

      const loader = new AgentDefLoader(agentsDir, join(repo, "no-global"));
      registerAgentDefinitions(await loader.load());

      const config = await loadConfig();
      config.mode = "yolo";
      config.memory = { ...config.memory, mode: "off" };
      config.session = { mode: "off" };
      config.autonomy = { ...config.autonomy, maxSteps: 6 };
      // maxRounds 3 leaves headroom for the staged goal below to need a 2nd round.
      config.team = { ...config.team, fanout: 2, maxRounds: 3, memory: true };

      const { session } = await buildSession({ config, cwd: repo, yolo: true });
      session.setAsker(async () => "allow");

      const events: AgentEvent[] = [];
      session.bus.on((e) => {
        if (e.type === "text_delta") return;
        events.push(e);
        if (e.type === "team_memory") console.log(`[e2e] ${JSON.stringify(e).slice(0, 300)}`);
      });

      expect(session.autonomy.setMode("team")).toBe(true);
      await session.autonomy.start(
        "This repo has two files: math.js and stats.js. Assign each team member ONE file " +
          "to own for the WHOLE run — the member who audits a file in stage 1 is the same " +
          "member who fixes that same file in stage 2. Never reassign a file to a different " +
          "member. Run the stages in separate rounds, never both in one round. " +
          "STAGE 1 (this round): each member reads ONLY its own file, decides exactly which " +
          "edge cases are mishandled and how to fix them, and records that decision for " +
          "itself using the `memo` tool. Change NO files in stage 1. " +
          "STAGE 2 (a later round): each member implements, in its own file, the fixes it " +
          "decided in stage 1. The goal is NOT complete until both files are actually fixed.",
      );

      // subagent_start carries the task as handed to the member — prefixed with recall
      // and the board brief. team_round would NOT: it reports the leader's raw text.
      const started = events.flatMap((e) =>
        e.type === "subagent_start" && e.role ? [{ role: e.role, task: e.task }] : [],
      );
      const rounds = events.filter((e) => e.type === "team_round").length;
      console.log(`[e2e] rounds: ${rounds}, member runs: ${started.length}`);
      for (const s of started) {
        console.log(`[e2e]   ${s.role} — recall=${s.task.includes(RECALL_MARKER)}`);
      }

      expect(rounds).toBeGreaterThanOrEqual(2);

      // A member that ran before must come back carrying its own history. Anything it
      // ran before is the precondition — without a repeat, memory is unreachable and
      // every assertion past here would be vacuously true.
      const seen = new Set<string>();
      const returning: { role: string; task: string }[] = [];
      for (const s of started) {
        if (seen.has(s.role)) returning.push(s);
        seen.add(s.role);
      }
      console.log(`[e2e] returning member runs: ${returning.length}`);
      expect(returning.length).toBeGreaterThan(0);
      for (const r of returning) {
        expect(r.task).toContain(RECALL_MARKER);
      }

      // A member's first run has no history to hand back, so it must NOT be prefixed.
      const firstRuns = started.filter((s) => !returning.includes(s));
      expect(firstRuns.every((s) => !s.task.includes(RECALL_MARKER))).toBe(true);

      // Notes are the model's choice even when the goal asks for them, so report the
      // count and assert only the wire shape the desktop parses (contract §6).
      const notes = events.flatMap((e) => (e.type === "team_memory" ? [e] : []));
      console.log(`[e2e] team_memory events: ${notes.length}`);
      for (const n of notes) {
        expect(n.kind).toBe("note");
        expect(n.text.length).toBeGreaterThan(0);
        expect(n.round).toBeGreaterThanOrEqual(1);
        expect(n.member.length).toBeGreaterThan(0);
        expect(n.memberName.length).toBeGreaterThan(0);
      }

      // The engine recaps every member every round; if those recaps were also put on
      // the wire, this count would run ahead of the deliberate `memo` calls.
      const memoCalls = events.filter(
        (e) =>
          e.type === "team_member_event" &&
          e.event.type === "tool_call" &&
          e.event.call.name === "memo",
      ).length;
      console.log(`[e2e] memo calls: ${memoCalls}, team_memory events: ${notes.length}`);
      expect(notes.length).toBe(memoCalls);

      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    },
  );
});
