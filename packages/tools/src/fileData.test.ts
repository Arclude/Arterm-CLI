import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepMerge, parseQuery } from "./json.js";
import { diffTool, jsonTool, patchTool, replaceTool, treeTool } from "./registry.js";

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-filedata-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string) {
  const abs = join(dir, rel);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
}

describe("treeTool", () => {
  it("shows nesting, marking directories", async () => {
    await write("src/core/agent.ts", "");
    await write("src/main.ts", "");
    const res = await treeTool.execute({}, ctx());
    expect(res.output).toContain("core/");
    expect(res.output).toContain("agent.ts");
    expect(res.output).toContain("main.ts");
  });

  it("stops at the requested depth", async () => {
    await write("a/b/c/deep.ts", "");
    const shallow = await treeTool.execute({ depth: 2 }, ctx());
    expect(shallow.output).not.toContain("deep.ts");
    const deep = await treeTool.execute({ depth: 4 }, ctx());
    expect(deep.output).toContain("deep.ts");
  });

  it("skips what .gitignore ignores, and says `all` when asked", async () => {
    await write(".gitignore", "build\n");
    await write("build/out.js", "");
    await write("src/in.ts", "");
    const clean = await treeTool.execute({}, ctx());
    expect(clean.output).not.toContain("out.js");
    const all = await treeTool.execute({ all: true }, ctx());
    expect(all.output).toContain("out.js");
  });

  it("counts what it did not show instead of ending silently", async () => {
    // A tree that simply stops reads as a project that ends there.
    for (let i = 0; i < 60; i++) await write(`many/f${i}.txt`, "");
    const res = await treeTool.execute({}, ctx());
    expect(res.output).toMatch(/more entr\(ies\)/);
    expect(res.output).toMatch(/not shown/);
  });

  it("refuses to leave the working directory", async () => {
    await expect(treeTool.execute({ path: "../.." }, ctx())).rejects.toThrow(/escapes/);
  });
});

