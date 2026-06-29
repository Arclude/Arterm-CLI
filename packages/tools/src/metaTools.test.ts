import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchTool } from "./batch.js";
import { defaultTools, lsTool, readTool, writeTool } from "./registry.js";
import { toolSearchTool } from "./toolSearch.js";
import { parseResults } from "./webSearch.js";

let dir: string;
const ctx = (): ToolContext => ({ cwd: dir, tools: defaultTools() });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-meta-test-"));
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
    expect(res.output).toContain("only read-only");
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

// Type-only guard: the new tools satisfy the Tool contract.
const _tools: Tool[] = [batchTool, toolSearchTool, lsTool, readTool, writeTool];
