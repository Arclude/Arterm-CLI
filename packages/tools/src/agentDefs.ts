/**
 * Agent definition files: user-authored specialist sub-agents as markdown with
 * optional `---`-delimited frontmatter (`name`, `description`, `tools`), the body
 * being the member's instructions/system prompt. Loaded from the project's
 * `.arterm/agents/` and the global `~/.arterm/agents/` — project wins on a name
 * collision. Parsing is dependency-free, mirroring `skills.ts`.
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { AgentDefSummary, AgentDefinition } from "@arterm/core";

/** Strip one layer of matching surrounding single or double quotes. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse a markdown agent-definition file. `name` defaults to the filename without
 * `.md` (normalized to lowercase — the leader references members by this name);
 * `tools` is a comma-separated allowlist of tool names. Returns undefined when the
 * body is empty (a definition without instructions can't drive a member).
 */
export function parseAgentDef(
  filename: string,
  raw: string,
  source: "project" | "global",
): AgentDefinition | undefined {
  const fallbackName = filename.replace(/\.md$/i, "");
  const lines = raw.split(/\r?\n/);

  let name = fallbackName;
  let description = "";
  let tools: string[] | undefined;
  let body = raw.trim();

  if (lines[0] === "---") {
    let closing = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        closing = i;
        break;
      }
    }
    if (closing !== -1) {
      for (let i = 1; i < closing; i++) {
        const line = lines[i] ?? "";
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim();
        const value = stripQuotes(line.slice(sep + 1).trim());
        if (key === "name") {
          if (value) name = value;
        } else if (key === "description") {
          description = value;
        } else if (key === "tools") {
          const list = value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          if (list.length > 0) tools = list;
        }
      }
      body = lines
        .slice(closing + 1)
        .join("\n")
        .trim();
    }
  }

  if (!body) return undefined;
  return { name: name.toLowerCase(), description, instruction: body, tools, source };
}

/**
 * Loads agent definitions from the project and global directories. Missing
 * directories yield nothing and per-file failures are skipped — loading never
 * throws (the PluginLoader convention).
 */
export class AgentDefLoader {
  private readonly defs = new Map<string, AgentDefinition>();

  constructor(
    private readonly projectDir: string,
    private readonly globalDir: string,
  ) {}

  /** Read both directories; global first so project definitions win on collision. */
  async load(): Promise<AgentDefinition[]> {
    this.defs.clear();
    await this.loadDir(this.globalDir, "global");
    await this.loadDir(this.projectDir, "project");
    return this.all();
  }

  private async loadDir(dir: string, source: "project" | "global"): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      let raw: string;
      try {
        raw = await fs.readFile(join(dir, entry), "utf8");
      } catch {
        continue;
      }
      const def = parseAgentDef(basename(entry), raw, source);
      if (def) this.defs.set(def.name, def);
    }
  }

  all(): AgentDefinition[] {
    return [...this.defs.values()];
  }

  /** Name/description/source rows for the /agents view, sorted by name. */
  get summary(): AgentDefSummary[] {
    return this.all()
      .map(({ name, description, source, tools }) => ({ name, description, source, tools }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** The conventional agent-definition directories for a working directory. */
export function agentDefDirs(cwd: string, artermHome: string): { project: string; global: string } {
  return { project: join(cwd, ".arterm", "agents"), global: join(artermHome, "agents") };
}
