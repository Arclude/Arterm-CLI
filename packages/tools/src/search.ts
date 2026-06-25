import type { Tool } from "@arterm/core";
import { CodeIndex } from "./codeIndex.js";
import { requireString } from "./paths.js";

const DEFAULT_LIMIT = 10;

/** One built index per working directory, so repeated searches don't re-walk the tree. */
const indexCache = new Map<string, CodeIndex>();

async function getIndex(cwd: string): Promise<CodeIndex> {
  const cached = indexCache.get(cwd);
  if (cached) return cached;
  const index = new CodeIndex();
  await index.buildFromDir(cwd);
  indexCache.set(cwd, index);
  return index;
}

/**
 * Drop the cached index for a cwd (or all of them) so the next `search` re-walks the
 * tree. The file-mutating tools call this after a write, otherwise searches would
 * return stale line numbers and miss code the agent just created mid-session.
 */
export function invalidateSearchIndex(cwd?: string): void {
  if (cwd) indexCache.delete(cwd);
  else indexCache.clear();
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const searchTool: Tool = {
  name: "search",
  description:
    "Ranked full-text (BM25) search over the project's source files. Returns the best " +
    "matching file:line locations with a snippet. Use this to FIND where something is " +
    "defined or used before reading whole files.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Words or identifiers to search for (e.g. a function or symbol name).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default 10).",
      },
    },
    required: ["query"],
  },
  preview: (args) => `search "${String(args.query)}"`,
  async execute(args, ctx) {
    const query = requireString(args, "query");
    const limit = optionalNumber(args, "limit");
    const effectiveLimit = limit !== undefined && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;

    const index = await getIndex(ctx.cwd);
    const hits = index.search(query, effectiveLimit);
    if (hits.length === 0) {
      return { output: `No matches for "${query}".` };
    }

    const lines = hits.map((h) => `${h.path}:${h.line}  (${h.score.toFixed(3)})  ${h.snippet}`);
    return { output: lines.join("\n") };
  },
};
