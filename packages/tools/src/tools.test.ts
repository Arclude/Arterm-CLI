import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithin } from "./paths.js";
import {
  editTool,
  globTool,
  multiEditTool,
  readTool,
  searchTool,
  submitVerdictTool,
  writeTool,
} from "./registry.js";

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

  it("writes new_string literally, not as a $-replacement pattern", async () => {
    await fs.writeFile(join(dir, "a.txt"), "value = OLD;");
    const res = await editTool.execute(
      { path: "a.txt", old_string: "OLD", new_string: "a ($&) and b ($$)" },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    // Buggy String.replace would expand $& → "OLD" and $$ → "$"; we want it literal.
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("value = a ($&) and b ($$);");
  });
});

describe("multiEditTool", () => {
  it("applies several edits in order, sequentially", async () => {
    await fs.writeFile(join(dir, "a.txt"), "one two three");
    const res = await multiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "1 two", new_string: "1-2" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("1-2 three");
  });

  it("is atomic — a later failed edit leaves the file untouched", async () => {
    await fs.writeFile(join(dir, "a.txt"), "alpha beta");
    const res = await multiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "missing", new_string: "x" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("alpha beta");
  });

  it("errors when an edit's old_string is not unique without replace_all", async () => {
    await fs.writeFile(join(dir, "a.txt"), "x x x");
    const res = await multiEditTool.execute(
      { path: "a.txt", edits: [{ old_string: "x", new_string: "y" }] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("x x x");
  });

  it("honours replace_all per edit", async () => {
    await fs.writeFile(join(dir, "a.txt"), "x x | y");
    const res = await multiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "x", new_string: "z", replace_all: true },
          { old_string: "y", new_string: "w" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("z z | w");
  });

  it("writes each new_string literally, not as a $-replacement pattern", async () => {
    await fs.writeFile(join(dir, "a.txt"), "A B");
    const res = await multiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "A", new_string: "$&x" },
          { old_string: "B", new_string: "$$y" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("$&x $$y");
  });

  it("previews a -/+ diff (first line is the summary)", () => {
    const preview = multiEditTool.preview?.({
      path: "a.txt",
      edits: [{ old_string: "foo", new_string: "bar" }],
    });
    expect(preview).toBeTruthy();
    const [head, ...body] = (preview ?? "").split("\n");
    expect(head).toContain("multi_edit a.txt");
    expect(body).toContain("-foo");
    expect(body).toContain("+bar");
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
  it("rejects a symlink inside cwd that points outside it", async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), "arterm-outside-"));
    await fs.writeFile(join(outside, "secret.txt"), "secret");
    try {
      await fs.symlink(outside, join(dir, "link"), "dir");
    } catch {
      return; // no symlink privilege (e.g. Windows without dev mode) — skip
    }
    expect(() => resolveWithin(dir, "link/secret.txt")).toThrow(/symlink|escapes/);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("searchTool index invalidation", () => {
  it("re-indexes after a write so newly created files are found", async () => {
    await fs.writeFile(join(dir, "alpha.txt"), "the quick brown fox");
    // Prime the per-cwd index cache.
    const first = await searchTool.execute({ query: "quick" }, ctx());
    expect(first.output).toContain("alpha.txt");
    // A file created via the tool must be searchable immediately (cache invalidated).
    await writeTool.execute({ path: "bravo.txt", content: "lazy sleeping dog" }, ctx());
    const second = await searchTool.execute({ query: "lazy" }, ctx());
    expect(second.output).toContain("bravo.txt");
  });
});

describe("submitVerdictTool", () => {
  it("is allow + read, which is what survives the judge's own sandbox", () => {
    // The judge runs with `ask: () => "deny"` and in plan mode, so an "ask"
    // permission would deny its own verdict and any non-read category is blocked
    // outright. Both fields are load-bearing, not stylistic.
    expect(submitVerdictTool.permission).toBe("allow");
    expect(submitVerdictTool.category).toBe("read");
  });

  it("requires only pass and summary", () => {
    // mustFix stays optional on purpose: a required field a small model omits
    // would be a parse failure, and a parse failure fails OPEN — upgrading a
    // rejection into an acceptance.
    expect(submitVerdictTool.parameters.required).toEqual(["pass", "summary"]);
  });

  it("confirms a usable verdict", async () => {
    const pass = await submitVerdictTool.execute({ pass: true, summary: "ok" }, ctx());
    expect(pass.output).toContain("PASS");
    expect(pass.isError).toBeUndefined();
    const fail = await submitVerdictTool.execute(
      { pass: false, summary: "no", mustFix: ["a.ts:1", "b.ts:2"] },
      ctx(),
    );
    expect(fail.output).toContain("2 item(s)");
  });

  it("names the offending value when the payload is unusable", async () => {
    const res = await submitVerdictTool.execute({ pass: "maybe", summary: "hm" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain('"maybe"');
  });
});
