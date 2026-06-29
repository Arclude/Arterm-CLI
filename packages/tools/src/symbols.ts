import type { Tool } from "@arterm/core";
import { requireString } from "./paths.js";
import { SymbolIndex, type SymbolKind } from "./symbolIndex.js";

const KINDS: SymbolKind[] = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "struct",
  "trait",
  "constant",
];

/** One index per working directory; reused across calls (incremental refresh per search). */
const indexCache = new Map<string, SymbolIndex>();

async function getIndex(cwd: string): Promise<SymbolIndex> {
  let index = indexCache.get(cwd);
  if (!index) {
    index = new SymbolIndex(cwd);
    indexCache.set(cwd, index);
  }
  // Incremental: re-parses only files whose mtime changed, so edits made this
  // session (including via the agent's own write/edit tools) are picked up.
  await index.refresh();
  return index;
}

/** Drop cached symbol indexes (tests). */
export function invalidateSymbolIndex(cwd?: string): void {
  if (cwd) {
    indexCache.get(cwd)?.close();
    indexCache.delete(cwd);
  } else {
    for (const idx of indexCache.values()) idx.close();
    indexCache.clear();
  }
}

export const symbolsTool: Tool = {
  name: "symbols",
  description:
    "Find where a symbol (function, class, method, type, interface, enum, …) is DEFINED. " +
    "Searches a symbol index by name and returns each match's kind and file:line. Use this " +
    "to jump to a definition instead of reading whole files. Optionally filter by kind.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Symbol name (or part of it) to look up, e.g. a function or class name.",
      },
      kind: {
        type: "string",
        enum: KINDS,
        description: "Restrict results to one kind of declaration.",
      },
      limit: { type: "number", description: "Maximum results (default 20)." },
    },
    required: ["query"],
  },
  preview: (args) => `symbols "${String(args.query)}"`,
  async execute(args, ctx) {
    const query = requireString(args, "query");
    const kind =
      typeof args.kind === "string" && (KINDS as string[]).includes(args.kind)
        ? (args.kind as SymbolKind)
        : undefined;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;

    const index = await getIndex(ctx.cwd);
    const hits = index.search(query, { kind, limit });
    if (hits.length === 0) {
      const k = kind ? ` ${kind}` : "";
      return { output: `No${k} symbol matching "${query}".` };
    }
    const lines = hits.map((h) => `${h.kind} ${h.name}  —  ${h.path}:${h.line}`);
    return { output: lines.join("\n") };
  },
};
