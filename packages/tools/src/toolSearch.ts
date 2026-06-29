import type { Tool } from "@arterm/core";
import { requireString } from "./paths.js";

/**
 * Meta-tool: search the agent's own tool roster by keyword. As the toolset grows
 * (git, project, web, memory, MCP-provided tools…), a small model can't hold every
 * name in its head — this lets it look one up by intent ("how do I run tests?")
 * instead of guessing or hallucinating a tool name.
 *
 * Reads the live roster from `ctx.tools` (injected by the agent at execute time).
 */

/** Token-overlap score of a query against a tool's name + description. */
function score(tool: Tool, terms: string[]): number {
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (!term) continue;
    if (tool.name.toLowerCase().includes(term))
      s += 5; // name match weighs most
    else if (haystack.includes(term)) s += 1;
  }
  return s;
}

export const toolSearchTool: Tool = {
  name: "tool_search",
  description:
    "Search the available tools by keyword and return the matching tool names with their " +
    "descriptions. Use this to find the right tool by intent instead of guessing a name.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Words describing what you want to do (e.g. 'run tests', 'search the web').",
      },
      limit: { type: "number", description: "Max tools to return (default 10)." },
    },
    required: ["query"],
  },
  preview: (args) => `tool_search ${JSON.stringify(String(args.query ?? ""))}`,
  async execute(args, ctx) {
    const query = requireString(args, "query");
    const roster = ctx.tools ?? [];
    if (roster.length === 0) {
      return { output: "No tools are available in this context." };
    }
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 10;

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = roster
      .map((tool) => ({ tool, s: score(tool, terms) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit);

    if (ranked.length === 0) {
      const names = roster.map((t) => t.name).join(", ");
      return { output: `No tools matched "${query}". Available tools: ${names}` };
    }

    const body = ranked.map(({ tool }) => `- ${tool.name}: ${tool.description}`).join("\n");
    return { output: `Tools matching "${query}":\n${body}` };
  },
};
