import type { McpServerSummary } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { connectedLines, formatMcpView, publishedServers } from "./mcpView.js";

describe("publishedServers", () => {
  it("names the memory server and the tools server", () => {
    const commands = publishedServers({}).map((s) => s.command);
    expect(commands).toEqual(["arterm mcp", "arterm mcp serve"]);
  });

  it("says which memory engine is actually behind it", () => {
    expect(publishedServers({ memoryEngine: "cmem" })[0]?.detail).toContain("cmem");
    expect(publishedServers({ memoryEngine: "jsonl" })[0]?.detail).toContain("jsonl");
  });

  it("omits the memory server when memory is off — it would publish nothing", () => {
    const commands = publishedServers({ memoryEngine: "off" }).map((s) => s.command);
    expect(commands).toEqual(["arterm mcp serve"]);
  });

  it("states the tools server's default is read-only", () => {
    const serve = publishedServers({}).find((s) => s.command === "arterm mcp serve");
    expect(serve?.detail).toContain("read-only");
    expect(serve?.detail).toContain("never the destructive");
  });
});

describe("formatMcpView", () => {
  const view = (connected: McpServerSummary[] = []) =>
    formatMcpView({ connected, published: publishedServers({ memoryEngine: "cmem" }) });

  it("shows what we PUBLISH even when we connect to nothing", () => {
    // The bug this fixes: `/mcp` returned "no MCP servers configured" on a
    // fresh install, while the same binary shipped two servers of its own.
    const out = view();
    expect(out).toContain("none configured");
    expect(out).toContain("arterm mcp serve");
    expect(out).toContain("PUBLISHES");
  });

  it("keeps the two directions apart in words, not just in layout", () => {
    const out = view();
    expect(out).toContain("CONNECTS to");
    expect(out).toContain("PUBLISHES");
  });

  it("gives the snippet another client needs, and says whose config it goes in", () => {
    const out = view();
    expect(out).toContain('"command": "arterm"');
    expect(out).toContain('"args": ["mcp"]');
    expect(out).toContain("ITS config");
  });

  it("says why Arterm does not connect to its own servers", () => {
    // Otherwise the obvious next move is to paste that snippet into
    // ~/.arterm/config.json and spawn a child process to reach memory that
    // `memory_search` already answers in-process.
    expect(view()).toContain("does not connect to its own");
  });

  it("lists connected servers with their tool counts", () => {
    const out = view([{ name: "github", status: "connected", toolCount: 12 }]);
    expect(out).toContain("✓ github — 12 tool(s)");
    expect(out).not.toContain("none configured");
  });

  it("shows a failed server's reason rather than hiding it", () => {
    const out = view([{ name: "broken", status: "failed", toolCount: 0, error: "spawn ENOENT" }]);
    expect(out).toContain("✗ broken — spawn ENOENT");
  });
});

describe("connectedLines", () => {
  it("marks connected and failed differently", () => {
    const lines = connectedLines([
      { name: "a", status: "connected", toolCount: 3 },
      { name: "b", status: "failed", toolCount: 0 },
    ]);
    expect(lines[0]).toContain("✓");
    expect(lines[1]).toContain("✗");
  });
});
