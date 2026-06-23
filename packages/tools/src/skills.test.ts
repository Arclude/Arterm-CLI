import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillRegistry, parseSkill, skillsPromptSection } from "./skills.js";

describe("parseSkill", () => {
  it("reads name and description from frontmatter", () => {
    const skill = parseSkill(
      "file.md",
      "---\nname: my-skill\ndescription: does a thing\n---\nbody here",
    );
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("does a thing");
    expect(skill.body).toBe("body here");
  });

  it("defaults name to the filename and uses the whole file as body when no frontmatter", () => {
    const skill = parseSkill("review.md", "just instructions\nmore lines");
    expect(skill.name).toBe("review");
    expect(skill.description).toBe("");
    expect(skill.body).toBe("just instructions\nmore lines");
  });

  it("strips surrounding quotes from values", () => {
    const skill = parseSkill("q.md", `---\nname: "quoted"\ndescription: 'single'\n---\nx`);
    expect(skill.name).toBe("quoted");
    expect(skill.description).toBe("single");
  });

  it("extracts a multi-line body after the closing delimiter", () => {
    const skill = parseSkill("m.md", "---\nname: m\n---\nline one\nline two\n");
    expect(skill.body).toBe("line one\nline two");
  });

  it("falls back to the filename when frontmatter name is empty", () => {
    const skill = parseSkill("named.md", "---\ndescription: d\n---\nbody");
    expect(skill.name).toBe("named");
    expect(skill.description).toBe("d");
  });
});

describe("SkillRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-skills-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads markdown skills and lists them sorted by name", async () => {
    await fs.writeFile(
      join(dir, "beta.md"),
      "---\nname: beta\ndescription: second\n---\nbeta body",
    );
    await fs.writeFile(
      join(dir, "alpha.md"),
      "---\nname: alpha\ndescription: first\n---\nalpha body",
    );
    const registry = new SkillRegistry(dir);
    await registry.load();

    expect(registry.size).toBe(2);
    expect(registry.list()).toEqual([
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ]);
    expect(registry.get("alpha")?.body).toBe("alpha body");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("ignores non-markdown files", async () => {
    await fs.writeFile(join(dir, "skill.md"), "---\nname: s\n---\nbody");
    await fs.writeFile(join(dir, "notes.txt"), "ignore me");
    const registry = new SkillRegistry(dir);
    await registry.load();
    expect(registry.size).toBe(1);
    expect(registry.get("s")).toBeDefined();
  });

  it("yields no skills for a missing directory", async () => {
    const registry = new SkillRegistry(join(dir, "does-not-exist"));
    await registry.load();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

describe("skillsPromptSection", () => {
  it("returns an empty string when there are no skills", () => {
    expect(skillsPromptSection([])).toBe("");
  });

  it("lists skill names and descriptions", () => {
    const section = skillsPromptSection([
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ]);
    expect(section).toContain("alpha");
    expect(section).toContain("beta");
    expect(section).toContain("/skill <name>");
  });
});
