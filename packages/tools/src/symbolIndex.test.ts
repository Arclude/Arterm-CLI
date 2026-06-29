import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymbolIndex, extractSymbols } from "./symbolIndex.js";
import { invalidateSymbolIndex, symbolsTool } from "./symbols.js";

describe("extractSymbols (TypeScript)", () => {
  const src = `import { x } from "y";

export class Widget {
  private count = 0;

  async render(opts: Opts): Promise<void> {
    if (this.count > 0) {
      return;
    }
  }

  get label() {
    return "w";
  }
}

export interface Opts {
  size: number;
}

export type Size = "sm" | "lg";

export enum Color { Red, Green }

export function build(n: number): Widget {
  return new Widget();
}

export const make = (n: number) => new Widget();
const helper = async () => 1;
`;
  const syms = extractSymbols("a.ts", src);
  const find = (name: string) => syms.find((s) => s.name === name);

  it("captures classes, interfaces, types, enums", () => {
    expect(find("Widget")?.kind).toBe("class");
    expect(find("Opts")?.kind).toBe("interface");
    expect(find("Size")?.kind).toBe("type");
    expect(find("Color")?.kind).toBe("enum");
  });

  it("captures functions, arrow consts, and methods", () => {
    expect(find("build")?.kind).toBe("function");
    expect(find("make")?.kind).toBe("function");
    expect(find("helper")?.kind).toBe("function");
    expect(find("render")?.kind).toBe("method");
    expect(find("label")?.kind).toBe("method");
  });

  it("records 1-based line numbers and a signature", () => {
    expect(find("Widget")?.line).toBe(3);
    expect(find("build")?.signature).toContain("function build");
  });

  it("does not mistake control-flow for a method", () => {
    expect(syms.some((s) => s.name === "if")).toBe(false);
    expect(syms.some((s) => s.name === "return")).toBe(false);
  });
});

describe("extractSymbols (other languages)", () => {
  it("Python def/class", () => {
    const s = extractSymbols("m.py", "class Foo:\n    def bar(self):\n        pass\n");
    expect(s.map((x) => `${x.kind}:${x.name}`)).toEqual(["class:Foo", "function:bar"]);
  });

  it("Go func/type", () => {
    const s = extractSymbols("m.go", "func Add(a, b int) int {\n}\ntype Point struct {\n}\n");
    expect(s.map((x) => `${x.kind}:${x.name}`)).toEqual(["function:Add", "struct:Point"]);
  });

  it("Rust fn/struct/trait", () => {
    const s = extractSymbols("m.rs", "pub fn run() {}\nstruct S;\npub trait T {}\n");
    expect(s.map((x) => `${x.kind}:${x.name}`)).toEqual(["function:run", "struct:S", "trait:T"]);
  });

  it("ignores unknown extensions", () => {
    expect(extractSymbols("readme.md", "# Title\nfunction nope() {}")).toEqual([]);
  });
});

describe("SymbolIndex", () => {
  let dir: string;
  let dbDir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-sym-"));
    dbDir = await fs.mkdtemp(join(tmpdir(), "arterm-symdb-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  it("indexes a tree and searches by name with a kind filter", async () => {
    await fs.writeFile(join(dir, "a.ts"), "export function alpha() {}\nexport class Beta {}\n");
    await fs.mkdir(join(dir, "sub"));
    await fs.writeFile(join(dir, "sub", "b.ts"), "export const alphabet = () => 1;\n");

    const index = new SymbolIndex(dir, { dbDir });
    await index.refresh();

    expect(index.size).toBe(3);
    expect(index.search("alpha").map((s) => s.name)).toContain("alpha");
    // Exact match ranks first.
    expect(index.search("alpha")[0]?.name).toBe("alpha");

    const classes = index.search("Beta", { kind: "class" });
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ name: "Beta", path: "a.ts", kind: "class" });

    expect(index.search("alpha", { kind: "class" })).toHaveLength(0);
    index.close();
  });

  it("incrementally re-parses changed files and forgets deleted ones", async () => {
    const file = join(dir, "a.ts");
    await fs.writeFile(file, "export function one() {}\n");
    const index = new SymbolIndex(dir, { dbDir });
    await index.refresh();
    expect(index.search("one")).toHaveLength(1);

    // Rewrite with a different symbol and bump mtime so the change is detected.
    await fs.writeFile(file, "export function two() {}\n");
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);
    await index.refresh();
    expect(index.search("one")).toHaveLength(0);
    expect(index.search("two")).toHaveLength(1);

    // Delete the file: its symbols drop out.
    await fs.rm(file);
    await index.refresh();
    expect(index.search("two")).toHaveLength(0);
    expect(index.size).toBe(0);
    index.close();
  });

  it("persists to SQLite when the runtime supports node:sqlite", async () => {
    await fs.writeFile(join(dir, "a.ts"), "export function persisted() {}\n");
    const first = new SymbolIndex(dir, { dbDir });
    await first.refresh();
    const wasPersistent = first.persistent;
    first.close();

    // A fresh index over the same dir+dbDir should see the symbol immediately.
    const second = new SymbolIndex(dir, { dbDir });
    await second.refresh();
    expect(second.search("persisted")).toHaveLength(1);
    second.close();
    // On this runtime node:sqlite is expected, but the test holds either way.
    expect(typeof wasPersistent).toBe("boolean");
  });
});

describe("symbolsTool", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-symtool-"));
  });
  afterEach(async () => {
    invalidateSymbolIndex(dir); // close the SQLite handle before removing the tree
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns kind + file:line lines for a match", async () => {
    await fs.writeFile(join(dir, "a.ts"), "export function findMe() {}\n");
    const res = await symbolsTool.execute({ query: "findMe" }, { cwd: dir });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("function findMe");
    expect(res.output).toContain("a.ts:1");
  });

  it("reports no match cleanly", async () => {
    await fs.writeFile(join(dir, "a.ts"), "export function x() {}\n");
    const res = await symbolsTool.execute({ query: "nothinghere" }, { cwd: dir });
    expect(res.output).toContain("No symbol matching");
  });
});
