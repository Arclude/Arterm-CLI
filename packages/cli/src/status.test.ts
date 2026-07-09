import { describe, expect, it } from "vitest";
import { type StatusReport, formatStatusText, hasFailures } from "./status.js";

const healthy: StatusReport = {
  mcp: [{ name: "docs", ok: true, latencyMs: 12, toolCount: 5 }],
  plugins: [{ name: "alpha", ok: true, toolCount: 3 }],
};

const mixed: StatusReport = {
  mcp: [
    { name: "docs", ok: true, latencyMs: 12, toolCount: 5 },
    { name: "broken", ok: false, error: "spawn nope ENOENT" },
  ],
  plugins: [{ name: "beta", ok: false, error: 'plugin.json is missing a string "name"' }],
};

describe("hasFailures", () => {
  it("is false when every server and plugin is healthy", () => {
    expect(hasFailures(healthy)).toBe(false);
  });

  it("is true when any MCP server or plugin failed", () => {
    expect(hasFailures(mixed)).toBe(true);
    expect(hasFailures({ mcp: [], plugins: mixed.plugins })).toBe(true);
    expect(hasFailures({ mcp: mixed.mcp, plugins: [] })).toBe(true);
  });

  it("is false for an empty report", () => {
    expect(hasFailures({ mcp: [], plugins: [] })).toBe(false);
  });
});

describe("formatStatusText", () => {
  it("renders ✓ lines with latency and tool counts", () => {
    const text = formatStatusText(healthy);
    expect(text).toContain("MCP servers:");
    expect(text).toContain("  ✓ docs — 12ms · 5 tool(s)");
    expect(text).toContain("Plugins:");
    expect(text).toContain("  ✓ alpha — 3 tool(s)");
  });

  it("renders ✗ lines with the error message", () => {
    const text = formatStatusText(mixed);
    expect(text).toContain("  ✗ broken — spawn nope ENOENT");
    expect(text).toContain('  ✗ beta — plugin.json is missing a string "name"');
  });

  it("shows empty-state lines when nothing is configured", () => {
    const text = formatStatusText({ mcp: [], plugins: [] });
    expect(text).toContain("  (none configured)");
    expect(text).toContain("  (none installed)");
  });
});