describe("diffTool", () => {
  it("diffs two files as an applicable unified diff", async () => {
    await write("a.txt", "one\ntwo\nthree\n");
    await write("b.txt", "one\nTWO\nthree\n");
    const res = await diffTool.execute({ mode: "files", path: "a.txt", other: "b.txt" }, ctx());
    expect(res.output).toContain("--- a/a.txt");
    expect(res.output).toContain("+++ b/b.txt");
    expect(res.output).toContain("-two");
    expect(res.output).toContain("+TWO");
  });

  it("says so when two files are identical", async () => {
    await write("a.txt", "same\n");
    await write("b.txt", "same\n");
    const res = await diffTool.execute({ mode: "files", path: "a.txt", other: "b.txt" }, ctx());
    expect(res.output).toContain("identical");
  });

  it("`stat` returns the size of the change, not the change", async () => {
    await write("a.txt", `${Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n")}\n`);
    await write("b.txt", `${Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n")}\n`);
    const res = await diffTool.execute(
      { mode: "files", path: "a.txt", other: "b.txt", stat: true },
      ctx(),
    );
    expect(res.output).toMatch(/\+200 -200/);
    expect(res.output.split("\n")).toHaveLength(1);
  });

  it("explains itself rather than failing obscurely outside a git repo", async () => {
    const res = await diffTool.execute({ mode: "working" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not a git work tree");
  });

  it("refuses a path outside the working directory", async () => {
    await expect(
      diffTool.execute({ mode: "files", path: "../x", other: "../y" }, ctx()),
    ).rejects.toThrow(/escapes/);
  });

  it.runIf(hasGit)("`stat` on a git mode returns the summary and NOT the diff", async () => {
    // `-U<n>` implies --patch, so passing it beside --stat returns the whole
    // diff after the summary — looking exactly like it worked, while costing
    // the context that asking for a stat was meant to save.
    execSync("git init -q . && git add -A && git commit -qm x --allow-empty", {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      shell: "/bin/sh",
    });
    await write("tracked.txt", "a\n");
    execSync("git add -A && git commit -qm y", {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      shell: "/bin/sh",
    });
    await write("tracked.txt", `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n`);

    const summary = await diffTool.execute({ mode: "working", stat: true }, ctx());
    expect(summary.output).toContain("tracked.txt");
    expect(summary.output).not.toContain("+line 7");

    const full = await diffTool.execute({ mode: "working" }, ctx());
    expect(full.output).toContain("+line 7");
  });
});

describe("patchTool", () => {
  const patchFor = (path: string, from: string, to: string) =>
    `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${from}\n+${to}\n`;

  it.runIf(hasGit)("applies a unified diff", async () => {
    await write("f.txt", "old\n");
    const res = await patchTool.execute({ patch: patchFor("f.txt", "old", "new") }, ctx());
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "f.txt"), "utf8")).toBe("new\n");
  });

  it.runIf(hasGit)("dry_run reports applicability and changes nothing", async () => {
    await write("f.txt", "old\n");
    const res = await patchTool.execute(
      { patch: patchFor("f.txt", "old", "new"), dry_run: true },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("applies cleanly");
    expect(await fs.readFile(join(dir, "f.txt"), "utf8")).toBe("old\n");
  });

  it.runIf(hasGit)("accepts a patch with no trailing newline", async () => {
    // git calls that a corrupt patch, and a model emitting one is the common
    // case rather than the odd one.
    await write("f.txt", "old\n");
    const res = await patchTool.execute(
      { patch: patchFor("f.txt", "old", "new").trimEnd() },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
  });

  it.runIf(hasGit)("reports that it had to recompute wrong hunk counts", async () => {
    // Silent repair is how the wrong lines change; the edit tool reports its
    // match tier for the same reason.
    await write("f.txt", "a\nb\nc\n");
    const wrong = "--- a/f.txt\n+++ b/f.txt\n@@ -1,9 +1,9 @@\n a\n-b\n+B\n c\n";
    const res = await patchTool.execute({ patch: wrong }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("recomputed");
    expect(await fs.readFile(join(dir, "f.txt"), "utf8")).toBe("a\nB\nc\n");
  });

  it.runIf(hasGit)("renders what it changed, like every other mutating tool", async () => {
    // `patch` was the only file-mutating tool that showed no diff — the one
    // call you most want to see was the one you could not.
    await write("f.txt", "old\n");
    const res = await patchTool.execute({ patch: patchFor("f.txt", "old", "new") }, ctx());
    expect(res.path).toBe("f.txt");
    expect(res.diff?.some((r) => r.kind === "del" && r.text === "old")).toBe(true);
    expect(res.diff?.some((r) => r.kind === "add" && r.text === "new")).toBe(true);
  });

  it.runIf(hasGit)("shows a created file as wholly added", async () => {
    const create = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n";
    const res = await patchTool.execute({ patch: create }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.diff?.some((r) => r.kind === "add" && r.text === "hello")).toBe(true);
  });

  it.runIf(hasGit)("renders nothing for a dry run — nothing changed", async () => {
    await write("f.txt", "old\n");
    const res = await patchTool.execute(
      { patch: patchFor("f.txt", "old", "new"), dry_run: true },
      ctx(),
    );
    expect(res.diff).toBeUndefined();
  });

  it("refuses a patch that writes outside the working directory", async () => {
    // git apply bounds paths by the REPOSITORY, not by the directory it runs
    // in — so this check is the tool's boundary, not a duplicate of git's.
    const escaping = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const res = await patchTool.execute({ patch: escaping }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("outside the working directory");
  });

  it("rejects text that is not a diff instead of shelling out to find out", async () => {
    const res = await patchTool.execute({ patch: "please change foo to bar" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not a unified diff");
  });

  it.runIf(hasGit)("says why it did not apply", async () => {
    await write("f.txt", "something else\n");
    const res = await patchTool.execute({ patch: patchFor("f.txt", "old", "new") }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("did not apply");
  });

  it.runIf(hasGit)("round-trips what the diff tool produced", async () => {
    // The two tools are only worth having together if one's output is the
    // other's input; a hunk header off by one breaks exactly that.
    await write("a.txt", "one\ntwo\nthree\nfour\n");
    await write("b.txt", "one\nTWO\nthree\nFOUR\n");
    const d = await diffTool.execute({ mode: "files", path: "a.txt", other: "a.txt" }, ctx());
    expect(d.output).toContain("identical");

    const real = await diffTool.execute({ mode: "files", path: "a.txt", other: "b.txt" }, ctx());
    const body = real.output.slice(0, real.output.lastIndexOf("\n["));
    // The diff names a.txt on the `---` side and b.txt on the `+++` side;
    // applying it in place rewrites a.txt into b.txt.
    const res = await patchTool.execute(
      { patch: body.replace(/\+\+\+ b\/b\.txt/, "+++ b/a.txt") },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nFOUR\n");
  });
});

describe("replaceTool", () => {
  it("replaces across files and reports each one", async () => {
    await write("a.ts", "const oldName = 1;\nuse(oldName);\n");
    await write("b.ts", "import { oldName } from './a';\n");
    const res = await replaceTool.execute({ pattern: "oldName", replacement: "newName" }, ctx());
    expect(res.output).toContain("a.ts · 2");
    expect(res.output).toContain("b.ts · 1");
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toContain("newName");
  });

  it("dry_run writes nothing", async () => {
    await write("a.ts", "old\n");
    const res = await replaceTool.execute(
      { pattern: "old", replacement: "new", dry_run: true },
      ctx(),
    );
    expect(res.output).toContain("Would replace");
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toBe("old\n");
  });

  it("supports capture groups in the replacement", async () => {
    await write("v.ts", 'version: "1.2.3"\n');
    await replaceTool.execute(
      { pattern: 'version: "(\\d+)\\.', replacement: 'version: "$1.9.' },
      ctx(),
    );
    expect(await fs.readFile(join(dir, "v.ts"), "utf8")).toBe('version: "1.9.2.3"\n');
  });

  it("`literal` escapes a pattern that is plain text", async () => {
    await write("a.ts", "a.b.c and axbxc\n");
    await replaceTool.execute({ pattern: "a.b.c", replacement: "Z", literal: true }, ctx());
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toBe("Z and axbxc\n");
  });

  it("refuses a pattern that matches the empty string", async () => {
    // /x*/ would insert the replacement between every character of every file.
    await write("a.ts", "hello\n");
    const res = await replaceTool.execute({ pattern: "x*", replacement: "Z" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("empty string");
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toBe("hello\n");
  });

  it("refuses over the cap BEFORE writing anything", async () => {
    // A cap that stops halfway leaves a tree nobody asked for.
    for (let i = 0; i < 8; i++) await write(`f${i}.ts`, "target\n");
    const res = await replaceTool.execute(
      { pattern: "target", replacement: "x", max_files: 3 },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("over the cap");
    expect(await fs.readFile(join(dir, "f0.ts"), "utf8")).toBe("target\n");
  });

  it("leaves binary files alone", async () => {
    await fs.writeFile(join(dir, "bin.dat"), Buffer.from([0x41, 0x00, 0x41, 0x41]));
    await write("a.ts", "A\n");
    const res = await replaceTool.execute({ pattern: "A", replacement: "B" }, ctx());
    expect(res.output).toContain("skipped");
    const bin = await fs.readFile(join(dir, "bin.dat"));
    expect(bin[0]).toBe(0x41);
  });

  it("refuses a glob that escapes the working directory", async () => {
    await expect(
      replaceTool.execute({ pattern: "a", replacement: "b", glob: "../**/*" }, ctx()),
    ).rejects.toThrow(/within the working directory/);
  });
});

describe("jsonTool", () => {
  it("reads a value by query path", async () => {
    await write("package.json", JSON.stringify({ scripts: { build: "tsup" } }, null, 2));
    const res = await jsonTool.execute({ path: "package.json", query: "scripts.build" }, ctx());
    expect(res.output).toBe('"tsup"');
  });

  it("reads a key that contains dots or slashes, via brackets", async () => {
    await write("package.json", JSON.stringify({ dependencies: { "@arterm/core": "1.0.0" } }));
    const res = await jsonTool.execute(
      { path: "package.json", query: 'dependencies["@arterm/core"]' },
      ctx(),
    );
    expect(res.output).toBe('"1.0.0"');
  });

  it("`keys` describes a level without returning it", async () => {
    await write("p.json", JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 1 } }));
    const res = await jsonTool.execute({ path: "p.json", action: "keys" }, ctx());
    expect(res.output).toContain("a: number");
    expect(res.output).toContain("b: array[3]");
    expect(res.output).toContain("c: object{1}");
  });

  it("sets a value, keeping the file's own indent and trailing newline", async () => {
    await write("p.json", `${JSON.stringify({ a: { b: 1 } }, null, 4)}\n`);
    await jsonTool.execute({ path: "p.json", action: "set", query: "a.b", value: "2" }, ctx());
    const after = await fs.readFile(join(dir, "p.json"), "utf8");
    expect(after).toContain('        "b": 2');
    expect(after.endsWith("\n")).toBe(true);
  });

  it("merges without dropping sibling keys", async () => {
    await write("p.json", JSON.stringify({ deps: { a: "1", b: "2" } }, null, 2));
    await jsonTool.execute(
      { path: "p.json", action: "merge", query: "deps", value: '{"b":"3","c":"4"}' },
      ctx(),
    );
    const after = JSON.parse(await fs.readFile(join(dir, "p.json"), "utf8"));
    expect(after.deps).toEqual({ a: "1", b: "3", c: "4" });
  });

  it("parses a .json file that has comments, and says it was lenient", async () => {
    await write("tsconfig.json", '{\n  // a comment\n  "strict": true,\n}\n');
    const res = await jsonTool.execute({ path: "tsconfig.json", action: "validate" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("JSON5");
  });

  it("refuses to WRITE a file whose comments it would delete", async () => {
    await write("tsconfig.json", '{\n  // keep me\n  "strict": true,\n}\n');
    const res = await jsonTool.execute(
      { path: "tsconfig.json", action: "set", query: "strict", value: "false" },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("delete them");
    expect(await fs.readFile(join(dir, "tsconfig.json"), "utf8")).toContain("// keep me");
  });

  it("keeps YAML comments through a write", async () => {
    // parse+stringify would lose every one of them.
    await write("c.yaml", "# top comment\nname: app\nport: 80 # inline\n");
    await jsonTool.execute({ path: "c.yaml", action: "set", query: "port", value: "8080" }, ctx());
    const after = await fs.readFile(join(dir, "c.yaml"), "utf8");
    expect(after).toContain("# top comment");
    expect(after).toContain("# inline");
    expect(after).toContain("8080");
  });

  it("reports a parse error rather than a stack trace", async () => {
    await write("bad.json", "{ nope");
    const res = await jsonTool.execute({ path: "bad.json", action: "validate" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not valid");
  });

  it("says when the query hits nothing", async () => {
    await write("p.json", JSON.stringify({ a: 1 }));
    const res = await jsonTool.execute({ path: "p.json", query: "b.c" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No value at b.c");
  });

  it("refuses a path outside the working directory", async () => {
    await expect(jsonTool.execute({ path: "../../etc/hosts" }, ctx())).rejects.toThrow(/escapes/);
  });
});

describe("query and merge helpers", () => {
  it("parses dotted, indexed and quoted steps", () => {
    expect(parseQuery("a.b")).toEqual(["a", "b"]);
    expect(parseQuery("a[0].b")).toEqual(["a", 0, "b"]);
    expect(parseQuery('deps["@arterm/core"]')).toEqual(["deps", "@arterm/core"]);
    expect(parseQuery("scripts['test:watch']")).toEqual(["scripts", "test:watch"]);
  });

  it("merges objects deeply and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
});
