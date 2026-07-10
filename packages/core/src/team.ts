/**
 * Team-mode helpers: the leader assembles a roster of specialist members (from
 * user agent definitions or ad-hoc specs), then assigns work to them per round.
 * These are pure prompt-builders/parsers — the loop itself lives in
 * `AutonomyEngine.runTeamLoop()` and the per-member wiring in the CLI session.
 */
import type { AgentDefinition } from "./agentRegistry.js";
import { type FleetIsolation, roleInstruction } from "./subagent.js";
import type { Tool } from "./types.js";

/** One materialized team member — the stable entity events are keyed by. */
export interface TeamMember {
  /** Stable id ("m1-reviewer") unique within the run. */
  id: string;
  name: string;
  description: string;
  /** Working instructions: a definition's body (system prompt) or the ad-hoc brief. */
  instruction: string;
  /** True when the leader invented this member (no matching definition file). */
  adhoc: boolean;
  /** Tool-name allowlist carried from the definition's frontmatter. */
  toolNames?: string[];
}

/** One unit of round work: a task assigned to a member. */
export interface TeamAssignment {
  member: TeamMember;
  task: string;
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || "member";
}

function extractArray(raw: string): unknown[] | undefined {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Ask the leader to assemble a team for the goal from the available definitions. */
export function buildRosterPrompt(
  goal: string,
  defs: AgentDefinition[],
  fanout: number,
  steer?: string,
): string {
  const catalog =
    defs.length > 0
      ? `\nAvailable agent definitions (PREFER these when they fit — reference by exact name):\n${defs
          .map((d) => `- ${d.name}${d.description ? ` — ${d.description}` : ""}`)
          .join("\n")}\n`
      : "";
  const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
  const jsonShape = '[{"name": "...", "description": "...", "instruction": "..."}]';
  return `You are the LEADER assembling a small agent TEAM for this GOAL:
"${goal}"
${catalog}
Design up to ${fanout} team members with complementary specialties. Reply with ONLY a JSON array shaped like ${jsonShape}.
For a member that matches an available definition, give just its "name". For a new (ad-hoc) member, give a unique short "name", a one-line "description", and an "instruction" describing how it should work.${steerLine}`;
}

/**
 * Tolerant parse of the leader's roster. Names matching a loaded definition adopt
 * its instruction/tools; unknown names need a non-empty instruction (else they are
 * dropped). An unusable roster falls back to a built-in implementer + reviewer
 * pair so `/team` never hard-fails on sloppy model output.
 */
export function parseRoster(raw: string, defs: AgentDefinition[], fanout: number): TeamMember[] {
  const byName = new Map(defs.map((d) => [d.name.toLowerCase(), d]));
  const out: TeamMember[] = [];
  const seen = new Set<string>();

  for (const item of extractArray(raw) ?? []) {
    if (!item || typeof item !== "object") continue;
    const nameRaw = (item as { name?: unknown }).name;
    if (typeof nameRaw !== "string" || !nameRaw.trim()) continue;
    const name = nameRaw.trim().toLowerCase();
    if (seen.has(name)) continue;

    const def = byName.get(name);
    if (def) {
      out.push({
        id: `m${out.length + 1}-${slug(name)}`,
        name,
        description: def.description,
        instruction: def.instruction,
        adhoc: false,
        toolNames: def.tools,
      });
    } else {
      const instruction = (item as { instruction?: unknown }).instruction;
      if (typeof instruction !== "string" || !instruction.trim()) continue;
      const description = (item as { description?: unknown }).description;
      out.push({
        id: `m${out.length + 1}-${slug(name)}`,
        name,
        description:
          typeof description === "string" && description.trim()
            ? description.trim()
            : instruction.trim().split("\n")[0]?.slice(0, 80) || "",
        instruction: instruction.trim(),
        adhoc: true,
      });
    }
    seen.add(name);
    if (out.length >= fanout) break;
  }

  if (out.length > 0) return out;
  // Degradation for local models that can't produce a usable roster.
  return [
    {
      id: "m1-implementer",
      name: "implementer",
      description: "makes the changes needed for the goal",
      instruction: roleInstruction("implementer") ?? "",
      adhoc: true,
    },
    {
      id: "m2-reviewer",
      name: "reviewer",
      description: "reviews the result for problems",
      instruction: roleInstruction("reviewer") ?? "",
      adhoc: true,
    },
  ];
}

/** Ask the leader to assign the next round of independent tasks to team members. */
export function buildTeamDecomposePrompt(
  goal: string,
  roster: TeamMember[],
  round: number,
  steer: string | undefined,
  fanout: number,
): string {
  const members = roster
    .map((m) => `- ${m.name}${m.description ? ` — ${m.description}` : ""}`)
    .join("\n");
  const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
  const jsonShape = '[{"member": "<name>", "task": "..."}]';
  return `You are the LEADER of an agent TEAM working toward this GOAL:
"${goal}"

Your team:
${members}

Round ${round}. Assign the NEXT chunk of work: up to ${fanout} INDEPENDENT tasks that can run CONCURRENTLY without depending on one another, each assigned to one member by name. When tasks change files, give each member its OWN files — never two members editing the same file.
Reply with ONLY a JSON array shaped like ${jsonShape}. If the GOAL is already complete and nothing remains, reply with exactly [].${steerLine}`;
}

/**
 * Tolerant parse of the round's assignments. A missing/unknown member name falls
 * back to a roster member round-robin (so tasks from a sloppy local model are
 * never silently dropped); an empty/garbage array means "no work proposed".
 */
export function parseAssignments(
  raw: string,
  roster: TeamMember[],
  fanout: number,
): TeamAssignment[] {
  if (roster.length === 0) return [];
  const byName = new Map(roster.map((m) => [m.name.toLowerCase(), m]));
  const out: TeamAssignment[] = [];
  for (const item of extractArray(raw) ?? []) {
    if (!item || typeof item !== "object") continue;
    const task = (item as { task?: unknown }).task;
    if (typeof task !== "string" || !task.trim()) continue;
    const memberRaw = (item as { member?: unknown }).member;
    const member =
      (typeof memberRaw === "string" ? byName.get(memberRaw.trim().toLowerCase()) : undefined) ??
      (roster[out.length % roster.length] as TeamMember);
    out.push({ member, task: task.trim() });
    if (out.length >= fanout) break;
  }
  return out;
}

/**
 * Whether a member needs filesystem isolation: any tool that can mutate state
 * (write/edit/execute) means its work runs in its own git worktree; a purely
 * read-only member can safely share the main cwd.
 */
export function memberIsolation(tools: Tool[]): FleetIsolation {
  return tools.some((t) => t.mutating || (t.category ?? "execute") !== "read")
    ? "worktree"
    : "none";
}
