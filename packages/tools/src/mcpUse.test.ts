import { describe, expect, it, vi } from "vitest";
import type { McpClientLike, McpConnectFn } from "./mcp.js";
import { createMcpUseTool } from "./mcpUse.js";

function fakeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: "search", description: "Search the docs" }, { name: "fetch" }],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "answer" }] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SERVERS = {
  docs: { command: "npx", args: ["-y", "docs-mcp"] },
  sql: { command: "mcp-sql" },
};

describe("mcp_use listing", () => {
  it("lists the configured servers without connecting to any of them", async () => {
    const connect = vi.fn<McpConnectFn>();
    const tool = createMcpUseTool({ servers: SERVERS, connect });
    const res = await tool.execute({}, { cwd: "." });
    expect(connect).not.toHaveBeenCalled();
    expect(res.output).toContain("2 MCP server(s) configured");
    expect(res.output).toContain("docs — npx -y docs-mcp");
    expect(res.output).toContain("sql — mcp-sql");
    expect(res.isError).toBeUndefined();
  });

  it("says so when nothing is configured", async () => {
    const tool = createMcpUseTool({ servers: {} });
    const res = await tool.execute({}, { cwd: "." });
    expect(res.output).toContain("No MCP servers are configured");
  });

  it("marks a server the session already connected", async () => {
    const tool = createMcpUseTool({ servers: SERVERS, isConnected: (n) => n === "sql" });
    const res = await tool.execute({}, { cwd: "." });
    expect(res.output).toContain("sql — mcp-sql  [already connected]");
    expect(res.output).not.toContain("docs — npx -y docs-mcp  [already");
  });

  it("lists one server's tools and disconnects again", async () => {
    const client = fakeClient();
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.output).toContain('"docs" exposes 2 tool(s)');
    expect(res.output).toContain("search — Search the docs");
    expect(res.output).toContain("fetch");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("clips a long remote description so the listing stays cheap", async () => {
    const client = fakeClient({
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ name: "t", description: "x".repeat(400) }] }),
    });
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.output).toContain("…");
    expect(res.output.length).toBeLessThan(400);
  });

  it("rejects an unknown server by name and names the ones that exist", async () => {
    const connect = vi.fn<McpConnectFn>();
    const tool = createMcpUseTool({ servers: SERVERS, connect });
    const res = await tool.execute({ server: "nope" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("docs, sql");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("mcp_use calling", () => {
  it("calls the named tool with its arguments and flattens the result", async () => {
    const client = fakeClient();
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute(
      { server: "docs", tool: "search", arguments: { q: "ink" } },
      { cwd: "." },
    );
    expect(client.callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "ink" } });
    expect(res.output).toBe("answer");
    expect(res.isError).toBe(false);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("defaults missing arguments to an empty object", async () => {
    const client = fakeClient();
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    await tool.execute({ server: "docs", tool: "search" }, { cwd: "." });
    expect(client.callTool).toHaveBeenCalledWith({ name: "search", arguments: {} });
  });

  it("refuses non-object arguments before starting anything", async () => {
    const connect = vi.fn<McpConnectFn>();
    const tool = createMcpUseTool({ servers: SERVERS, connect });
    for (const bad of ["a string", 7, ["an", "array"]]) {
      const res = await tool.execute({ server: "docs", tool: "t", arguments: bad }, { cwd: "." });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("`arguments` must be an object");
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("surfaces isError from the remote result", async () => {
    const client = fakeClient({
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "no" }], isError: true }),
    });
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute({ server: "docs", tool: "search" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("no");
  });

  it("reports an empty result rather than empty output", async () => {
    const client = fakeClient({ callTool: vi.fn().mockResolvedValue({ content: [] }) });
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute({ server: "docs", tool: "search" }, { cwd: "." });
    expect(res.output).toBe("(no output)");
  });

  it("redirects to the roster instead of starting a second copy of a connected server", async () => {
    const connect = vi.fn<McpConnectFn>();
    const tool = createMcpUseTool({ servers: SERVERS, connect, isConnected: () => true });
    const res = await tool.execute({ server: "docs", tool: "search" }, { cwd: "." });
    expect(connect).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.output).toContain("mcp__docs__*");
  });

  it("does not call a connected server an error when only listing", async () => {
    const tool = createMcpUseTool({ servers: SERVERS, isConnected: () => true });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.isError).toBe(false);
  });
});

describe("mcp_use failure handling", () => {
  it("turns a failed connection into an error result, never a throw", async () => {
    const tool = createMcpUseTool({
      servers: SERVERS,
      connect: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("spawn ENOENT");
  });

  it("closes the server even when the call throws", async () => {
    const client = fakeClient({
      callTool: vi.fn().mockRejectedValue(new Error("broken pipe")),
    });
    const tool = createMcpUseTool({ servers: SERVERS, connect: async () => client });
    const res = await tool.execute({ server: "docs", tool: "search" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("broken pipe");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("gives up on a server that never finishes starting", async () => {
    const tool = createMcpUseTool({
      servers: SERVERS,
      timeoutMs: 20,
      connect: () => new Promise<McpClientLike>(() => {}),
    });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("timed out after 20ms");
  });

  it("closes a client that finishes connecting after the deadline", async () => {
    const client = fakeClient();
    const tool = createMcpUseTool({
      servers: SERVERS,
      timeoutMs: 10,
      connect: () => new Promise<McpClientLike>((resolve) => setTimeout(() => resolve(client), 40)),
    });
    const res = await tool.execute({ server: "docs" }, { cwd: "." });
    expect(res.isError).toBe(true);
    // The late arrival is still ours to shut down — otherwise the timeout leaks
    // the very process this tool exists to keep from running.
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
  });

  it("stops waiting when the run is cancelled", async () => {
    const controller = new AbortController();
    const tool = createMcpUseTool({
      servers: SERVERS,
      timeoutMs: 60_000,
      connect: () => new Promise<McpClientLike>(() => {}),
    });
    const pending = tool.execute({ server: "docs" }, { cwd: ".", signal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(res.output).toContain("cancelled while connecting");
  });
});

describe("mcp_use metadata", () => {
  const tool = createMcpUseTool({ servers: SERVERS });

  it("prompts, because one call stands in for every remote tool", () => {
    expect(tool.permission).toBe("ask");
    expect(tool.category).toBe("execute");
    expect(tool.mutating).toBe(true);
  });

  it("previews what is actually being approved, not just the tool name", () => {
    expect(tool.preview?.({ server: "docs", tool: "search" })).toBe("mcp_use docs/search");
    expect(tool.preview?.({ server: "docs" })).toContain("docs");
    expect(tool.preview?.({})).toContain("list configured servers");
  });
});
