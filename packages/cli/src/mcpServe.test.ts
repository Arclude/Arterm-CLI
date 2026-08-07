import type { Tool } from "@arterm/core";
import { defaultTools } from "@arterm/tools";
import { describe, expect, it, vi } from "vitest";
import { ArtermUserError } from "./errors.js";
import {
  createToolDispatcher,
  decidePublication,
  formatPublicationPlan,
  parseTier,
  publicationPlan,
  publishableTools,
  runMcpServe,
} from "./mcpServe.js";

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", properties: {} },
    permission: "allow",
    category: "read",
    execute: async () => ({ output: name }),
    ...extra,
  };
}

const READ = tool("reader");
const ASK = tool("writer", { permission: "ask", category: "edit", mutating: true });
const DESTRUCTIVE = tool("wrecker", {
  permission: "ask",
  category: "execute",
  mutating: true,
  riskTier: "destructive",
});

/**
 * The publication filter IS the security claim of `arterm mcp serve`, so it is
 * tested as one: every class, under both flag settings, by name.
 */
describe("the publication filter", () => {
  it("publishes a read-only tool by default", () => {
    expect(decidePublication(READ, false)).toMatchObject({ kind: "read-only", published: true });
    expect(decidePublication(READ, true)).toMatchObject({ kind: "read-only", published: true });
  });

  it('withholds an "ask" tool by default and publishes it with --writable', () => {
    expect(decidePublication(ASK, false)).toMatchObject({ kind: "ask", published: false });
    expect(decidePublication(ASK, true)).toMatchObject({ kind: "ask", published: true });
  });

  it("publishes a destructive tool under NEITHER setting", () => {
    expect(decidePublication(DESTRUCTIVE, false)).toMatchObject({
      kind: "destructive",
      published: false,
    });
    expect(decidePublication(DESTRUCTIVE, true)).toMatchObject({
      kind: "destructive",
      published: false,
    });
  });

  it("keeps destructive out even when it would otherwise read as read-only", () => {
    const sneaky = tool("sneaky", {
      permission: "allow",
      category: "read",
      riskTier: "destructive",
    });
    expect(decidePublication(sneaky, false).published).toBe(false);
    expect(decidePublication(sneaky, true).published).toBe(false);
  });

  it("never publishes a tool that proxies to other servers", () => {
    // mcp_use is "ask", so --writable would otherwise publish a door to every
    // MCP server configured on this machine.
    const proxy = tool("mcp_use", { permission: "ask", category: "execute", mutating: true });
    expect(decidePublication(proxy, false)).toMatchObject({ kind: "proxy", published: false });
    expect(decidePublication(proxy, true)).toMatchObject({ kind: "proxy", published: false });
  });

  it('never re-exposes a tool the local config set to "deny"', () => {
    const denied = tool("forbidden", { permission: "deny" });
    expect(decidePublication(denied, true)).toMatchObject({ kind: "denied", published: false });
  });

  it('withholds a never-prompting tool that is not read-only ("allow" is not "read")', () => {
    const runner = tool("runner", { permission: "allow", category: "execute" });
    expect(decidePublication(runner, false)).toMatchObject({
      kind: "privileged",
      published: false,
    });
    expect(decidePublication(runner, true).published).toBe(false);
  });

  it("withholds a tool classed read that still records something", () => {
    const recorder = tool("recorder", { permission: "allow", category: "read", mutating: true });
    expect(decidePublication(recorder, false).published).toBe(false);
  });

  it("filters a roster to the published set", () => {
    const roster = [READ, ASK, DESTRUCTIVE];
    expect(publishableTools(roster).map((t) => t.name)).toEqual(["reader"]);
    expect(publishableTools(roster, true).map((t) => t.name)).toEqual(["reader", "writer"]);
  });
});

