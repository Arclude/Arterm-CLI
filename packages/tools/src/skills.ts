/**
 * Skills: reusable prompt-based capabilities stored as markdown files with
 * optional `---`-delimited frontmatter. The registry loads `*.md` files from a
 * directory and surfaces them to the agent (system prompt) and the `/skill`
 * command. Parsing is dependency-free — a tiny frontmatter reader lives here.
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { SkillInfo } from "@arterm/core";

/** A single skill: its identity plus the prompt body fed to the model. */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

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
 * Parse a markdown skill file. Frontmatter is delimited by lines of exactly
 * `---`; only `name` and `description` keys are read. `name` defaults to the
 * filename without its `.md` extension; `description` defaults to "". `body` is
 * everything after the closing `---` (trimmed), or the whole file when there is
 * no frontmatter.
 */
export function parseSkill(filename: string, raw: string): Skill {
  const fallbackName = filename.replace(/\.md$/i, "");
  const lines = raw.split(/\r?\n/);

  let name = fallbackName;
  let description = "";
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
        }
      }
      body = lines
        .slice(closing + 1)
        .join("\n")
        .trim();
    }
  }

  return { name, description, body };
}

/** Loads markdown skills from a directory and looks them up by name. */
export class SkillRegistry {
  private readonly dir: string;
  private readonly skills = new Map<string, Skill>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Read every `*.md` file in the directory. A missing dir yields no skills. */
  async load(): Promise<void> {
    this.skills.clear();
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      let raw: string;
      try {
        raw = await fs.readFile(join(this.dir, entry), "utf8");
      } catch {
        continue;
      }
      const skill = parseSkill(basename(entry), raw);
      this.skills.set(skill.name, skill);
    }
  }

  /** Name + description for each skill, sorted by name. */
  list(): SkillInfo[] {
    return [...this.skills.values()]
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The full skill (including its body) for a given name, if loaded. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  get size(): number {
    return this.skills.size;
  }
}

/** Render available skills for the agent's system prompt; "" when there are none. */
export function skillsPromptSection(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return `Available skills (the user can invoke one with /skill <name>):\n${lines.join("\n")}`;
}
