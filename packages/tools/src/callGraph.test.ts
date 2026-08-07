import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallGraph, extractFacts } from "./callGraph.js";
import {
  calleesTool,
  callersTool,
  codeStatsTool,
  deadCodeTool,
  resetCallGraphs,
} from "./codebase.js";
import { parserFailure } from "./treeSitter.js";

/** The grammars ship prebuilt wasm; if one cannot load, say so rather than fail obscurely. */
const parserOk = (await extractFacts("probe.ts", "function a() { b(); }")) !== undefined;

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-cg-"));
  resetCallGraphs();
});
afterEach(async () => {
  resetCallGraphs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string) {
  const abs = join(dir, rel);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, body);
}

/** A graph with no SQLite cache, so tests never share state through ARTERM_HOME. */
const freshGraph = async () => {
  const g = new CallGraph(dir, { dbDir: join(dir, ".cache") });
  await g.refresh();
  return g;
};

describe.runIf(parserOk)("extractFacts", () => {
  it("ignores calls in comments and strings — the whole reason for a parser", async () => {
    // A regex sees three callers of `fake` here. All three are wrong, and a
    // wrong caller is a wrong answer nobody re-checks.
    const facts = await extractFacts(
      "a.ts",
      [
        "// fake() in a line comment",
        "/* fake() in a block comment */",
        'const s = "fake() in a string";',
        "export function real() { fake(); }",
      ].join("\n"),
    );
    expect(facts?.calls.filter((c) => c.name === "fake")).toHaveLength(1);
    expect(facts?.calls[0]?.line).toBe(4);
  });

  it("attributes a call to the function it sits in", async () => {
    const facts = await extractFacts(
      "a.ts",
      ["function alpha() { helper(); }", "function beta() { helper(); other(); }"].join("\n"),
    );
    const byCaller = (facts?.calls ?? []).map((c) => `${c.caller}:${c.name}`);
    expect(byCaller).toEqual(["alpha:helper", "beta:helper", "beta:other"]);
  });

  it("sees methods, and keys a member call by its bare name", async () => {
    const facts = await extractFacts(
      "a.ts",
      ["class C {", "  run() { this.helper(); obj.parse(1); }", "  helper() {}", "}"].join("\n"),
    );
    const run = (facts?.calls ?? []).filter((c) => c.caller === "run");
    expect(run.map((c) => c.name).sort()).toEqual(["helper", "parse"]);
    expect(run.map((c) => c.expression)).toContain("this.helper");
  });

  it("treats an arrow assigned to a const as a scope, and a plain const as not", async () => {
    const facts = await extractFacts(
      "a.ts",
      ["const n = 1;", "export const go = () => { inner(); };"].join("\n"),
    );
    expect(facts?.calls.find((c) => c.name === "inner")?.caller).toBe("go");
    expect(facts?.decls.map((d) => d.name)).toContain("go");
    expect(facts?.decls.map((d) => d.name)).not.toContain("n");
  });

  it("marks what a TS file exports", async () => {
    const facts = await extractFacts(
      "a.ts",
      ["export function pub() {}", "function priv() {}"].join("\n"),
    );
    expect(facts?.decls.find((d) => d.name === "pub")?.exported).toBe(true);
    expect(facts?.decls.find((d) => d.name === "priv")?.exported).toBe(false);
  });

  it("records imports with the module they came from", async () => {
    const facts = await extractFacts("a.ts", 'import { parse, run } from "./other.js";\n');
    expect(facts?.imports.map((i) => i.name).sort()).toEqual(["parse", "run"]);
    expect(facts?.imports[0]?.from).toBe("./other.js");
  });

  it("skips a call whose callee is not a name — it would key on nothing", async () => {
    const facts = await extractFacts("a.ts", "function f() { handlers[i](); (await g())(); }");
    expect(facts?.calls.map((c) => c.name)).not.toContain("");
  });

  it("reads python too", async () => {
    const facts = await extractFacts(
      "a.py",
      ["def alpha():", "    helper()", "", "def helper():", "    pass"].join("\n"),
    );
    expect(facts?.calls.map((c) => `${c.caller}:${c.name}`)).toEqual(["alpha:helper"]);
    // No export keyword in python: module level IS the public surface.
    expect(facts?.decls.find((d) => d.name === "alpha")?.exported).toBe(true);
  });

  it("returns nothing for a file it has no grammar for", async () => {
    expect(await extractFacts("a.rb", "def x; end")).toBeUndefined();
  });
});

