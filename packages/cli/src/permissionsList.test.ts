import { type ArtermConfig, type Tool, defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import type { ExplainResult } from "./permissionsExplain.js";
import { formatList, listPermissions, parseOnly } from "./permissionsList.js";

function tool(over: Partial<Tool> & { name: string }): Tool {
  return {
    description: "test tool",
    permission: "ask",
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("list must never execute a tool");
    },
    ...over,
  } as Tool;
}

const TOOLS: Array<{ tool: Tool; source: ExplainResult["source"] }> = [
  { tool: tool({ name: "read_file", permission: "allow", category: "read" }), source: "built-in" },
  { tool: tool({ name: "write_file", permission: "ask", category: "edit" }), source: "built-in" },
  { tool: tool({ name: "bash", permission: "ask", category: "execute" }), source: "built-in" },
  {
    tool: tool({
      name: "drop_db",
      permission: "ask",
      category: "execute",
      riskTier: "destructive",
    }),
    source: "plugin",
  },
];

function config(over: Partial<ArtermConfig> = {}): ArtermConfig {
  return { ...defaultConfig(), ...over };
}

describe("parseOnly", () => {
  it("accepts the three outcomes and nothing else", () => {
    expect(parseOnly("allow")).toBe("allow");
    expect(parseOnly(undefined)).toBeUndefined();
    expect(() => parseOnly("maybe")).toThrow(/unknown outcome/);
  });
});

describe("listPermissions", () => {
  it("reports one row per tool with its effective level and outcome", () => {
    const result = listPermissions(config({ mode: "ask" }), TOOLS);
    expect(result.mode).toBe("ask");
    expect(result.rows).toHaveLength(4);

    const read = result.rows.find((r) => r.tool === "read_file");
    expect(read).toMatchObject({ level: "allow", outcome: "allow", category: "read" });
    const write = result.rows.find((r) => r.tool === "write_file");
    expect(write).toMatchObject({ level: "ask", outcome: "prompt" });
  });

  it("evaluates under an explicit mode without mutating the config", () => {
    const cfg = config({ mode: "ask" });
    const plan = listPermissions(cfg, TOOLS, { mode: "plan" });
    expect(plan.mode).toBe("plan");
    // Plan mode is read-only: everything that mutates is blocked outright.
    expect(plan.rows.find((r) => r.tool === "write_file")?.outcome).toBe("deny");
    expect(plan.rows.find((r) => r.tool === "read_file")?.outcome).toBe("allow");
    expect(cfg.mode).toBe("ask");
    expect(listPermissions(cfg, TOOLS).mode).toBe("ask");
  });

  it("marks a level that came from a config override", () => {
    const result = listPermissions(config({ permissions: { bash: "deny" } }), TOOLS);
    const bash = result.rows.find((r) => r.tool === "bash");
    expect(bash).toMatchObject({ level: "deny", outcome: "deny", overridden: true });
    expect(result.rows.find((r) => r.tool === "read_file")?.overridden).toBe(false);
  });

  it("carries the source and risk tier so a third-party tool stands out", () => {
    const row = listPermissions(config(), TOOLS).rows.find((r) => r.tool === "drop_db");
    expect(row).toMatchObject({ source: "plugin", riskTier: "destructive" });
  });

  it("filters to a single outcome", () => {
    const result = listPermissions(config({ mode: "plan" }), TOOLS, { only: "deny" });
    expect(result.rows.map((r) => r.tool).sort()).toEqual(["bash", "drop_db", "write_file"]);
  });

  it("sorts riskiest first, then alphabetically", () => {
    const result = listPermissions(config({ mode: "plan" }), TOOLS);
    expect(result.rows.map((r) => r.tool)).toEqual(["bash", "drop_db", "write_file", "read_file"]);
  });

  it("reports whether an arbiter screens command arguments", () => {
    expect(listPermissions(config(), TOOLS).arbiterScreensArgs).toBe(true);
    const off = listPermissions(config({ arbiter: { enabled: false } }), TOOLS);
    expect(off.arbiterScreensArgs).toBe(false);
  });

  it("flags rows whose verdict the arguments can still change", () => {
    // The row that matters: under `auto`, bash reads "runs" only because the
    // arbiter had no command to look at. Read tools are never arg-dependent.
    const rows = listPermissions(config({ mode: "auto" }), TOOLS).rows;
    expect(rows.find((r) => r.tool === "bash")).toMatchObject({
      outcome: "allow",
      argDependent: true,
    });
    expect(rows.find((r) => r.tool === "read_file")?.argDependent).toBe(false);
  });

  it("does not flag a row the arbiter cannot rescue or an arbiter-less policy", () => {
    const denied = listPermissions(config({ permissions: { bash: "deny" } }), TOOLS);
    expect(denied.rows.find((r) => r.tool === "bash")?.argDependent).toBe(false);
    const off = listPermissions(config({ arbiter: { enabled: false } }), TOOLS);
    expect(off.rows.every((r) => r.argDependent === false)).toBe(true);
  });

  it("keeps the pre-filter total so a filtered table can say so", () => {
    const result = listPermissions(config({ mode: "plan" }), TOOLS, { only: "deny" });
    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(3);
  });

  it("surfaces the model gate that runs before the ladder", () => {
    const result = listPermissions(
      config({ arbiter: { enabled: true, model: "qwen3:8b" } }),
      TOOLS,
    );
    expect(result.brainArbiterModel).toBe("qwen3:8b");
  });

  it("agrees with the session policy — this IS evaluate(), not a summary", () => {
    // The whole point of the command: `auto` approves edits silently, and that
    // fact comes from the same ladder the agent loop runs.
    const auto = listPermissions(config({ mode: "auto" }), TOOLS);
    expect(auto.rows.find((r) => r.tool === "write_file")?.outcome).toBe("allow");
    const yolo = listPermissions(config({ mode: "yolo", permissions: { bash: "deny" } }), TOOLS);
    // Fail-closed: a tool-level deny still wins under yolo.
    expect(yolo.rows.find((r) => r.tool === "bash")?.outcome).toBe("deny");
    expect(yolo.rows.find((r) => r.tool === "write_file")?.outcome).toBe("allow");
  });
});

