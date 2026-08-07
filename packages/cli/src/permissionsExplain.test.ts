import { type ArtermConfig, type Tool, defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import {
  type ExplainResult,
  collectTools,
  explainCall,
  formatExplanation,
  parseArgs,
  parseMode,
} from "./permissionsExplain.js";

function tool(over: Partial<Tool> & { name: string }): Tool {
  return {
    description: "test tool",
    permission: "ask",
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("explain must never execute a tool");
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

describe("parseArgs", () => {
  it("defaults to an empty object", () => {
    expect(parseArgs(undefined)).toEqual({});
  });

  it("rejects non-JSON with an actionable message", () => {
    expect(() => parseArgs("{oops")).toThrow(/not valid JSON/);
  });

  it("rejects a JSON value that isn't an object", () => {
    expect(() => parseArgs("[1,2]")).toThrow(/must be a JSON object/);
    expect(() => parseArgs('"hi"')).toThrow(/must be a JSON object/);
  });

  it("passes an object through", () => {
    expect(parseArgs('{"command":"ls"}')).toEqual({ command: "ls" });
  });
});

describe("parseMode", () => {
  it("names the valid modes when given a bad one", () => {
    expect(() => parseMode("turbo")).toThrow(/ask, auto, plan, yolo/);
  });

  it("accepts a real mode and passes undefined through", () => {
    expect(parseMode("plan")).toBe("plan");
    expect(parseMode(undefined)).toBeUndefined();
  });
});

describe("explainCall", () => {
  it("lists the known tools when the name is wrong", () => {
    expect(() => explainCall(config(), TOOLS, { tool: "wrte_file", args: {} })).toThrow(
      /unknown tool "wrte_file"\. Available: bash, drop_db, read_file, write_file/,
    );
  });

  it("reports a read-only tool as running without a prompt", () => {
    const result = explainCall(config(), TOOLS, { tool: "read_file", args: {} });
    expect(result.evaluation.outcome).toBe("allow");
    expect(result.source).toBe("built-in");
  });

  it("reports that an edit prompts under ask and not under auto", () => {
    expect(
      explainCall(config({ mode: "ask" }), TOOLS, { tool: "write_file", args: {} }).evaluation
        .outcome,
    ).toBe("prompt");
    expect(
      explainCall(config({ mode: "auto" }), TOOLS, { tool: "write_file", args: {} }).evaluation
        .outcome,
    ).toBe("allow");
  });

  it("evaluates the arbiter against the actual arguments", () => {
    // The whole point of passing args: risk comes from the command, not the tool.
    const safe = explainCall(config({ mode: "auto" }), TOOLS, {
      tool: "bash",
      args: { command: "ls -la" },
    });
    const critical = explainCall(config({ mode: "auto" }), TOOLS, {
      tool: "bash",
      args: { command: "rm -rf /" },
    });
    expect(safe.evaluation.outcome).toBe("allow");
    expect(critical.evaluation.outcome).toBe("deny");
    expect(critical.evaluation.trace.find((s) => s.decided)?.rule).toBe("arbiter");
  });

  it("shows that a tool-level deny wins even under yolo", () => {
    const cfg = config({ mode: "yolo", permissions: { bash: "deny" } });
    const result = explainCall(cfg, TOOLS, { tool: "bash", args: { command: "ls" } });
    expect(result.evaluation.outcome).toBe("deny");
    expect(result.evaluation.overridden).toBe(true);
    expect(result.evaluation.trace[0]?.rule).toBe("tool-level");
  });

  it("honors an explicit mode override without touching the config", () => {
    const cfg = config({ mode: "yolo" });
    const result = explainCall(cfg, TOOLS, { tool: "write_file", args: {}, mode: "plan" });
    expect(result.evaluation.outcome).toBe("deny");
    expect(result.evaluation.mode).toBe("plan");
    expect(cfg.mode).toBe("yolo");
  });

  it("reports the destructive gate forcing a prompt in yolo", () => {
    const cfg = config({ mode: "yolo", confirmDestructive: true });
    const result = explainCall(cfg, TOOLS, { tool: "drop_db", args: {} });
    expect(result.evaluation.outcome).toBe("prompt");
    expect(result.evaluation.riskTier).toBe("destructive");
    expect(result.evaluation.trace.some((s) => s.rule === "confirm-destructive")).toBe(true);
  });

  it("flags a model gate that runs before this policy instead of pretending it doesn't exist", () => {
    const cfg = config({ arbiter: { enabled: true, model: "guard-model" } });
    const result = explainCall(cfg, TOOLS, { tool: "bash", args: { command: "ls" } });
    expect(result.brainArbiterModel).toBe("guard-model");
    expect(formatExplanation(result)).toMatch(/runs BEFORE this policy/);
  });

  it("omits the model-gate note when the arbiter is disabled", () => {
    const cfg = config({ arbiter: { enabled: false, model: "guard-model" } });
    const result = explainCall(cfg, TOOLS, { tool: "bash", args: { command: "ls" } });
    expect(result.brainArbiterModel).toBeUndefined();
  });
});

describe("formatExplanation", () => {
  it("leads with the outcome and marks the deciding rule", () => {
    const result = explainCall(config({ mode: "plan" }), TOOLS, { tool: "write_file", args: {} });
    const text = formatExplanation(result);
    expect(text.split("\n")[0]).toContain("blocked");
    expect(text).toContain("plan mode is read-only");
    // Exactly one step is marked as the decider.
    expect(text.split("\n").filter((l) => l.trim().startsWith("▸"))).toHaveLength(1);
  });

  it("shows the inputs the policy saw", () => {
    const text = formatExplanation(
      explainCall(config({ mode: "auto" }), TOOLS, { tool: "bash", args: { command: "ls" } }),
    );
    expect(text).toMatch(/mode: auto/);
    expect(text).toMatch(/category: execute/);
  });
});

describe("collectTools honours the session's tier", () => {
  // Both inspectors exist to describe the policy a session actually runs, and
  // the roster is half of that. Pinned to `standard`, the table hid `install`
  // from a `full` session and invented rows a `minimal` one does not have.
  const withTier = (tier: "minimal" | "standard" | "full") =>
    ({ ...defaultConfig(), tools: { tier } }) as ArtermConfig;

  it("lists only the minimal roster under tier minimal", async () => {
    const names = (await collectTools(withTier("minimal"), true)).map((e) => e.tool.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("git_commit");
    expect(names).not.toContain("install");
  });

  it("reaches the package tools only under tier full", async () => {
    const standard = (await collectTools(withTier("standard"), true)).map((e) => e.tool.name);
    const full = (await collectTools(withTier("full"), true)).map((e) => e.tool.name);
    expect(standard).toContain("typecheck");
    expect(standard).not.toContain("install");
    for (const name of ["install", "audit", "outdated", "logs"]) {
      expect(full, `${name} missing from the full roster`).toContain(name);
    }
  });
});
