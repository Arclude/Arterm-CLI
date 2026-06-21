import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithin } from "./paths.js";
import { editTool, globTool, readTool } from "./registry.js";

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readTool", () => {
  it("returns numbered file contents", async () => {
    await fs.writeFile(join(dir, "a.txt"), "hello\nworld");
    const res = await readTool.execute({ path: "a.txt" }, ctx());
    expect(res.output).toContain("hello");
    expect(res.output).toContain("world");
    expect(res.output).toMatch(/1\thello/);
  });
});

describe("editTool", () => {
  it("replaces a unique substring", async () => {
    await fs.writeFile(join(dir, "a.txt"), "foo bar baz");
    const res = await editTool.execute(
      { path: "a.txt", old_string: "bar", new_string: "qux" },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("foo qux baz");
  });

  it("errors when old_string is not unique", async () => {
    await fs.writeFile(join(dir, "a.txt"), "x x x");
    const res = await editTool.execute({ path: "a.txt", old_string: "x", new_string: "y" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("replaces all when replace_all is set", async () => {
    await fs.writeFile(join(dir, "a.txt"), "x x x");
    await editTool.execute(
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("y y y");
  });
});

describe("globTool", () => {
  it("finds files by pattern", async () => {
    await fs.mkdir(join(dir, "src"));
    await fs.writeFile(join(dir, "src", "a.ts"), "");
    await fs.writeFile(join(dir, "src", "b.ts"), "");
    const res = await globTool.execute({ pattern: "src/**/*.ts" }, ctx());
    expect(res.output).toContain("src/a.ts");
    expect(res.output).toContain("src/b.ts");
  });
});

describe("resolveWithin", () => {
  it("rejects paths that escape the working directory", () => {
    expect(() => resolveWithin(dir, "../secret")).toThrow();
  });
  it("allows paths inside the working directory", () => {
    expect(() => resolveWithin(dir, "sub/file.txt")).not.toThrow();
  });
});
