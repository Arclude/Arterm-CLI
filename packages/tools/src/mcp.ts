import type { McpServerSummary, Tool } from "@arterm/core";

/** One stdio MCP server entry (mirrors the Claude Desktop / Claude Code format). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Invokes a remote MCP tool; injected so the adapter is unit-testable. */
export type McpCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content?: unknown; isError?: boolean }>;

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

interface Connection {
  close(): Promise<void>;
}

/**
 * Connects to configured MCP servers over stdio (via the official SDK, imported
 * lazily so the dependency isn't loaded when no servers are configured) and
 * exposes their tools as Arterm tools. Per-server failures are isolated.
 */
export class McpManager {
  private connections: Connection[] = [];
  private _summary: McpServerSummary[] = [];

  constructor(private readonly servers: Record<string, McpServerConfig> = {}) {}

  get summary(): McpServerSummary[] {
    return this._summary;
  }

  /** Connect to every configured server; returns all discovered tools. Never throws. */
  async connect(): Promise<Tool[]> {
    const entries = Object.entries(this.servers);
    if (entries.length === 0) return [];

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const tools: Tool[] = [];
    for (const [name, cfg] of entries) {
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        });
        const client = new Client({ name: "arterm-cli", version: "0.1.0" }, { capabilities: {} });
        await client.connect(transport);
        const listed = await client.listTools();
        const call: McpCall = (toolName, args) =>
          client.callTool({ name: toolName, arguments: args }) as Promise<{
            content?: unknown;
            isError?: boolean;
          }>;
        for (const def of listed.tools) {
          tools.push(mcpToolToArtermTool(name, def as McpToolDef, call));
        }
        this.connections.push({ close: () => client.close() });
        this._summary.push({ name, status: "connected", toolCount: listed.tools.length });
      } catch (err) {
        this._summary.push({
          name,
          status: "failed",
          toolCount: 0,
          error: (err as Error).message,
        });
      }
    }
    return tools;
  }

  /** Disconnect every server. Best-effort. */
  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.close()));
    this.connections = [];
  }
}
