import { describe, expect, it } from "vitest";
import { defaultTools, tierCost, toolSchemaTokens } from "./registry.js";

const names = (tier: Parameters<typeof defaultTools>[0]) => defaultTools(tier).map((t) => t.name);

describe("tool tiers", () => {
  it("defaults to standard", () => {
    expect(names(undefined)).toEqual(names("standard"));
  });

  it("nests: every tier contains the one below it", () => {
    // A tier that dropped a tool the smaller tier had would mean a model gets
    // FEWER capabilities by asking for more.
    for (const name of names("minimal")) expect(names("standard")).toContain(name);
    for (const name of names("standard")) expect(names("full")).toContain(name);
  });

  it("keeps read, change and run at every tier", () => {
    // Whatever else is trimmed, the tier has to be able to do the job.
    for (const tier of ["minimal", "standard", "full"] as const) {
      for (const need of ["read", "write", "edit", "bash", "grep", "glob"]) {
        expect(names(tier), `${need} at ${tier}`).toContain(need);
      }
    }
  });

  it("holds the meta-tools back to the largest roster", () => {
    // `tool_search` and `batch` describe or dispatch OTHER tools: on a six-tool
    // roster they cost more schema than they can save.
    expect(names("minimal")).not.toContain("tool_search");
    expect(names("standard")).not.toContain("tool_search");
    expect(names("full")).toContain("tool_search");
  });

  it("registers no tool twice", () => {
    const full = names("full");
    expect(new Set(full).size).toBe(full.length);
  });
});

describe("roster cost", () => {
  it("is measured, not asserted", () => {
    // The tiers exist to save tokens; a claim about how many is worth nothing
    // without the measurement behind it, which is what `arterm tools cost`
    // prints.
    const minimal = tierCost("minimal");
    const standard = tierCost("standard");
    const full = tierCost("full");
    expect(minimal.total).toBeGreaterThan(0);
    expect(standard.total).toBeGreaterThan(minimal.total);
    expect(full.total).toBeGreaterThan(standard.total);
  });

  it("counts what actually goes on the wire, and not the usage hint", () => {
    // `usageHint` is delivered on a failed call, not with the roster — counting
    // it here would overstate the roster and understate the saving.
    const grep = defaultTools("full").find((t) => t.name === "grep");
    expect(grep?.usageHint, "grep should carry a hint to make this meaningful").toBeTruthy();
    const withHint = toolSchemaTokens({
      ...(grep as NonNullable<typeof grep>),
      usageHint: "x".repeat(4000),
    });
    expect(withHint).toBe(toolSchemaTokens(grep as NonNullable<typeof grep>));
  });

  it("ranks the expensive tools first, so the list answers 'what should I cut'", () => {
    const { tools } = tierCost("full");
    for (let i = 1; i < tools.length; i++) {
      expect((tools[i - 1] as { tokens: number }).tokens).toBeGreaterThanOrEqual(
        (tools[i] as { tokens: number }).tokens,
      );
    }
  });
});
