import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDefLoader, agentDefDirs, parseAgentDef } from "./agentDefs.js";

describe("parseAgentDef", () => {
  it("reads name, description, and a comma-separated tools allowlist", () => {
    const def = parseAgentDef(
      "file.md",
      "---\nname: Code-Auditor\ndescription: audits code\ntools: read, grep, symbols\n---\nAudit carefully.",
      "project",
    );
    expect(def?.name).toBe("code-auditor");
    expect(def?.description).toBe("audits code");
    expect(def?.tools).toEqual(["read", "grep", "symbols"]);
    expect(def?.instruction).toBe("Audit carefully.");
    expect(def?.source).toBe("project");
  });

  it("defaults name to the filename and body to the whole file", () => {
    const def = parseAgentDef("reviewer.md", "Review everything twice.", "global");
    expect(def?.name).toBe("reviewer");
    expect(def?.tools).toBeUndefined();
    expect(def?.instruction).toBe("Review everything twice.");
  });

  it("rejects a definition with an empty body", () => {
    expect(
      parseAgentDef("empty.md", "---\nname: x\ndescription: d\n---\n", "project"),
    ).toBeUndefined();
    expect(parseAgentDef("blank.md", "   \n", "project")).toBeUndefined();
  });

  it("strips quotes and ignores an empty tools list", () => {
    const def = parseAgentDef("q.md", `---\nname: "quoted"\ntools:\n---\nbody`, "project");
    expect(def?.name).toBe("quoted");
    expect(def?.tools).toBeUndefined();
  });
});

describe("AgentDefLoader", () => {
  let root: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "arterm-agentdefs-"));
    projectDir = join(root, "project", ".arterm", "agents");
    globalDir = join(root, "global", "agents");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("loads from both dirs; project wins on a name collision", async () => {
    await fs.writeFile(join(globalDir, "reviewer.md"), "GLOBAL brief");
    await fs.writeFile(join(globalDir, "tester.md"), "Run the tests.");
    await fs.writeFile(
      join(projectDir, "reviewer.md"),
      "---\ndescription: project reviewer\n---\nPROJECT brief",
    );

    const loader = new AgentDefLoader(projectDir, globalDir);
    const defs = await loader.load();

    expect(defs).toHaveLength(2);
    const reviewer = defs.find((d) => d.name === "reviewer");
    expect(reviewer?.instruction).toBe("PROJECT brief");
    expect(reviewer?.source).toBe("project");
    expect(defs.find((d) => d.name === "tester")?.source).toBe("global");
  });

  it("missing directories yield an empty set without throwing", async () => {
    const loader = new AgentDefLoader(join(root, "nope-a"), join(root, "nope-b"));
    expect(await loader.load()).toEqual([]);
    expect(loader.summary).toEqual([]);
  });

  it("skips non-markdown files and unreadable/empty definitions", async () => {
    await fs.writeFile(join(projectDir, "notes.txt"), "not a def");
    await fs.writeFile(join(projectDir, "empty.md"), "");
    await fs.writeFile(join(projectDir, "ok.md"), "A real brief");

    const loader = new AgentDefLoader(projectDir, globalDir);
    const defs = await loader.load();
    expect(defs.map((d) => d.name)).toEqual(["ok"]);
  });

  it("summary is sorted by name and carries source + tools", async () => {
    await fs.writeFile(join(projectDir, "zeta.md"), "---\ntools: read\n---\nz");
    await fs.writeFile(join(projectDir, "alpha.md"), "---\ndescription: first\n---\na");

    const loader = new AgentDefLoader(projectDir, globalDir);
    await loader.load();
    expect(loader.summary.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(loader.summary[1]?.tools).toEqual(["read"]);
  });
});

describe("agentDefDirs", () => {
  it("builds the conventional project and global paths", () => {
    const dirs = agentDefDirs("/work/repo", "/home/u/.arterm");
    expect(dirs.project).toContain(join(".arterm", "agents"));
    expect(dirs.global).toContain(join("agents"));
  });
});
