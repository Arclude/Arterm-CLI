import type { McpCheckResult, McpServerSummary, Tool } from "@arterm/core";

/** One stdio MCP server entry (mirrors the Claude Desktop / Claude Code format). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Invokes a remote MCP tool; injected so the adapter is unit-testable. */
export type McpCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content?: unknown; isError?: boolean }>;

/** The slice of the SDK client the manager needs; injectable so health checks are testable. */
export interface McpClientLike {
  listTools(options?: { timeout?: number }): Promise<{ tools: McpToolDef[] }>;
  ping?(options?: { timeout?: number }): Promise<unknown>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

/** Creates a connected client for one server; the default uses the official SDK over stdio. */
export type McpConnectFn = (name: string, cfg: McpServerConfig) => Promise<McpClientLike>;

/** How long a liveness probe may take before the server is considered dead. */
const PROBE_TIMEOUT_MS = 5_000;

/** Flattens an MCP tool result's content array into plain text. */
export function flattenMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const item = entry as { type?: string; text?: unknown; resource?: { uri?: string } };
      if (item.type === "text") return String(item.text ?? "");
      if (item.type === "image") return "[image content]";
      if (item.type === "resource") return `[resource ${item.resource?.uri ?? ""}]`;
      return `[${item.type ?? "unknown"} content]`;
    })
    .join("\n");
}

/**
 * Wraps a single MCP tool as an Arterm `Tool`. The tool name is namespaced
 * (`mcp__<server>__<tool>`) to avoid collisions; permission defaults to "ask"
 * and category "execute" since external tools can do anything.
 */
export function mcpToolToArtermTool(server: string, def: McpToolDef, call: McpCall): Tool {
  const schema =
    def.inputSchema && typeof def.inputSchema === "object"
      ? def.inputSchema
      : { type: "object", properties: {} };
  return {
    name: `mcp__${server}__${def.name}`,
    description: `[MCP:${server}] ${def.description ?? def.name}`,
    parameters: schema,
    permission: "ask",
    category: "execute",
    mutating: true,
    preview: () => `mcp ${server}/${def.name}`,
    async execute(args) {
      try {
        const res = await call(def.name, args);
        return {
          output: flattenMcpContent(res.content) || "(no output)",
          isError: res.isError ?? false,
        };
      } catch (err) {
        return { output: `MCP tool error: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** Connects one server via the official SDK over stdio (imported lazily so it stays optional). */
async function sdkConnect(_name: string, cfg: McpServerConfig): Promise<McpClientLike> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
  });
  const client = new Client({ name: "arterm-cli", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    listTools: (options) =>
      client.listTools(undefined, options) as Promise<{ tools: McpToolDef[] }>,
    ping: (options) => client.ping(options),
    callTool: (params) =>
      client.callTool(params) as Promise<{ content?: unknown; isError?: boolean }>,
    close: () => client.close(),
  };
}

/**
 * Connects to configured MCP servers over stdio (via the official SDK, imported
 * lazily so the dependency isn't loaded when no servers are configured) and
 * exposes their tools as Arterm tools. Per-server failures are isolated.
 */
export class McpManager {
  private clients = new Map<string, McpClientLike>();
  private _summary: McpServerSummary[] = [];
  private readonly connectFn: McpConnectFn;

  constructor(
    private readonly servers: Record<string, McpServerConfig> = {},
    connectFn?: McpConnectFn,
  ) {
    this.connectFn = connectFn ?? sdkConnect;
  }

  get summary(): McpServerSummary[] {
    return this._summary;
  }

  /** Replace the named summary entry in place — the session holds this array by reference. */
  private upsertSummary(entry: McpServerSummary): void {
    const idx = this._summary.findIndex((s) => s.name === entry.name);
    if (idx >= 0) this._summary[idx] = entry;
    else this._summary.push(entry);
  }

  /** Drop and best-effort close the named client, if any. */
  private async dropClient(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    this.clients.delete(name);
    await client.close().catch(() => {});
  }

  /** Connect one server, record its summary, and return its wrapped tools. Never throws. */
  private async connectOne(name: string, cfg: McpServerConfig): Promise<Tool[]> {
    try {
      const client = await this.connectFn(name, cfg);
      const listed = await client.listTools();
      const call: McpCall = (toolName, args) =>
        client.callTool({ name: toolName, arguments: args });
      this.clients.set(name, client);
      this.upsertSummary({ name, status: "connected", toolCount: listed.tools.length });
      return listed.tools.map((def) => mcpToolToArtermTool(name, def, call));
    } catch (err) {
      await this.dropClient(name);
      this.upsertSummary({ name, status: "failed", toolCount: 0, error: (err as Error).message });
      return [];
    }
  }

  /** Connect to every configured server; returns all discovered tools. Never throws. */
  async connect(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [name, cfg] of Object.entries(this.servers)) {
      tools.push(...(await this.connectOne(name, cfg)));
    }
    return tools;
  }

  /**
   * Probe every configured server for liveness (ping, or listTools when the client
   * lacks ping) and measure round-trip latency. A failed probe flips the server's
   * summary to "failed" and drops the dead client so a later reconnect retries it.
   * Never throws.
   */
  async check(): Promise<McpCheckResult[]> {
    const results: McpCheckResult[] = [];
    for (const name of Object.keys(this.servers)) {
      const client = this.clients.get(name);
      const summaryEntry = this._summary.find((s) => s.name === name);
      if (!client) {
        results.push({ name, ok: false, error: summaryEntry?.error ?? "not connected" });
        continue;
      }
      const start = performance.now();
      try {
        if (client.ping) await client.ping({ timeout: PROBE_TIMEOUT_MS });
        else await client.listTools({ timeout: PROBE_TIMEOUT_MS });
        results.push({
          name,
          ok: true,
          latencyMs: Math.round(performance.now() - start),
          toolCount: summaryEntry?.toolCount,
        });
      } catch (err) {
        const message = (err as Error).message;
        results.push({ name, ok: false, error: message });
        await this.dropClient(name);
        this.upsertSummary({ name, status: "failed", toolCount: 0, error: message });
      }
    }
    return results;
  }

  /**
   * Retry servers without a healthy connection (failed at startup or died since);
   * connected servers are untouched. Retries the constructor-time server set only —
   * config-file edits require a restart. Returns the newly discovered tools. Never throws.
   */
  async reconnect(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [name, cfg] of Object.entries(this.servers)) {
      const summaryEntry = this._summary.find((s) => s.name === name);
      if (this.clients.has(name) && summaryEntry?.status === "connected") continue;
      await this.dropClient(name);
      tools.push(...(await this.connectOne(name, cfg)));
    }
    return tools;
  }

  /** Disconnect every server. Best-effort. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
