import type { ArtermConfig } from "@arterm/core";
import { z } from "zod";
import { createCmemEngine } from "./engine.js";
import { listCmemProjects, openStoreByKey } from "./store.js";
import { OBS_TYPES } from "./types.js";

/**
 * Expose the rich cmem store as a stdio MCP server — the cmem-engine analog of
 * `@arterm/tools`' legacy `startMemoryMcpServer`. Any MCP client (Claude Code,
 * Arterm's own client) can then run the progressive-disclosure workflow
 * (mem_search → get_observations → timeline) against this machine's memory.
 *
 * stdout is the protocol transport — never write to it; diagnostics go to stderr.
 */

/** MCP text result helper. */
function text(s: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: s }] };
}

export async function startCmemMcpServer(opts: {
  cwd: string;
  config: ArtermConfig;
}): Promise<void> {
  // Lazy: the MCP SDK is only needed when this server actually starts (`arterm mcp`),
  // so it stays out of the CLI's hot startup path.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  // Reuse the full engine wiring (store + embedder + tools); no observer needed.
  const engine = await createCmemEngine({
    cwd: opts.cwd,
    config: opts.config,
    summarize: async () => "",
    embedHost: opts.config.ollamaHost,
  });
  const tools = new Map(engine.tools().map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.get(name);
    if (!tool) return `(tool ${name} unavailable)`;
    return (await tool.execute(args, { cwd: opts.cwd })).output;
  };

  const server = new McpServer({ name: "arterm-cmem", version: "0.1.0" });

  server.registerTool(
    "mem_search",
    {
      description:
        "Semantic + lexical search over this project's rich memory. Returns COMPACT id rows; " +
        "call get_observations([ids]) for full detail (progressive disclosure).",
      inputSchema: {
        query: z.string().describe("Words to search memory for."),
        limit: z.number().int().positive().optional().describe("Max results (default 8)."),
      },
    },
    async ({ query, limit }) =>
      text(await call("mem_search", { query, ...(limit ? { limit } : {}) })),
  );

  server.registerTool(
    "get_observations",
    {
      description:
        "Fetch FULL detail (narrative, facts, files, concepts) for observation ids. Batch them.",
      inputSchema: { ids: z.array(z.number().int()).describe("Observation ids to expand.") },
    },
    async ({ ids }) => text(await call("get_observations", { ids })),
  );

  server.registerTool(
    "timeline",
    {
      description: "Show observations chronologically around an anchor id (compact rows).",
      inputSchema: {
        anchor: z.number().int().describe("Observation id to center on."),
        before: z.number().int().nonnegative().optional().describe("Earlier count (default 3)."),
        after: z.number().int().nonnegative().optional().describe("Later count (default 3)."),
      },
    },
    async ({ anchor, before, after }) =>
      text(
        await call("timeline", {
          anchor,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
        }),
      ),
  );

  server.registerTool(
    "remember_observation",
    {
      description: "Persist a durable, richly-typed observation to the CURRENT project's memory.",
      inputSchema: {
        type: z.enum(OBS_TYPES as unknown as [string, ...string[]]).describe("Classification."),
        title: z.string().describe("Short one-line title."),
        subtitle: z.string().optional(),
        facts: z.array(z.string()).optional(),
        narrative: z.string().optional(),
        concepts: z.array(z.string()).optional(),
        filesRead: z.array(z.string()).optional(),
        filesModified: z.array(z.string()).optional(),
      },
    },
    async (args) => text(await call("remember_observation", args)),
  );

  server.registerTool(
    "memory_projects",
    {
      description: "List all projects on this machine that have a cmem store, with their keys.",
      inputSchema: {},
    },
    async () => {
      const projects = await listCmemProjects();
      if (projects.length === 0) return text("(no projects have cmem memory yet)");
      const lines = await Promise.all(
        projects.map(async (p) => {
          const store = await openStoreByKey(p.key);
          const count = (await store.all()).length;
          store.close();
          return `${p.key}  (${count})  ${p.cwd}`;
        }),
      );
      return text(`key  (count)  path\n${lines.join("\n")}`);
    },
  );

  process.stderr.write(`arterm-cmem MCP server ready (project: ${opts.cwd})\n`);
  await server.connect(new StdioServerTransport());
}
