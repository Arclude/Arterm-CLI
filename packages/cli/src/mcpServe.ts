import { DEFAULT_MAX_OUTPUT_BYTES, type Tool, type ToolContext, clampMiddle } from "@arterm/core";
import { type ToolTier, defaultTools } from "@arterm/tools";
import { ArtermUserError } from "./errors.js";

/**
 * `arterm mcp serve` — expose Arterm's own tool set over MCP, so another client
 * (Claude Code, another Arterm, an editor) can read and search a project with
 * the tools this agent uses. The mirror image of `mcp.ts`: there we are the MCP
 * client, here we are the server. `mcpMemoryServer.ts` does the same for memory.
 *
 * WHAT MAY BE PUBLISHED — the whole point of this file.
 *
 * The published surface is READ-ONLY by default. `--writable` additionally
 * publishes tools whose permission is "ask". Tools tagged
 * `riskTier: "destructive"` are NEVER published, under any flag.
 *
 * The reason is that MCP has no inline approval surface. A tool published here
 * runs with nothing in front of it: the permission ladder that makes "ask" safe
 * — the prompt a human answers, the arbiter screening the arguments, the
 * session's mode — lives on our side of this socket and does not cross it.
 * `permission: "ask"` locally means "a human confirms each call"; published, it
 * would mean "whatever connected does it, silently". Those are not the same
 * claim. `--writable` is an operator accepting that trade for the "ask" tools.
 * Nobody gets to accept it on their behalf for `bash`, `replace` or `install`,
 * which is why the destructive check is above the flag rather than under it.
 */

/**
 * Tools that reach tool surfaces this filter cannot see, and so are never
 * published whatever their permission says.
 *
 * `mcp_use` connects to any server in `mcpServers` and calls anything on it.
 * Published, one "ask" tool would hand a remote client every MCP server
 * configured on this machine — including ones holding credentials this filter
 * knows nothing about. `batch` is the same shape and is handled instead by
 * scoping its roster (see {@link createToolDispatcher}); that trick does not
 * work here, because what `mcp_use` reaches is not a roster.
 */
const NEVER_PUBLISHED = new Set(["mcp_use"]);

/** How a tool is classified for publication, independent of any flag. */
export type PublicationKind =
  /** Never mutates and never prompts — the default surface. */
  | "read-only"
  /** Locally gated behind a human prompt; published only with `--writable`. */
  | "ask"
  /** `riskTier: "destructive"` — never published. */
  | "destructive"
  /** Dispatches to tool surfaces outside this filter's reach — never published. */
  | "proxy"
  /** `permission: "deny"` — forbidden locally, so never reachable from outside. */
  | "denied"
  /** Never prompts locally, but is not read-only either (e.g. `test` runs commands). */
  | "privileged";

export interface PublicationDecision {
  tool: string;
  kind: PublicationKind;
  published: boolean;
  /** Why, in words — this is what `--list` prints, so it has to stand alone. */
  reason: string;
}

/**
 * Classify one tool and decide whether this invocation publishes it.
 *
 * The order of the checks is the policy. `destructive` is tested before
 * anything else so no flag can reach past it, and `deny` before the positive
 * cases so a tool the local config forbids cannot be re-exposed through the
 * socket — publishing would otherwise be a way around an override the user set.
 *
 * The read-only test is three conditions, not one. "allow" alone is not
 * read-only: `test` is `permission: "allow"` because running the project's own
 * suite is routine for a local agent that has an arbiter and a sandbox behind
 * it — but it executes package scripts, and over MCP neither of those is there.
 * `category: "read"` alone is not enough either, since a tool can be classed
 * read and still record something, so `mutating` has to be absent too.
 */
export function decidePublication(tool: Tool, writable: boolean): PublicationDecision {
  const at = (kind: PublicationKind, published: boolean, reason: string): PublicationDecision => ({
    tool: tool.name,
    kind,
    published,
    reason,
  });

  if (tool.riskTier === "destructive") {
    return at("destructive", false, "destructive — never published, with or without --writable");
  }
  if (NEVER_PUBLISHED.has(tool.name)) {
    return at("proxy", false, "reaches other servers' tools — never published");
  }
  if (tool.permission === "deny") {
    return at("denied", false, 'set to "deny" locally — MCP must not be the way around that');
  }
  if (tool.permission === "allow" && tool.category === "read" && !tool.mutating) {
    return at("read-only", true, "read-only");
  }
  if (tool.permission === "ask") {
    return writable
      ? at("ask", true, "writes or runs things — published because --writable was passed")
      : at("ask", false, "writes or runs things — pass --writable to publish it");
  }
  return at(
    "privileged",
    false,
    `never prompts locally but is not read-only (category "${tool.category ?? "execute"}")`,
  );
}

/** Every decision for a roster, in roster order — the audit `--list` prints. */
export function publicationPlan(tools: readonly Tool[], writable = false): PublicationDecision[] {
  return tools.map((tool) => decidePublication(tool, writable));
}

/** The tools this invocation actually exposes. */
export function publishableTools(tools: readonly Tool[], writable = false): Tool[] {
  return tools.filter((tool) => decidePublication(tool, writable).published);
}

/** Human-readable audit of what would be served, and what was held back and why. */
export function formatPublicationPlan(plan: PublicationDecision[], writable: boolean): string {
  const published = plan.filter((d) => d.published);
  const withheld = plan.filter((d) => !d.published);
  const width = Math.max(0, ...plan.map((d) => d.tool.length));
  const row = (d: PublicationDecision): string => `  ${d.tool.padEnd(width)}  ${d.reason}`;
  const lines = [
    `arterm mcp serve — ${published.length} tool(s) published, ${withheld.length} withheld` +
      `${writable ? " (--writable)" : " (read-only; pass --writable for the rest)"}`,
    "",
    "published:",
    ...(published.length ? published.map(row) : ["  (none)"]),
    "",
    "withheld:",
    ...(withheld.length ? withheld.map(row) : ["  (none)"]),
  ];
  return lines.join("\n");
}

