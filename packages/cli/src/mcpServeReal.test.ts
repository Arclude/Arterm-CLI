import { defaultTools } from "@arterm/tools";
import { describe, expect, it } from "vitest";
import { decidePublication, publishableTools } from "./mcpServe.js";

/**
 * The filter, run over the REAL roster rather than a fixture.
 *
 * `mcpServe.test.ts` proves the rule with tools it constructed; this proves it
 * about the tools we actually ship. The two are not the same claim — a filter
 * can be right about its own examples and wrong about `bash`.
 */
describe("nothing dangerous escapes onto the MCP surface", () => {
  const all = defaultTools("full");

  it("publishes no destructive tool, with or without --writable", () => {
    for (const writable of [false, true]) {
      const published = publishableTools(all, writable);
      const leaked = published.filter((t) => t.riskTier === "destructive");
      expect(
        leaked.map((t) => t.name),
        `writable=${writable}`,
      ).toEqual([]);
    }
  });

  it("keeps bash off the surface specifically", () => {
    expect(publishableTools(all, true).map((t) => t.name)).not.toContain("bash");
    expect(decidePublication(all.find((t) => t.name === "bash") as never, true).published).toBe(
      false,
    );
  });

  it("publishes read-only tools by default", () => {
    const names = publishableTools(all, false).map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    // Nothing that mutates, without the flag.
    expect(publishableTools(all, false).some((t) => t.mutating)).toBe(false);
  });

  it("--writable reaches the ask tools and only those", () => {
    const base = new Set(publishableTools(all, false).map((t) => t.name));
    const extra = publishableTools(all, true).filter((t) => !base.has(t.name));
    expect(extra.length).toBeGreaterThan(0);
    for (const t of extra) expect(t.permission, t.name).toBe("ask");
  });
});
