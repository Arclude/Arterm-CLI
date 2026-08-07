import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  editTool,
  jsonTool,
  multiEditTool,
  patchTool,
  replaceTool,
  writeTool,
} from "./registry.js";

/**
 * A tool that changed a file has to SHOW what it changed.
 *
 * This is the invariant `patch` violated for its whole life: it applied a
 * unified diff and returned "Applied to 3 file(s): a.ts, b.ts, c.ts", while
 * every sibling rendered the change itself. Nobody added that gap on purpose —
 * it happened by omission, which is the only way this class of gap ever
 * happens, and no test could fail because no test claimed the rule existed.
 *
 * So the rule is claimed here, in two halves that fail for different reasons:
 *
 *  - the BEHAVIOUR half runs each emitter for real and asserts the change came
 *    back as diff rows. It catches a regression in a tool that has the rule.
 *  - the CENSUS half reads the package's own declarations and requires every
 *    `mutating: true` + `category: "edit"` tool to be on one of two lists.
 *    It catches the actual failure mode — a NEW tool that never considered the
 *    question. Adding one now fails this file until someone answers it.
 *
 * The exemptions are listed with their reasons rather than left implicit,
 * because "renders no diff" and "nobody thought about it" are indistinguishable
 * from the outside, and telling them apart is the entire point.
 */

/** Tools that must return `diff` rows and the `path` they changed. */
const EMITS_DIFF = new Set([
  "edit",
  "write",
  "multi_edit",
  "replace",
  "json",
  "patch",
  // Behaviour covered in lsp/lsp.test.ts — it needs a language server, which
  // the fake fixture there provides and this file has no business spawning.
  "lsp_rename",
]);

/** Tools that write something, but for which a line diff is the wrong answer. */
const NO_DIFF: Record<string, string> = {
  git_commit:
    "writes history, not file content — the files are already whatever the diff " +
    "showed when they were changed, and `git` renders the commit.",
  format:
    "hands the whole tree to an external formatter. The change is non-semantic " +
    "by construction and has no single named target; `diff` is how you look at it.",
  plan: "session state under ~/.arterm, not a file in the project.",
  task: "session state under ~/.arterm, not a file in the project.",
  forget: "edits the memory store, which is not source and has no line identity.",
  browser_screenshot:
    "writes a PNG when `path` is given. The image itself comes back as `images` " +
    "and IS rendered; a line diff of binary would be noise.",
};

const SRC = dirname(fileURLToPath(import.meta.url));

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
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-mutdiff-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, body: string) => {
  await fs.writeFile(join(dir, rel), body);
};

interface Case {
  tool: Tool;
  setup?: () => Promise<void>;
  args: Record<string, unknown>;
  /** Text the diff must actually show as added — an empty diff is not a diff. */
  added: string;
}

const CASES: Case[] = [
  {
    tool: writeTool,
    args: { path: "new.ts", content: "const a = 1;\n" },
    added: "const a = 1;",
  },
  {
    tool: editTool,
    setup: () => write("f.ts", "const alpha = 1;\n"),
    args: { path: "f.ts", old_string: "alpha", new_string: "beta" },
    added: "const beta = 1;",
  },
  {
    tool: multiEditTool,
    setup: () => write("f.ts", "a\nb\n"),
    args: { path: "f.ts", edits: [{ old_string: "a", new_string: "A" }] },
    added: "A",
  },
  {
    tool: replaceTool,
    setup: () => write("f.ts", "alpha\n"),
    args: { pattern: "alpha", replacement: "beta" },
    added: "beta",
  },
  {
    tool: jsonTool,
    setup: () => write("p.json", '{\n  "a": 1\n}\n'),
    args: { path: "p.json", action: "set", query: "a", value: "2" },
    added: '"a": 2',
  },
  {
    tool: patchTool,
    setup: () => write("f.txt", "old\n"),
    args: { patch: "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
    added: "new",
  },
];

describe("a tool that changed a file shows what it changed", () => {
  for (const c of CASES) {
    // `patch` shells out to `git apply`; the rest need nothing.
    const run = c.tool === patchTool && !hasGit ? it.skip : it;
    run(`${c.tool.name} returns diff rows and the path`, async () => {
      await c.setup?.();
      const res = await c.tool.execute(c.args, ctx());

      expect(res.isError, `${c.tool.name} failed: ${res.output}`).toBeFalsy();
      expect(Array.isArray(res.diff), `${c.tool.name} returned no diff`).toBe(true);
      expect(res.diff?.length, `${c.tool.name} returned an empty diff`).toBeGreaterThan(0);
      // The path drives the "changed files" summary; a diff with no path is
      // rendered against nothing.
      expect(typeof res.path, `${c.tool.name} returned no path`).toBe("string");

      const added = (res.diff ?? []).filter((r) => r.kind === "add").map((r) => r.text);
      expect(added.join("\n"), `${c.tool.name} did not show the new text`).toContain(c.added);
    });
  }
});

describe("the census: every writing tool has answered the question", () => {
  /**
   * Tool declarations, read from the source rather than from a roster.
   *
   * A roster would miss the ones a session builds from a factory — `plan`,
   * `task`, `forget` and the browser tools are never in `defaultTools()`, and
   * those are exactly the ones that would slip through.
   */
  async function declaredWriters(): Promise<string[]> {
    const names = new Set<string>();
    for (const file of await sources(SRC)) {
      const text = await fs.readFile(file, "utf8");
      for (const hit of text.matchAll(/category:\s*"edit"/g)) {
        const at = hit.index ?? 0;
        const nameAt = text.lastIndexOf('name: "', at);
        if (nameAt < 0) continue;
        // From this tool's own `name` to just past its `category`, so the
        // declaration is caught whichever order its fields are written in.
        if (!/mutating:\s*true/.test(text.slice(nameAt, at + 200))) continue;
        const named = /name:\s*"([a-z_0-9]+)"/.exec(text.slice(nameAt));
        if (named?.[1]) names.add(named[1]);
      }
    }
    return [...names].sort();
  }

  async function sources(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") out.push(...(await sources(path)));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(path);
      }
    }
    return out;
  }

  it("finds every tool the two lists name", async () => {
    // Guards the guard: a parser that quietly matches nothing would let the
    // test below pass on an empty set forever.
    const found = await declaredWriters();
    for (const name of [...EMITS_DIFF, ...Object.keys(NO_DIFF)]) {
      expect(found, `${name} is on a list but no longer declared`).toContain(name);
    }
  });

  it("leaves no writing tool undecided", async () => {
    const found = await declaredWriters();
    const undecided = found.filter((n) => !EMITS_DIFF.has(n) && !(n in NO_DIFF));
    const fix =
      "Add them to EMITS_DIFF (and to CASES), or to NO_DIFF with the reason. " +
      "`patch` was silent for its whole life because nobody was asked.";
    expect(
      undecided,
      `${undecided.join(", ")} write files and this file does not say whether they render a diff. ${fix}`,
    ).toEqual([]);
  });
});
