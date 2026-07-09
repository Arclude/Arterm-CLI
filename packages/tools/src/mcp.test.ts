import { describe, expect, it, vi } from "vitest";
import {
  type McpClientLike,
  type McpConnectFn,
  McpManager,
  flattenMcpContent,
  mcpToolToArtermTool,
} from "./mcp.js";

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

describe("McpManager health checks", () => {
  function makeFakeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
    return {
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "t1" }] }),
      ping: vi.fn().mockResolvedValue({}),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("connect wraps discovered tools and records a connected summary", async () => {
    const client = makeFakeClient();
    const mgr = new McpManager({ srv: { command: "x" } }, async () => client);
    const tools = await mgr.connect();
    expect(tools.map((t) => t.name)).toEqual(["mcp__srv__t1"]);
    expect(mgr.summary).toEqual([{ name: "srv", status: "connected", toolCount: 1 }]);
  });

  it("check probes via ping and reports latency + tool count", async () => {
    const client = makeFakeClient();
    const mgr = new McpManager({ srv: { command: "x" } }, async () => client);
    await mgr.connect();
    const [res] = await mgr.check();
    expect(res?.ok).toBe(true);
    expect(res?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res?.toolCount).toBe(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    // listTools was only used by connect, not by the probe.
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  it("check falls back to listTools when the client lacks ping", async () => {
    const client = makeFakeClient({ ping: undefined });
    const mgr = new McpManager({ srv: { command: "x" } }, async () => client);
    await mgr.connect();
    const [res] = await mgr.check();
    expect(res?.ok).toBe(true);
    expect(client.listTools).toHaveBeenCalledTimes(2); // connect + probe
  });

  it("a failed probe flips the summary to failed and drops the client", async () => {
    const client = makeFakeClient({ ping: vi.fn().mockRejectedValue(new Error("gone")) });
    const mgr = new McpManager({ srv: { command: "x" } }, async () => client);
    await mgr.connect();
    const ref = mgr.summary;
    const [res] = await mgr.check();
    expect(res).toEqual({ name: "srv", ok: false, error: "gone" });
    expect(client.close).toHaveBeenCalled();
    // The summary array identity is preserved (the session holds a reference)…
    expect(mgr.summary).toBe(ref);
    // …but its entry now reflects the dead server.
    expect(mgr.summary[0]).toEqual({ name: "srv", status: "failed", toolCount: 0, error: "gone" });
  });

  it("check reports a server that never connected with its connect error", async () => {
    const mgr = new McpManager({ srv: { command: "x" } }, async () => {
      throw new Error("spawn nope");
    });
    await mgr.connect();
    const [res] = await mgr.check();
    expect(res).toEqual({ name: "srv", ok: false, error: "spawn nope" });
  });

  it("reconnect retries only unhealthy servers and returns their tools", async () => {
    let badAttempts = 0;
    const goodConnects = vi.fn();
    const goodClient = makeFakeClient();
    const connectFn: McpConnectFn = async (name) => {
      if (name === "good") {
        goodConnects();
        return goodClient;
      }
      badAttempts += 1;
      if (badAttempts === 1) throw new Error("first time fails");
      return makeFakeClient({
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "b1" }] }),
      });
    };
    const mgr = new McpManager({ good: { command: "g" }, bad: { command: "b" } }, connectFn);
    await mgr.connect();
    expect(mgr.summary.find((s) => s.name === "bad")?.status).toBe("failed");

    const tools = await mgr.reconnect();
    expect(tools.map((t) => t.name)).toEqual(["mcp__bad__b1"]);
    expect(mgr.summary.find((s) => s.name === "bad")?.status).toBe("connected");
    expect(goodConnects).toHaveBeenCalledTimes(1); // healthy server untouched
    expect(goodClient.close).not.toHaveBeenCalled();
  });

  it("close disconnects every client and clears the map", async () => {
    const client = makeFakeClient();
    const mgr = new McpManager({ srv: { command: "x" } }, async () => client);
    await mgr.connect();
    await mgr.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    const [res] = await mgr.check();
    expect(res).toEqual({ name: "srv", ok: false, error: "not connected" });
  });
});