/**
 * What one `tools/call` produces. Text content only — every Arterm tool returns
 * text. A type alias rather than an interface on purpose: the SDK's result type
 * carries an index signature, and only an alias gets the implicit one that makes
 * it assignable.
 */
export type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Dispatch a `tools/call` against the published set.
 *
 * The roster handed to each tool is the PUBLISHED set, not the full one. That
 * closes what would otherwise be a hole straight through the filter above:
 * `batch` is `allow` + `read` and so is published by default, and it dispatches
 * to whatever `ctx.tools` contains — which, given the full roster, includes
 * `test`. A per-tool filter is not a boundary if one published tool can hand
 * out the tools it excluded.
 *
 * `credentials` is deliberately absent: `scrubEnv` defaults to scrubbing, so a
 * context assembled without it is the safe one (see `credentials.ts`). So is
 * `sandbox` — nothing here spawns a shell unless `--writable` published a tool
 * that runs project commands, and that is the flag's stated cost.
 */
export function createToolDispatcher(
  published: readonly Tool[],
  base: { cwd: string; signal?: AbortSignal },
): (name: string, args: Record<string, unknown>) => Promise<McpCallResult> {
  const byName = new Map(published.map((tool) => [tool.name, tool]));

  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) {
      const known = [...byName.keys()].join(", ");
      return text(`Unknown tool "${name}". This server publishes: ${known || "(nothing)"}`, true);
    }
    const ctx: ToolContext = {
      cwd: base.cwd,
      tools: published,
      ...(base.signal ? { signal: base.signal } : {}),
    };
    try {
      const result = await tool.execute(args ?? {}, ctx);
      // The agent loop enforces `maxOutputBytes` centrally for every tool it
      // runs; there is no agent on this path, so the same ceiling is applied
      // here. Without it a `read` of a generated file puts the whole thing on
      // the wire, which is the failure `toolOutput.ts` exists to prevent.
      const clamped = clampMiddle(result.output, tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      const output = clamped.truncated
        ? `${clamped.text}\n[truncated — the full output was ${clamped.originalBytes} bytes]`
        : clamped.text;
      return text(output, result.isError ?? false);
    } catch (err) {
      return text(`Tool error: ${(err as Error).message}`, true);
    }
  };
}

function text(body: string, isError: boolean): McpCallResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError } : {}) };
}

const TIERS: ToolTier[] = ["minimal", "standard", "full"];

export function parseTier(raw: string | undefined): ToolTier | undefined {
  if (!raw) return undefined;
  if (!TIERS.includes(raw as ToolTier)) {
    throw new ArtermUserError(`unknown tier "${raw}" — expected one of: ${TIERS.join(", ")}`);
  }
  return raw as ToolTier;
}

export interface McpServeOptions {
  cwd: string;
  /** Also publish tools whose permission is "ask" (never the destructive ones). */
  writable?: boolean;
  tier?: ToolTier;
  /** Injected by tests; defaults to `defaultTools(tier)`. */
  tools?: readonly Tool[];
}

/** The roster this invocation starts from, before the publication filter. */
export function rosterFor(opts: McpServeOptions): readonly Tool[] {
  return opts.tools ?? defaultTools(opts.tier);
}

/**
 * Serve the published tools over stdio.
 *
 * stdout is the protocol transport: never write to it here — diagnostics go to
 * stderr only, the same rule `mcpMemoryServer.ts` follows.
 */
export async function startToolsMcpServer(opts: McpServeOptions): Promise<void> {
  // Lazy: the MCP SDK is only needed once this command actually runs, so it
  // stays off the CLI's startup path.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const writable = opts.writable === true;
  const published = publishableTools(rosterFor(opts), writable);
  const dispatch = createToolDispatcher(published, { cwd: opts.cwd });

  // The low-level Server rather than McpServer: our tools already carry JSON
  // Schema, which is exactly what MCP puts on the wire, and this API passes it
  // through untouched. `McpServer.registerTool` accepts only Zod, so every
  // schema would make a lossy round trip (JSON Schema → Zod → JSON Schema)
  // through a form neither end asked for.
  const server = new Server(
    { name: "arterm-tools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: published.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: wireSchema(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatch(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );

  const mode = writable ? "read + write" : "read-only";
  process.stderr.write(
    `arterm-tools MCP server ready (${published.length} tools, ${mode}, cwd: ${opts.cwd})\n`,
  );
  await server.connect(new StdioServerTransport());
}

/** JSON Schema for the wire. A tool that declares no `type` is an object one. */
function wireSchema(tool: Tool): { type: "object" } & Record<string, unknown> {
  return { type: "object", ...tool.parameters } as { type: "object" } & Record<string, unknown>;
}

/**
 * The `arterm mcp serve` entry point: audit the surface with `--list`, or serve it.
 *
 * `--list` exists because the filter above is a security claim, and a claim
 * nobody can read is not one. It prints to stdout precisely because it does NOT
 * start the transport.
 */
export async function runMcpServe(
  opts: { writable?: boolean; tier?: string; list?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  const tier = parseTier(opts.tier);
  const serve: McpServeOptions = {
    cwd,
    ...(opts.writable ? { writable: true } : {}),
    ...(tier ? { tier } : {}),
  };
  if (opts.list) {
    const plan = publicationPlan(rosterFor(serve), opts.writable === true);
    process.stdout.write(`${formatPublicationPlan(plan, opts.writable === true)}\n`);
    return;
  }
  await startToolsMcpServer(serve);
}
