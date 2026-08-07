import type { Tool } from "@arterm/core";
import {
  type McpClientLike,
  type McpConnectFn,
  type McpServerConfig,
  type McpToolDef,
  flattenMcpContent,
} from "./mcp.js";
import { optionalString } from "./paths.js";

/**
 * `mcp_use` — reach a configured MCP server without keeping it running.
 *
 * `McpManager.connect()` starts EVERY configured server at session boot and
 * folds every server's whole tool roster into the agent's own. Both halves are
 * paid on every request: six configured servers are six child processes for the
 * session's lifetime, and their schemas are re-sent every turn whether or not
 * anything calls them. A server configured "just in case" is the common case,
 * so the tax is usually paid for nothing.
 *
 * This is the lazy path: list what is configured (no connection), connect one
 * server on demand, call one tool, and disconnect. The cost of a server nobody
 * calls drops to one line of text.
 */

/** Ceiling for one wake → call → sleep round trip. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How much of a remote tool's description survives into a listing. */
const MAX_DESC = 200;

export interface McpUseOptions {
  /** Configured servers, exactly as `config.mcpServers` holds them. */
  servers: Record<string, McpServerConfig>;
  /** Injected for tests; defaults to a stdio connection via the official SDK. */
  connect?: McpConnectFn;
  /**
   * Whether the session already holds an eager connection to this server. When
   * it does, `mcp_use` refuses rather than connecting: a second connection is a
   * second child process for a server whose tools are already on the roster,
   * which is the opposite of what this tool is for.
   */
  isConnected?: (server: string) => boolean;
  timeoutMs?: number;
}

/**
 * Connect one server over stdio via the official SDK, imported lazily so a
 * session that never calls this tool never loads it.
 *
 * This duplicates `mcp.ts`'s `sdkConnect`, which is private to that module.
 * Exporting that one and passing it as `connect` is the right consolidation;
 * the copy is here so the tool has a working default, because a tool whose only
 * connector must be injected by the session cannot be used from a sub-agent or
 * a standalone call.
 */
