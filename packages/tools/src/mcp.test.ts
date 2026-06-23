import { describe, expect, it, vi } from "vitest";
import { McpManager, flattenMcpContent, mcpToolToArtermTool } from "./mcp.js";

describe("flattenMcpContent", () => {
  it("joins text items and labels non-text content", () => {
    expect(
      flattenMcpContent([
        { type: "text", text: "hello" },
        { type: "image", data: "..." },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\n[image content]\nworld");
  });

  it("returns empty string for non-array content", () => {
    expect(flattenMcpContent(undefined)).toBe("");
  });
});

describe("mcpToolToArtermTool", () => {
  const def = {
    name: "lookup",
    description: "look something up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };

  it("namespaces the tool name and passes through the schema", () => {
    const tool = mcpToolToArtermTool("docs", def, async () => ({}));
    expect(tool.name).toBe("mcp__docs__lookup");
    expect(tool.permission).toBe("ask");
    expect(tool.category).toBe("execute");
    expect(tool.parameters).toEqual(def.inputSchema);
  });

  it("calls the remote tool with the bare name + args and flattens the result", async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "answer" }] });
    const tool = mcpToolToArtermTool("docs", def, call);
    const res = await tool.execute({ q: "x" }, { cwd: "." });
    expect(call).toHaveBeenCalledWith("lookup", { q: "x" });
    expect(res.output).toBe("answer");
    expect(res.isError).toBe(false);
  });

  it("surfaces isError from the MCP result", async () => {
    const tool = mcpToolToArtermTool("docs", def, async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));
    const res = await tool.execute({}, { cwd: "." });
    expect(res.isError).toBe(true);
  });

  it("never throws — converts a rejected call into an error result", async () => {
    const tool = mcpToolToArtermTool("docs", def, async () => {
      throw new Error("disconnected");
    });
    const res = await tool.execute({}, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("disconnected");
  });

  it("defaults the schema when inputSchema is missing", () => {
    const tool = mcpToolToArtermTool("s", { name: "t" }, async () => ({}));
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("McpManager", () => {
  it("returns no tools and does not load the SDK when no servers are configured", async () => {
    const mgr = new McpManager({});
    expect(await mgr.connect()).toEqual([]);
    expect(mgr.summary).toEqual([]);
  });
});
