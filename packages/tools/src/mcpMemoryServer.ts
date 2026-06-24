import {
  JsonlMemoryStore,
  type LearningType,
  type MemoryStore,
  listMemoryProjects,
  projectKey,
  readProjectRecords,
} from "@arterm/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMemorySearchTool, createRememberTool, formatLearning } from "./memoryTools.js";

const LEARNING_TYPES = ["feature", "bugfix", "decision", "discovery", "note"] as const;

/** MCP text result helper. */
function text(s: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: s }] };
}

/** Read-only store view over an arbitrary project key (for cross-project recall). */
function storeForKey(key: string): MemoryStore {
  return {
    id: "jsonl",
    append: async () => {},
    all: () => readProjectRecords(key),
    async recent(limit: number) {
      const all = await readProjectRecords(key);
      return limit > 0 ? all.slice(-limit) : all;
    },
  };
}

/**
 * Start Arterm's persistent memory as a stdio MCP server — the same role
 * claude-mem's mcp-server plays. Any MCP client (Claude Code, Arterm's own MCP
 * client, etc.) can connect and query/append this machine's project memory.
 *
 * stdout is the protocol transport: never write to it here — diagnostics go to
 * stderr only. Scoped to `cwd` by default; tools accept an optional `project`
 * key (from `memory_projects`) to reach other projects' memory.
 */
export async function startMemoryMcpServer(opts: { cwd: string }): Promise<void> {
  const defaultKey = projectKey(opts.cwd);
  const resolveKey = (project?: string): string =>
    project && project.trim() ? project.trim() : defaultKey;

  const server = new McpServer({ name: "arterm-memory", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description:
        "BM25-ranked search over a project's persistent memory (durable learnings from past " +
        "Arterm sessions): decisions, bug fixes, features, discoveries.",
      inputSchema: {
        query: z.string().describe("Words to search memory for."),
        limit: z.number().int().positive().optional().describe("Max results (default 8)."),
        project: z
          .string()
          .optional()
          .describe("Project key from memory_projects (defaults to the current project)."),
      },
    },
    async ({ query, limit, project }) => {
      const tool = createMemorySearchTool(storeForKey(resolveKey(project)));
      const res = await tool.execute({ query, ...(limit ? { limit } : {}) }, { cwd: opts.cwd });
      return text(res.output);
    },
  );

  server.registerTool(
    "memory_recent",
    {
      description: "List the most recent learnings in a project's memory, newest last.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("How many (default 15)."),
        project: z.string().optional().describe("Project key (defaults to the current project)."),
      },
    },
    async ({ limit, project }) => {
      const records = await readProjectRecords(resolveKey(project));
      const slice = records.slice(-(limit ?? 15));
      return text(slice.length ? slice.map(formatLearning).join("\n") : "(no memory yet)");
    },
  );

  server.registerTool(
    "memory_projects",
    {
      description: "List all projects on this machine that have Arterm memory, with their keys.",
      inputSchema: {},
    },
    async () => {
      const projects = await listMemoryProjects();
      if (projects.length === 0) return text("(no projects have memory yet)");
      const lines = await Promise.all(
        projects.map(async (p) => {
          const count = (await readProjectRecords(p.key)).length;
          const current = p.key === defaultKey ? " *" : "";
          return `${p.key}  (${count})  ${p.cwd}${current}`;
        }),
      );
      return text(`key  (count)  path   [* = current]\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "remember",
    {
      description:
        "Save a durable fact to the CURRENT project's persistent memory so future Arterm " +
        "sessions recall it.",
      inputSchema: {
        title: z.string().describe("Short one-line summary of the fact."),
        type: z.enum(LEARNING_TYPES).optional().describe("Classification (default note)."),
        body: z.string().optional().describe("Optional detail."),
        files: z.array(z.string()).optional().describe("Optional relevant file paths."),
      },
    },
    async ({ title, type, body, files }) => {
      const tool = createRememberTool(new JsonlMemoryStore(opts.cwd));
      const res = await tool.execute(
        {
          title,
          ...(type ? { type } : {}),
          ...(body ? { body } : {}),
          ...(files ? { files } : {}),
        } satisfies { title: string; type?: LearningType; body?: string; files?: string[] },
        { cwd: opts.cwd },
      );
      return text(res.output);
    },
  );

  process.stderr.write(`arterm-memory MCP server ready (project: ${opts.cwd})\n`);
  await server.connect(new StdioServerTransport());
}