async function stdioConnect(_name: string, cfg: McpServerConfig): Promise<McpClientLike> {
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

interface Deadline {
  promise: Promise<never>;
  /** True once the deadline fired — a result that arrives later is nobody's but ours. */
  expired: () => boolean;
  dispose: () => void;
}

/** A promise that rejects on timeout or cancellation, plus the cleanup that stops it. */
function deadline(ms: number, what: string, signal?: AbortSignal): Deadline {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`timed out after ${ms}ms ${what}`));
    }, ms);
    if (!signal) return;
    onAbort = () => {
      expired = true;
      reject(new Error(`cancelled while ${what}`));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Race one step against its deadline, always releasing the timer afterwards. */
async function within<T>(work: Promise<T>, d: Deadline): Promise<T> {
  try {
    return await Promise.race([work, d.promise]);
  } finally {
    d.dispose();
  }
}

/**
 * Connect, honouring the deadline — and close a client that arrives after it.
 *
 * A racing timeout that only rejects leaks the process it started: the
 * transport keeps spawning, wins a second later, and nothing is left holding a
 * reference to close it. A woken server that never goes back to sleep is worse
 * than one connected at boot, because at least the boot ones are tracked.
 */
async function connectWithin(
  connect: McpConnectFn,
  name: string,
  cfg: McpServerConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<McpClientLike> {
  const d = deadline(timeoutMs, `connecting to MCP server "${name}"`, signal);
  const attempt = connect(name, cfg).then((client) => {
    if (d.expired()) void client.close().catch(() => {});
    return client;
  });
  return within(attempt, d);
}

/** One line per configured server; nothing is started to produce it. */
function serverList(opts: McpUseOptions): string {
  const names = Object.keys(opts.servers);
  if (names.length === 0) {
    return "No MCP servers are configured (see `mcpServers` in ~/.arterm/config.json).";
  }
  const lines = names.map((name) => {
    const cfg = opts.servers[name];
    const command = [cfg?.command ?? "", ...(cfg?.args ?? [])].join(" ").trim();
    const running = opts.isConnected?.(name) ? "  [already connected]" : "";
    return `  ${name} — ${command}${running}`;
  });
  return [
    `${names.length} MCP server(s) configured; none are started until you call one:`,
    ...lines,
    'Pass { "server": "<name>" } to see one server\'s tools.',
  ].join("\n");
}

/** One line per remote tool, with the description clipped to keep the listing cheap. */
function toolList(server: string, defs: McpToolDef[]): string {
  if (defs.length === 0) return `"${server}" exposes no tools.`;
  const lines = defs.map((def) => {
    const desc = (def.description ?? "").replace(/\s+/g, " ").trim();
    const clipped = desc.length > MAX_DESC ? `${desc.slice(0, MAX_DESC)}…` : desc;
    return `  ${def.name}${clipped ? ` — ${clipped}` : ""}`;
  });
  return [
    `"${server}" exposes ${defs.length} tool(s):`,
    ...lines,
    `Pass { "server": "${server}", "tool": "<name>", "arguments": {…} } to call one.`,
  ].join("\n");
}

/**
 * Build the `mcp_use` tool over a set of configured servers.
 *
 * The permission prompt is the reason `preview` names the server AND the tool:
 * one dispatching tool stands in for every tool on every configured server, so
 * "allow mcp_use" read on its own is a blanket approval of all of them. What
 * the human is actually approving has to be on the line they read.
 */
export function createMcpUseTool(opts: McpUseOptions): Tool {
  const connect = opts.connect ?? stdioConnect;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "mcp_use",
    maxOutputBytes: 65_536,
    description:
      "Call a tool on a configured MCP server without keeping that server running. " +
      "Omit everything to list the configured servers, pass `server` alone to list that " +
      "server's tools, and pass `server` + `tool` + `arguments` to call one. The server is " +
      "started for the call and shut down straight after.",
    usageHint:
      "Servers listed here are NOT connected, so their tools are not on your roster — that is " +
      "the point: a server nobody calls costs one line instead of a process and a schema per " +
      "turn. Explore in two steps (list the servers, then list one server's tools) rather than " +
      "guessing a tool name, since each guess pays a full start-up. Tools already on your " +
      "roster as `mcp__<server>__<tool>` belong to a connected server; call those directly.",
    permission: "ask",
    category: "execute",
    mutating: true,
    // "caution", not "destructive": the tool itself destroys nothing, and the
    // remote tools it dispatches to are exactly the ones a connected server
    // would have put on the roster at "ask" anyway. Tagging it destructive
    // would claim this path is riskier than the eager one it replaces.
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Configured server name; omit to list the configured servers.",
        },
        tool: {
          type: "string",
          description: "Tool to call on that server; omit to list the server's tools.",
        },
        arguments: {
          type: "object",
          description: "Arguments for the remote tool.",
        },
      },
    },
    preview: (args) => {
      const server = optionalString(args, "server");
      if (!server) return "mcp_use (list configured servers)";
      const tool = optionalString(args, "tool");
      return tool ? `mcp_use ${server}/${tool}` : `mcp_use ${server} (list tools)`;
    },
    async execute(args, ctx) {
      const server = optionalString(args, "server");
      if (!server) return { output: serverList(opts) };

      const cfg = opts.servers[server];
      if (!cfg) {
        const known = Object.keys(opts.servers);
        const suffix = known.length ? `configured: ${known.join(", ")}` : "none are configured";
        return { output: `Unknown MCP server "${server}" — ${suffix}.`, isError: true };
      }

      const tool = optionalString(args, "tool");
      if (opts.isConnected?.(server)) {
        return {
          output: [
            `"${server}" is already connected — its tools are on your roster as mcp__${server}__*.`,
            "Call the one you want directly; going through mcp_use would start a second copy.",
          ].join(" "),
          isError: tool !== undefined,
        };
      }

      const rawArgs = args.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
        return { output: "`arguments` must be an object.", isError: true };
      }
      if (Array.isArray(rawArgs)) {
        return { output: "`arguments` must be an object, not an array.", isError: true };
      }

      let client: McpClientLike | undefined;
      try {
        client = await connectWithin(connect, server, cfg, timeoutMs, ctx.signal);
        if (!tool) {
          const listed = await within(
            client.listTools({ timeout: timeoutMs }),
            deadline(timeoutMs, `listing tools on "${server}"`, ctx.signal),
          );
          return { output: toolList(server, listed.tools) };
        }
        const res = await within(
          client.callTool({ name: tool, arguments: (rawArgs as Record<string, unknown>) ?? {} }),
          deadline(timeoutMs, `calling ${server}/${tool}`, ctx.signal),
        );
        return {
          output: flattenMcpContent(res.content) || "(no output)",
          isError: res.isError ?? false,
        };
      } catch (err) {
        return { output: `MCP error (${server}): ${(err as Error).message}`, isError: true };
      } finally {
        // The whole promise of this tool: the server goes back to sleep whether
        // the call worked, failed, timed out, or was cancelled mid-flight.
        await client?.close().catch(() => {});
      }
    },
  };
}