describe.runIf(parserOk)("CallGraph over a tree", () => {
  it("finds callers across files", async () => {
    await write("src/lib.ts", "export function target() {}\n");
    await write("src/one.ts", 'import { target } from "./lib.js";\nfunction a() { target(); }\n');
    await write("src/two.ts", 'import { target } from "./lib.js";\nfunction b() { target(); }\n');
    const g = await freshGraph();

    const sites = g.callers("target");
    expect(sites.map((s) => s.path)).toEqual(["src/one.ts", "src/two.ts"]);
    expect(sites.map((s) => s.caller)).toEqual(["a", "b"]);
  });

  it("finds what one function calls, separating project code from the rest", async () => {
    // On a real function the `.map`/`.trim` calls outnumber the ones that
    // matter; three useful rows buried in thirty is not an answer.
    await write("src/lib.ts", "export function first() {}\nexport function second() {}\n");
    await write("src/a.ts", "function outer() { first(); second(); [].map(x); }\n");
    const g = await freshGraph();
    const { local, external } = g.callees("outer");
    expect(local.map((s) => s.name)).toEqual(["first", "second"]);
    expect(external.map((s) => s.name)).toEqual(["map"]);
  });

  it("does not claim `x.trim()` calls a project method named trim", async () => {
    // Observed on this repository: it declares a `trim` method, so every
    // `raw.trim()` reported as a call into project code. Resolving that needs
    // the type of `raw`, which no syntax tree has.
    await write("src/board.ts", "export class B { trim() {} }\n");
    await write("src/a.ts", "function outer() { const raw = ''; raw.trim(); }\n");
    const g = await freshGraph();
    const { local, external } = g.callees("outer");
    expect(local).toHaveLength(0);
    expect(external.map((s) => s.expression)).toEqual(["raw.trim"]);
  });

  it("but `this.x()` is a real local call", async () => {
    await write("src/c.ts", "export class C { run() { this.helper(); } helper() {} }\n");
    const g = await freshGraph();
    expect(g.callees("run").local.map((s) => s.name)).toEqual(["helper"]);
  });

  it("names a callback's scope after the call it was passed to", async () => {
    // Otherwise every assertion in a test file reads as "(top level)".
    await write("src/lib.ts", "export function target() {}\n");
    await write("src/a.test.ts", 'it("does a thing", () => { target(); });\n');
    const g = await freshGraph();
    expect(g.callers("target").map((s) => s.caller)).toEqual(["it"]);
  });

  it("re-parses only what changed", async () => {
    await write("src/a.ts", "export function one() {}\n");
    const g = new CallGraph(dir, { dbDir: join(dir, ".cache") });
    await g.refresh();
    expect(g.stats().decls).toBe(1);

    await write("src/b.ts", "export function two() { one(); }\n");
    await g.refresh();
    expect(g.stats().decls).toBe(2);
    expect(g.callers("one")).toHaveLength(1);
    g.close();
  });

  it("forgets a deleted file", async () => {
    await write("src/a.ts", "export function gone() {}\n");
    const g = new CallGraph(dir, { dbDir: join(dir, ".cache") });
    await g.refresh();
    expect(g.declarations("gone")).toHaveLength(1);

    await fs.rm(join(dir, "src/a.ts"));
    await g.refresh();
    expect(g.declarations("gone")).toHaveLength(0);
    g.close();
  });

  it("counts an imported-but-never-called export as referenced", async () => {
    // Re-exported, passed as a value, used as a type — all references.
    await write("src/lib.ts", "export function used() {}\nexport function unused() {}\n");
    await write("src/app.ts", 'import { used } from "./lib.js";\nexport const h = used;\n');
    const g = await freshGraph();
    expect(g.unreferencedExports().map((d) => d.name)).toEqual(["unused"]);
  });
});