describe("formatList", () => {
  it("renders a row per tool with its outcome and flags", () => {
    const out = formatList(listPermissions(config({ mode: "ask" }), TOOLS));
    expect(out).toContain("mode: ask");
    expect(out).toContain("4 tools");
    expect(out).toMatch(/✓ runs\s+read_file/);
    expect(out).toMatch(/\? prompts\*\s+write_file/);
    expect(out).toContain("risk:destructive");
    expect(out).toContain("plugin");
  });

  it("stars arg-dependent rows and explains the star", () => {
    const out = formatList(listPermissions(config({ mode: "auto" }), TOOLS));
    expect(out).toMatch(/✓ runs\*\s+bash/);
    expect(out).toMatch(/✓ runs\s+read_file/);
    expect(out).toContain("evaluated with none");
    expect(out).toContain("permissions explain");
  });

  it("omits the arbiter note when nothing screens arguments", () => {
    const out = formatList(listPermissions(config({ arbiter: { enabled: false } }), TOOLS));
    expect(out).not.toContain("evaluated with none");
    expect(out).not.toContain("*");
  });

  it("says how many rows were filtered out", () => {
    const out = formatList(listPermissions(config({ mode: "plan" }), TOOLS, { only: "deny" }));
    expect(out).toContain("3 of 4 tools");
  });

  it("leaves no trailing whitespace on a row without flags", () => {
    const out = formatList(listPermissions(config(), TOOLS));
    expect(out.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  });

  it("says the model gate is not evaluated here", () => {
    const out = formatList(
      listPermissions(config({ arbiter: { enabled: true, model: "qwen3:8b" } }), TOOLS),
    );
    expect(out).toContain("qwen3:8b");
    expect(out).toContain("runs BEFORE this policy");
  });

  it("handles an empty result", () => {
    expect(formatList(listPermissions(config(), TOOLS, { only: "deny" }))).toBe("No tools match.");
  });
});
