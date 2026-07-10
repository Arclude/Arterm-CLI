/**
 * Agent definitions: user-authored specialist sub-agents loaded from markdown
 * files (`.arterm/agents/*.md` in the project, `~/.arterm/agents/*.md` globally).
 * The loader lives in `@arterm/tools` (it does the directory scan); this
 * module-level registry is how the definitions reach the core engines — the
 * autonomy/team loops and `roleInstruction()` consult it by name.
 */

/** One specialist agent definition (file-backed, or synthesized ad-hoc by the leader). */
export interface AgentDefinition {
  /** Lowercase identity — what the leader references in its plans. */
  name: string;
  /** One-line specialty summary the leader uses to pick members. */
  description: string;
  /** The member's working instructions (markdown body) — becomes its system prompt. */
  instruction: string;
  /** Optional tool-name allowlist from frontmatter (`tools: read, grep, edit`). */
  tools?: string[];
  source: "project" | "global" | "adhoc";
}

/** Listing shape for the /agents view and the Session surface. */
export interface AgentDefSummary {
  name: string;
  description: string;
  source: "project" | "global" | "adhoc";
  tools?: string[];
}

const registry = new Map<string, AgentDefinition>();

/** Replace the current definition set (called on startup and /plugins reload). */
export function registerAgentDefinitions(defs: AgentDefinition[]): void {
  registry.clear();
  for (const def of defs) registry.set(def.name.toLowerCase(), def);
}

export function listAgentDefinitions(): AgentDefinition[] {
  return [...registry.values()];
}

export function getAgentDefinition(name: string): AgentDefinition | undefined {
  return registry.get(name.toLowerCase());
}