describe("the publication filter over the real roster", () => {
  const roster = defaultTools("full");
  const names = (writable: boolean): string[] =>
    publishableTools(roster, writable).map((t) => t.name);

  it("publishes the read tools with no flag", () => {
    const published = names(false);
    for (const name of ["read", "grep", "glob", "ls", "tree", "search", "diff", "git"]) {
      expect(published).toContain(name);
    }
  });

  it("never publishes bash, replace or install — with or without --writable", () => {
    for (const name of ["bash", "replace", "install"]) {
      expect(names(false)).not.toContain(name);
      expect(names(true)).not.toContain(name);
    }
  });

  it("publishes the editing tools only with --writable", () => {
    for (const name of ["write", "edit", "multi_edit", "patch", "git_commit"]) {
      expect(names(false)).not.toContain(name);
      expect(names(true)).toContain(name);
    }
  });

  it('withholds `test` under both settings — "allow" locally is not read-only remotely', () => {
    // `test` is permission "allow" because running the project's suite is
    // routine for an agent with an arbiter and a sandbox behind it. Published,
    // it would run package scripts for anyone connected, with neither.
    expect(names(false)).not.toContain("test");
    expect(names(true)).not.toContain("test");
  });

  it("explains every withheld tool, so --list can be read as an audit", () => {
    for (const decision of publicationPlan(roster)) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("formatPublicationPlan", () => {
  it("reports both halves and which flag produced them", () => {
    const readOnly = formatPublicationPlan(publicationPlan([READ, ASK, DESTRUCTIVE]), false);
    expect(readOnly).toContain("1 tool(s) published, 2 withheld");
    expect(readOnly).toContain("pass --writable for the rest");
    expect(readOnly).toContain("wrecker");

    const writable = formatPublicationPlan(publicationPlan([READ, ASK, DESTRUCTIVE], true), true);
    expect(writable).toContain("2 tool(s) published, 1 withheld");
    expect(writable).toContain("(--writable)");
  });
});

describe("the dispatcher", () => {
  it("runs a published tool in the served working directory", async () => {
    const echo = tool("echo_cwd", { execute: async (_a, ctx) => ({ output: ctx.cwd }) });
    const dispatch = createToolDispatcher([echo], { cwd: "/srv/project" });
    const res = await dispatch("echo_cwd", {});
    expect(res.content[0]?.text).toBe("/srv/project");
    expect(res.isError).toBeUndefined();
  });

  it("refuses a tool that was not published, and names what was", async () => {
    const dispatch = createToolDispatcher([READ], { cwd: "." });
    const res = await dispatch("wrecker", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("This server publishes: reader");
  });

  it("turns a throwing tool into an error result rather than a dead connection", async () => {
    const boom = tool("boom", {
      execute: async () => {
        throw new Error("nope");
      },
    });
    const dispatch = createToolDispatcher([boom], { cwd: "." });
    const res = await dispatch("boom", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nope");
  });

  it("passes a tool's own isError through", async () => {
    const failing = tool("failing", { execute: async () => ({ output: "bad", isError: true }) });
    const dispatch = createToolDispatcher([failing], { cwd: "." });
    expect((await dispatch("failing", {})).isError).toBe(true);
  });

  it("applies the tool's output ceiling, which no agent is here to apply", async () => {
    const loud = tool("loud", {
      maxOutputBytes: 200,
      execute: async () => ({ output: "x".repeat(50_000) }),
    });
    const dispatch = createToolDispatcher([loud], { cwd: "." });
    const text = (await dispatch("loud", {})).content[0]?.text ?? "";
    expect(text.length).toBeLessThan(1_000);
    expect(text).toContain("the full output was 50000 bytes");
  });

  it("hands each tool only the PUBLISHED roster, so batch cannot reach past the filter", async () => {
    // batch is allow+read and so is published, and it dispatches to whatever
    // roster it is given. Given the full one it would reach `test`, which the
    // filter withheld — a per-tool filter is not a boundary if a published tool
    // can hand out the tools it excluded.
    const published = publishableTools(defaultTools("full"));
    expect(published.map((t) => t.name)).toContain("batch");
    const dispatch = createToolDispatcher(published, { cwd: process.cwd() });
    const res = await dispatch("batch", { calls: [{ name: "test" }] });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Unknown tool: test");
  });
});

describe("parseTier", () => {
  it("accepts the three tiers and nothing else", () => {
    expect(parseTier("minimal")).toBe("minimal");
    expect(parseTier(undefined)).toBeUndefined();
    expect(() => parseTier("everything")).toThrow(ArtermUserError);
  });
});

describe("runMcpServe --list", () => {
  it("prints the audit and starts no server", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await runMcpServe({ list: true }, "/srv/project");
    } finally {
      spy.mockRestore();
    }
    const out = written.join("");
    expect(out).toContain("arterm mcp serve —");
    expect(out).toContain("published:");
    expect(out).toContain("withheld:");
    expect(out).toContain("bash");
  });
});
