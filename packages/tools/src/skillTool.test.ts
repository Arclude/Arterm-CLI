import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTool } from "./skillTool.js";
import { SkillRegistry } from "./skills.js";

describe("createSkillTool", () => {
  let dir: string;

  /** A registry over the temp dir, loaded from whatever the test wrote. */
  async function loaded(): Promise<SkillRegistry> {
    const registry = new SkillRegistry(dir);
    await registry.load();
    return registry;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-skill-tool-"));
    await fs.writeFile(
      join(dir, "migrations.md"),
      "---\nname: migrations\ndescription: how we write migrations\n---\nAlways add a down step.",
    );
    await fs.writeFile(
      join(dir, "review.md"),
      "---\nname: Code Review\ndescription: review checklist\n---\nCheck the tests first.",
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is an allow/read tool named skill with no required arguments", async () => {
    const tool = createSkillTool(await loaded());
    expect(tool.name).toBe("skill");
    expect(tool.permission).toBe("allow");
    expect(tool.category).toBe("read");
    expect(tool.mutating).toBe(false);
    expect((tool.parameters as { required?: string[] }).required).toBeUndefined();
    expect(tool.maxOutputBytes).toBeGreaterThan(0);
  });

  it("lists names and descriptions when no name is given", async () => {
    const res = await createSkillTool(await loaded()).execute({}, { cwd: "." });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("Code Review: review checklist");
    expect(res.output).toContain("migrations: how we write migrations");
  });

  it("treats an empty name as a request to list", async () => {
    const res = await createSkillTool(await loaded()).execute({ name: "  " }, { cwd: "." });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("migrations");
  });

  it("returns the body with a header naming the skill", async () => {
    const res = await createSkillTool(await loaded()).execute({ name: "migrations" }, { cwd: "." });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('Skill "migrations" — how we write migrations');
    expect(res.output).toContain("Always add a down step.");
  });

  it("matches a name case-insensitively", async () => {
    const res = await createSkillTool(await loaded()).execute(
      { name: "code review" },
      { cwd: "." },
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("Check the tests first.");
  });

  it("names every available skill when the requested one does not exist", async () => {
    const res = await createSkillTool(await loaded()).execute({ name: "deploy" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain('No skill named "deploy"');
    // The retry has to be possible from this message alone.
    expect(res.output).toContain("migrations");
    expect(res.output).toContain("Code Review");
  });

  it("reports a skill whose file is frontmatter and nothing else", async () => {
    await fs.writeFile(join(dir, "empty.md"), "---\nname: empty\ndescription: nothing\n---\n");
    const res = await createSkillTool(await loaded()).execute({ name: "empty" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("empty body");
  });

  it("says so plainly when no skills are installed at all", async () => {
    const registry = new SkillRegistry(join(dir, "does-not-exist"));
    await registry.load();
    const tool = createSkillTool(registry);

    const list = await tool.execute({}, { cwd: "." });
    expect(list.isError).toBeFalsy();
    expect(list.output).toContain("No skills are installed");

    const missing = await tool.execute({ name: "anything" }, { cwd: "." });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("No skills are installed");
  });
});