describe.runIf(parserOk)("the tools", () => {
  it("callers reports the sites and states how it matched", async () => {
    await write("src/lib.ts", "export function target() {}\n");
    await write("src/one.ts", "function a() { target(); }\n");
    const res = await callersTool.execute({ name: "target" }, ctx());
    expect(res.output).toContain("src/one.ts:1");
    expect(res.output).toContain("declared at");
    // The calibration sentence is the difference between a tool a reader can
    // trust and one that reads like a compiler.
    expect(res.output).toContain("matched by name");
  });

  it("callers says plainly when there are none", async () => {
    await write("src/lib.ts", "export function lonely() {}\n");
    const res = await callersTool.execute({ name: "lonely" }, ctx());
    expect(res.output).toContain("No call site");
    expect(res.isError).toBeFalsy();
  });

  it("callees distinguishes 'calls nothing' from 'does not exist'", async () => {
    await write("src/a.ts", "export function quiet() { return 1; }\n");
    expect((await calleesTool.execute({ name: "quiet" }, ctx())).output).toContain("calls nothing");
    expect((await calleesTool.execute({ name: "nope" }, ctx())).output).toContain(
      "No declaration named nope",
    );
  });

  it("dead_code frames its rows as candidates, never as verdicts", async () => {
    // A library that acts on this list deletes its own API.
    await write("src/lib.ts", "export function orphan() {}\n");
    const res = await deadCodeTool.execute({}, ctx());
    expect(res.output).toContain("orphan");
    expect(res.output).toContain("candidates, not verdicts");
    expect(res.output).toContain("another repository");
  });

  it("dead_code narrows by path prefix", async () => {
    await write("src/lib.ts", "export function a() {}\n");
    await write("other/lib.ts", "export function b() {}\n");
    const res = await deadCodeTool.execute({ path_prefix: "src/" }, ctx());
    expect(res.output).toContain("a");
    expect(res.output).not.toContain("other/lib.ts");
  });

  it("code_stats reports coverage and how it is cached", async () => {
    await write("src/a.ts", "export function f() { g(); }\n");
    const res = await codeStatsTool.execute({}, ctx());
    expect(res.output).toMatch(/files parsed:\s+1/);
    expect(res.output).toMatch(/call sites:\s+1/);
    expect(res.output).toMatch(/cache:/);
  });
});

describe("when the parser is unavailable", () => {
  it.runIf(!parserOk)("says so instead of guessing with a regex", async () => {
    // A regex-derived call graph is the silent wrong answer tree-sitter was
    // chosen to avoid, so there is deliberately no fallback.
    await write("src/a.ts", "function f() { g(); }\n");
    const res = await callersTool.execute({ name: "g" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unavailable");
  });

  it("reports a reason when it failed to load", () => {
    if (parserOk) expect(parserFailure()).toBeUndefined();
    else expect(parserFailure()).toBeTruthy();
  });
});

describe.runIf(parserOk)("what counts as exported", () => {
  it("a class's members are not exports — the class is", async () => {
    // Every private field and constructor of every exported class showed up in
    // `dead_code` before this: an `export_statement` anywhere above counted.
    const facts = await extractFacts(
      "a.ts",
      ["export class C {", "  private field = 1;", "  constructor() {}", "  helper() {}", "}"].join(
        "\n",
      ),
    );
    expect(facts?.decls.find((d) => d.name === "C")?.exported).toBe(true);
    for (const member of ["field", "constructor", "helper"]) {
      expect(facts?.decls.find((d) => d.name === member)?.exported, member).toBe(false);
    }
  });

  it("a function nested inside an exported one is not itself exported", async () => {
    const facts = await extractFacts(
      "a.ts",
      ["export function outer() {", "  function inner() {}", "  return inner;", "}"].join("\n"),
    );
    expect(facts?.decls.find((d) => d.name === "outer")?.exported).toBe(true);
    expect(facts?.decls.find((d) => d.name === "inner")?.exported).toBe(false);
  });

  it("an exported arrow const is exported", async () => {
    const facts = await extractFacts("a.ts", "export const go = () => {};\n");
    expect(facts?.decls.find((d) => d.name === "go")?.exported).toBe(true);
  });

  it("never offers a constructor as dead code", async () => {
    await write("src/c.ts", "export class C { constructor() {} }\n");
    const g = await freshGraph();
    expect(g.unreferencedExports().map((d) => d.name)).not.toContain("constructor");
  });
});

describe.runIf(parserOk)("JSX", () => {
  it("counts `<Foo />` as a reference to Foo", async () => {
    // A component is used as an element, not called. Without this every
    // component in a React codebase reads as dead — observed on this repo,
    // where the transcript's MessageList was offered up for deletion.
    await write("src/Comp.tsx", "export function Widget() { return null; }\n");
    await write(
      "src/App.tsx",
      'import { Widget } from "./Comp.js";\nexport const App = () => <Widget />;\n',
    );
    const g = await freshGraph();
    expect(g.callers("Widget").map((s) => s.path)).toContain("src/App.tsx");
    expect(g.unreferencedExports().map((d) => d.name)).not.toContain("Widget");
  });

  it("ignores host elements — `div` is not a project symbol", async () => {
    await write("src/App.tsx", "export const App = () => <div><span/></div>;\n");
    const g = await freshGraph();
    expect(g.callers("div")).toHaveLength(0);
  });
});
