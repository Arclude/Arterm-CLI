import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchTool } from "./batch.js";
import {
  createSetWorkingDirTool,
  createToolUseTool,
  toolHelpTool,
  toolUseTool,
} from "./metaTools.js";
import { defaultTools, lsTool, readTool, writeTool } from "./registry.js";
import { toolSearchTool } from "./toolSearch.js";
import { parseResults } from "./webSearch.js";
import { WorkingDirStore } from "./workingDir.js";

let dir: string;
/**
 * The same directory as `WorkingDirStore` sees it — `tmpdir()` is a symlink on
 * macOS. It must be resolved with the SAME function the store uses
 * (`realpathSync`), not the promise API: on Windows they disagree. `fs.realpath`
 * is libuv's, which expands an 8.3 short name, while `realpathSync` is Node's own
 * JS walk, which leaves it alone — so the store reported
 * `C:\Users\RUNNER~1\…` against an expectation of `C:\Users\runneradmin\…` and
 * eight tests failed on two spellings of one directory.
 */
let realDir: string;
const ctx = (): ToolContext => ({ cwd: dir, tools: defaultTools() });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-meta-test-"));
  realDir = realpathSync(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("toolSearchTool", () => {
  it("finds tools by intent, ranking name matches first", async () => {
    const res = await toolSearchTool.execute({ query: "run tests" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("test:");
  });

  it("reports when nothing matches and lists what's available", async () => {
    const res = await toolSearchTool.execute({ query: "zzzznothing" }, ctx());
    expect(res.output).toContain("No tools matched");
    expect(res.output).toContain("read");
  });

  it("handles an empty roster", async () => {
    const res = await toolSearchTool.execute({ query: "anything" }, { cwd: dir, tools: [] });
    expect(res.output).toContain("No tools are available");
  });
});

describe("batchTool", () => {
  it("runs multiple allow-only tools and aggregates their output", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    await fs.writeFile(join(dir, "b.txt"), "beta");
    const res = await batchTool.execute(
      {
        calls: [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "read", arguments: { path: "b.txt" } },
          { name: "ls", arguments: {} },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("alpha");
    expect(res.output).toContain("beta");
    expect(res.output).toContain("a.txt");
  });

  it("refuses to run a non-allow (prompting) tool", async () => {
    const res = await batchTool.execute(
      { calls: [{ name: "write", arguments: { path: "x.txt", content: "nope" } }] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    // The refusal names the tool it refused AND the dispatcher that refused it:
    // "tool_use has no way to ask" inside a batch would send a reader to the
    // wrong place.
    expect(res.output).toContain("write");
    expect(res.output).toContain("batch");
    expect(res.output.toLowerCase()).toContain("only read-only");
    // The write must NOT have happened.
    await expect(fs.readFile(join(dir, "x.txt"), "utf8")).rejects.toThrow();
  });

  it("flags unknown tools without failing the whole batch shape", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    const res = await batchTool.execute(
      {
        calls: [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "nope_tool", arguments: {} },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("alpha");
    expect(res.output).toContain("Unknown tool: nope_tool");
  });

  it("cannot be nested", async () => {
    const res = await batchTool.execute({ calls: [{ name: "batch", arguments: {} }] }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("cannot be nested");
  });

  it("rejects a non-array calls argument", async () => {
    const res = await batchTool.execute({ calls: "oops" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("must be an array");
  });

  it("runs calls in parallel when asked", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    await fs.writeFile(join(dir, "b.txt"), "beta");
    const res = await batchTool.execute(
      {
        parallel: true,
        calls: [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "read", arguments: { path: "b.txt" } },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("alpha");
    expect(res.output).toContain("beta");
  });
});

describe("webSearch parseResults", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc">First Title</a>
      <a class="result__snippet" href="x">First snippet text.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://direct.example.org/">Second &amp; Title</a>
      <a class="result__snippet" href="y">Second snippet.</a>
    </div>`;

  it("extracts titles, unwrapped URLs, and snippets", () => {
    const results = parseResults(html, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "First Title",
      url: "https://example.com/page",
      snippet: "First snippet text.",
    });
    expect(results[1]?.title).toBe("Second & Title");
    expect(results[1]?.url).toBe("https://direct.example.org/");
  });

  it("respects the result limit", () => {
    expect(parseResults(html, 1)).toHaveLength(1);
  });

  it("returns nothing for a page with no results", () => {
    expect(parseResults("<html><body>no results</body></html>", 10)).toHaveLength(0);
  });
});

/** A tool the registry does not have, injected through `ctx.tools`. */
function fakeTool(over: Partial<Tool> & { name: string }): Tool {
  return {
    description: "fake",
    parameters: { type: "object", properties: {} },
    permission: "allow",
    category: "read",
    execute: async () => ({ output: "ok" }),
    ...over,
  };
}

describe("toolHelpTool", () => {
  it("returns the description, the usage hint, the selection hint and the parameters", async () => {
    const res = await toolHelpTool.execute({ name: "grep" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("grep — Search file contents");
    expect(res.output).toContain("permission: allow · category: read");
    // `usageHint` is the whole point: the agent only delivers it after a failed
    // call, so this is the only way to read it before failing.
    expect(res.output).toContain("How to use it: The pattern is a JavaScript regular expression");
    expect(res.output).toContain("Do NOT use it when finding code by what it does");
    expect(res.output).toContain("- pattern (string, required):");
  });

  it("says so plainly when a tool has no usage notes", async () => {
    const res = await toolHelpTool.execute({ name: "ls" }, ctx());
    expect(res.output).toContain("(no usage notes recorded)");
  });

  it("carries the nested shape of a structured parameter", async () => {
    // "calls (array, required): the tool calls to run" tells a model nothing
    // about what one call looks like.
    const res = await toolHelpTool.execute({ name: "batch" }, ctx());
    expect(res.output).toContain("shape:");
    expect(res.output).toContain('"name"');
  });

  it("describes a tool that is not in the roster, and says it isn't", async () => {
    const minimal: ToolContext = { cwd: dir, tools: defaultTools("minimal") };
    const res = await toolHelpTool.execute({ name: "code_stats" }, minimal);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("code_stats —");
    expect(res.output).toContain("Not in your roster");
  });

  it("reports a roster tool as usable directly", async () => {
    const res = await toolHelpTool.execute({ name: "read" }, ctx());
    expect(res.output).not.toContain("Not in your roster");
  });

  it("fails on an unknown name and offers the near miss", async () => {
    const res = await toolHelpTool.execute({ name: "read_file" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Unknown tool: read_file");
    expect(res.output).toContain("Did you mean: read");
  });

  it("points at tool_search when nothing is close", async () => {
    const res = await toolHelpTool.execute({ name: "zzzz" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("tool_search");
  });

  it("requires a name", async () => {
    await expect(toolHelpTool.execute({}, ctx())).rejects.toThrow("name");
  });
});

describe("toolUseTool", () => {
  it("dispatches a read-only tool that is on the roster", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    const res = await toolUseTool.execute({ name: "read", arguments: { path: "a.txt" } }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("[read]");
    expect(res.output).toContain("alpha");
  });

  it("reaches a tool the roster never advertised", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    // `ls` is not in the minimal tier — reaching it is the reason this exists.
    const minimal: ToolContext = { cwd: dir, tools: defaultTools("minimal") };
    const res = await toolUseTool.execute({ name: "ls", arguments: {} }, minimal);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("a.txt");
  });

  it("refuses a tool that would have prompted", async () => {
    const res = await toolUseTool.execute(
      { name: "write", arguments: { path: "x.txt", content: "nope" } },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("needs permission (ask)");
    await expect(fs.readFile(join(dir, "x.txt"), "utf8")).rejects.toThrow();
  });

  it('refuses an "allow" tool that still executes — the hole batch leaves open', async () => {
    // `test` is permission "allow" with category "execute": it runs whatever
    // package.json calls a test. A direct call is denied in plan mode; batch
    // runs it anyway because it only looks at `permission`.
    const res = await toolUseTool.execute({ name: "test", arguments: {} }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("is an execute tool");
  });

  it("refuses an allow-but-edit tool", async () => {
    const roster = [...defaultTools(), fakeTool({ name: "notes", category: "edit" })];
    const res = await toolUseTool.execute({ name: "notes" }, { cwd: dir, tools: roster });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("is an edit tool");
  });

  it("treats a tool that declares no category as executing", async () => {
    const roster = [...defaultTools(), fakeTool({ name: "vague", category: undefined })];
    const res = await toolUseTool.execute({ name: "vague" }, { cwd: dir, tools: roster });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("is an execute tool");
  });

  it("cannot dispatch itself or batch", async () => {
    for (const name of ["tool_use", "batch"]) {
      const res = await toolUseTool.execute({ name, arguments: {} }, ctx());
      expect(res.isError).toBe(true);
      expect(res.output).toContain("cannot dispatch");
    }
  });

  it("will not reach a tool that is withheld from sub-agents", async () => {
    // `git_commit` ships in the standard tier but `subagentRoster()` strips it
    // from a worker. Off-roster dispatch must not hand it back.
    const minimal: ToolContext = { cwd: dir, tools: defaultTools("minimal") };
    const open = createToolUseTool({ gate: async () => ({ allowed: true }) });
    const res = await open.execute({ name: "git_commit", arguments: {} }, minimal);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Unknown tool: git_commit");
  });

  it("reports an unknown tool without throwing", async () => {
    const res = await toolUseTool.execute({ name: "nope_tool", arguments: {} }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Unknown tool: nope_tool");
  });

  it("rejects a non-object arguments value", async () => {
    const res = await toolUseTool.execute({ name: "read", arguments: "oops" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("must be an object");
  });

  it("reports a throwing tool as an error result", async () => {
    const roster = [
      ...defaultTools(),
      fakeTool({
        name: "boom",
        execute: async () => {
          throw new Error("kaboom");
        },
      }),
    ];
    const res = await toolUseTool.execute({ name: "boom" }, { cwd: dir, tools: roster });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Tool error in boom: kaboom");
  });

  it("applies the inner tool's own output ceiling", async () => {
    const roster = [
      ...defaultTools(),
      fakeTool({
        name: "loud",
        maxOutputBytes: 60,
        execute: async () => ({ output: "x".repeat(5000) }),
      }),
    ];
    const res = await toolUseTool.execute({ name: "loud" }, { cwd: dir, tools: roster });
    expect(res.output).toContain("clipped to loud's 60-byte ceiling");
    expect(res.output).toContain("(was 5000)");
    expect(res.output.length).toBeLessThan(400);
  });

  it("previews the inner call without pasting a whole file into the prompt", () => {
    const shown = toolUseTool.preview?.({
      name: "write",
      arguments: { path: "a.txt", content: "z".repeat(5000) },
    });
    expect(shown).toContain("tool_use write");
    expect(shown).toContain("(5000 chars)");
    // `summarizeArgs` caps a string value at 500 chars; the point is that the
    // 5000 never reaches the prompt or the transcript row.
    expect((shown ?? "").length).toBeLessThan(700);
  });

  it("forwards the inner result's path so a change is still reviewable", async () => {
    const roster = [
      ...defaultTools(),
      fakeTool({ name: "toucher", execute: async () => ({ output: "done", path: "a.txt" }) }),
    ];
    const res = await toolUseTool.execute({ name: "toucher" }, { cwd: dir, tools: roster });
    expect(res.path).toBe("a.txt");
  });
});

describe("toolUseTool with a permission gate", () => {
  it("consults the gate even for a read-only tool", async () => {
    // A per-tool "deny" override is a decision about the tool, not about how
    // it was reached — which is exactly what batch's static check cannot see.
    const gate = vi.fn(async (_tool: Tool, _args: Record<string, unknown>) => ({
      allowed: false,
      reason: "denied by config",
    }));
    const gated = createToolUseTool({ gate });
    const res = await gated.execute({ name: "read", arguments: { path: "a.txt" } }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toBe("denied by config");
    expect(gate).toHaveBeenCalledOnce();
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ name: "read" });
  });

  it("passes the inner tool and its arguments to the gate, not tool_use's", async () => {
    const gate = vi.fn(async (_tool: Tool, _args: Record<string, unknown>) => ({ allowed: true }));
    const gated = createToolUseTool({ gate });
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    await gated.execute({ name: "read", arguments: { path: "a.txt" } }, ctx());
    expect(gate.mock.calls[0]?.[1]).toEqual({ path: "a.txt" });
  });

  it("runs a mutating tool once the gate has approved it", async () => {
    const gated = createToolUseTool({ gate: async () => ({ allowed: true }) });
    const res = await gated.execute(
      { name: "write", arguments: { path: "x.txt", content: "hello" } },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "x.txt"), "utf8")).toBe("hello");
  });
});

describe("WorkingDirStore", () => {
  it("starts at the root and reports it relatively", async () => {
    const store = new WorkingDirStore(dir);
    expect(store.current()).toBe(realDir);
    expect(store.relative()).toBe(".");
  });

  it("moves into a subdirectory, relative to where it already is", async () => {
    await fs.mkdir(join(dir, "a", "b"), { recursive: true });
    const store = new WorkingDirStore(dir);
    expect(store.set("a").ok).toBe(true);
    expect(store.set("b").ok).toBe(true);
    expect(store.current()).toBe(join(realDir, "a", "b"));
    expect(store.relative()).toBe(join("a", "b"));
  });

  it("accepts an absolute path inside the root", async () => {
    await fs.mkdir(join(dir, "a"));
    const store = new WorkingDirStore(dir);
    expect(store.set(join(dir, "a")).ok).toBe(true);
  });

  it("refuses to climb out of the root", async () => {
    const store = new WorkingDirStore(dir);
    const res = store.set("..");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Refusing to leave the session root");
    expect(store.current()).toBe(realDir);
  });

  it("refuses an absolute path outside the root", async () => {
    const store = new WorkingDirStore(dir);
    expect(store.set(tmpdir()).ok).toBe(false);
  });

  it("refuses a symlink that points out of the root", async () => {
    // The lexical check passes here — only the realpath comparison catches it.
    const outside = await fs.mkdtemp(join(tmpdir(), "arterm-outside-"));
    await fs.symlink(outside, join(dir, "escape"), "dir");
    const store = new WorkingDirStore(dir);
    try {
      const res = store.set("escape");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Refusing to leave the session root");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("resolves a symlinked root so paths inside it are not read as escapes", async () => {
    await fs.mkdir(join(dir, "a"));
    const link = join(await fs.mkdtemp(join(tmpdir(), "arterm-link-")), "root");
    await fs.symlink(dir, link, "dir");
    const store = new WorkingDirStore(link);
    expect(store.root).toBe(realDir);
    expect(store.set("a").ok).toBe(true);
  });

  it("refuses a file and a path that does not exist", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha");
    const store = new WorkingDirStore(dir);
    expect(store.set("a.txt").error).toContain("Not a directory");
    expect(store.set("ghost").error).toContain("No such directory");
    expect(store.current()).toBe(realDir);
  });

  it("resets to the root and notifies on every change", async () => {
    await fs.mkdir(join(dir, "a"));
    const seen: string[] = [];
    const store = new WorkingDirStore(dir, (d) => seen.push(d));
    store.set("a");
    store.reset();
    expect(store.current()).toBe(realDir);
    expect(seen).toEqual([join(realDir, "a"), realDir]);
  });
});

describe("setWorkingDirTool", () => {
  it("moves, and later tool calls resolve there", async () => {
    await fs.mkdir(join(dir, "a"));
    await fs.writeFile(join(dir, "a", "inner.txt"), "deep");
    const store = new WorkingDirStore(dir);
    const tool = createSetWorkingDirTool(store);

    const res = await tool.execute({ path: "a" }, { cwd: dir });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("Working directory is now a");

    // The point of the whole exercise: a relative path now means the new place.
    const read = await readTool.execute({ path: "inner.txt" }, { cwd: store.current() });
    expect(read.output).toContain("deep");
  });

  it("reports a refusal as an error and leaves the directory alone", async () => {
    const store = new WorkingDirStore(dir);
    const tool = createSetWorkingDirTool(store);
    const res = await tool.execute({ path: "../.." }, { cwd: dir });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Refusing to leave the session root");
    expect(store.current()).toBe(realDir);
  });

  it("resets to the root", async () => {
    await fs.mkdir(join(dir, "a"));
    const store = new WorkingDirStore(dir);
    const tool = createSetWorkingDirTool(store);
    await tool.execute({ path: "a" }, { cwd: dir });
    const res = await tool.execute({ reset: true }, { cwd: dir });
    expect(res.output).toContain("Working directory is now .");
    expect(store.current()).toBe(realDir);
  });

  it("needs either a path or a reset", async () => {
    const tool = createSetWorkingDirTool(new WorkingDirStore(dir));
    const res = await tool.execute({}, { cwd: dir });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("or `reset: true`");
  });

  it("prompts by default — a move changes what every later prompt means", () => {
    const tool = createSetWorkingDirTool(new WorkingDirStore(dir));
    expect(tool.permission).toBe("ask");
    expect(tool.category).toBe("read");
  });
});

// Type-only guard: the new tools satisfy the Tool contract.
const _tools: Tool[] = [
  batchTool,
  toolSearchTool,
  toolHelpTool,
  toolUseTool,
  lsTool,
  readTool,
  writeTool,
];
