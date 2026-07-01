import { describe, expect, it } from "vitest";
import { computeSavings, formatRow, renderLegend } from "./recall.js";
import type { LegendRow } from "./types.js";

const row = (over: Partial<LegendRow> = {}): LegendRow => ({
  id: 1,
  ts: 1_700_000_000_000,
  type: "bugfix",
  title: "a fix",
  readTokens: 20,
  ...over,
});

describe("computeSavings", () => {
  it("sums tokens and derives the reduction percent", () => {
    const s = computeSavings([
      { discoveryTokens: 100, readTokens: 20 },
      { discoveryTokens: 100, readTokens: 30 },
    ]);
    expect(s.discoveryTokens).toBe(200);
    expect(s.readTokens).toBe(50);
    expect(s.savingsPct).toBe(75);
  });

  it("guards divide-by-zero", () => {
    expect(computeSavings([]).savingsPct).toBe(0);
    expect(computeSavings([{ discoveryTokens: 0, readTokens: 0 }]).savingsPct).toBe(0);
  });

  it("never reports negative savings", () => {
    expect(computeSavings([{ discoveryTokens: 10, readTokens: 40 }]).savingsPct).toBe(0);
  });
});

describe("formatRow", () => {
  it("renders #id, icon, title and read tokens", () => {
    const r = formatRow(row({ id: 7, type: "feature", title: "add x", readTokens: 42 }));
    expect(r).toContain("#7");
    expect(r).toContain("🟣");
    expect(r).toContain("add x");
    expect(r).toContain("~42t");
  });
});

describe("renderLegend", () => {
  it("returns empty string for no rows", () => {
    expect(renderLegend([], computeSavings([]))).toBe("");
  });

  it("includes the legend header, rows and savings footer", () => {
    const rows = [row({ id: 1 }), row({ id: 2, type: "feature" })];
    const out = renderLegend(rows, computeSavings([{ discoveryTokens: 100, readTokens: 20 }]));
    expect(out).toContain("Legend:");
    expect(out).toContain("get_observations");
    expect(out).toContain("#1");
    expect(out).toContain("#2");
    expect(out).toContain("Saved ~80%");
    expect(out).toContain("2 observations");
  });
});
