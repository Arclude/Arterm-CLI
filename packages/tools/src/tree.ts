import type { Tool } from "@arterm/core";
import { ignorePatterns } from "./ignore.js";
import { isWithin, optionalString, resolveWithin } from "./paths.js";

/** Entries rendered before the whole tree gives up. */
const MAX_ENTRIES = 400;
/** Children listed under any one directory before the rest are counted instead. */
const MAX_CHILDREN = 40;
/** Levels shown when the caller does not say. */
const DEFAULT_DEPTH = 3;

interface Node {
  name: string;
  dir: boolean;
  children: Map<string, Node>;
}

function node(name: string, dir: boolean): Node {
  return { name, dir, children: new Map() };
}

/** Insert a `/`-separated relative path into the tree, creating parents. */
function insert(root: Node, rel: string, isDir: boolean): void {
  const parts = rel.split("/").filter(Boolean);
  let cur = root;
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    let next = cur.children.get(part);
    if (!next) {
      next = node(part, last ? isDir : true);
      cur.children.set(part, next);
    } else if (!last) {
      // A path can arrive before its parent was known to be a directory.
      next.dir = true;
    }
    cur = next;
  });
}

interface Render {
  lines: string[];
  dirs: number;
  files: number;
  hidden: number;
}

/**
 * Draw the tree, directories first then names, with two independent limits.
 *
 * Both limits exist because they fail differently: one directory holding 900
 * generated files would otherwise consume the whole budget and hide every
 * sibling directory, which is exactly the shape of a project a model most
 * needs the tree for. What each limit dropped is counted and printed — a tree
 * that silently stops reads as a project that simply ends there.
 */
function render(root: Node, budget: number): Render {
  const out: Render = { lines: [], dirs: 0, files: 0, hidden: 0 };

  const walk = (parent: Node, prefix: string): void => {
    const kids = [...parent.children.values()].sort(
      (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
    );
    const shown = kids.slice(0, MAX_CHILDREN);
    out.hidden += kids.length - shown.length;

    shown.forEach((kid, i) => {
      if (out.lines.length >= budget) {
        out.hidden++;
        return;
      }
      const last = i === shown.length - 1 && kids.length <= MAX_CHILDREN;
      out.lines.push(`${prefix}${last ? "└── " : "├── "}${kid.name}${kid.dir ? "/" : ""}`);
      if (kid.dir) out.dirs++;
      else out.files++;
      if (kid.dir) walk(kid, `${prefix}${last ? "    " : "│   "}`);
    });

    if (kids.length > shown.length && out.lines.length < budget) {
      out.lines.push(`${prefix}└── … ${kids.length - shown.length} more entr(ies)`);
    }
  };

  walk(root, "");
  return out;
}

export const treeTool: Tool = {
  name: "tree",
  maxOutputBytes: 65_536,
  description:
    "Show a directory tree to a given depth, skipping what .gitignore ignores. " +
    "Use this to see a project's shape; use ls for one directory's exact contents.",
  usageHint:
    "Start with the default depth and narrow with `path` rather than asking for a deep tree of the " +
    "repository root — a depth of 6 on a monorepo is mostly lockfiles and build output. " +
    "Directories the project ignores are omitted unless `all` is set, so what you see is the " +
    "source, not the artifacts.",
  permission: "allow",
  category: "read",
  concurrent: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to walk; defaults to '.'." },
      depth: { type: "number", description: `Levels to descend (default ${DEFAULT_DEPTH}).` },
      dirs_only: { type: "boolean", description: "List directories only." },
      all: { type: "boolean", description: "Include files .gitignore excludes." },
    },
  },
  preview: (args) => `tree ${String(args.path ?? ".")}`,
  async execute(args, ctx) {
    const rel = optionalString(args, "path") ?? ".";
    const abs = resolveWithin(ctx.cwd, rel);
    const depth = Math.max(1, Math.min(12, Math.floor(toNumber(args.depth) ?? DEFAULT_DEPTH)));
    const dirsOnly = args.dirs_only === true;

    const { default: fg } = await import("fast-glob");
    const entries = await fg("**/*", {
      cwd: abs,
      deep: depth,
      onlyFiles: false,
      onlyDirectories: dirsOnly,
      markDirectories: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      // `all` still cannot walk into .git — a tree of 40,000 loose objects is
      // not a view of the project under any setting.
      ignore: args.all === true ? ["**/.git/**"] : await ignorePatterns(abs),
    });

    const root = node(rel, true);
    for (const entry of entries) {
      const isDir = entry.endsWith("/");
      const path = isDir ? entry.slice(0, -1) : entry;
      // fast-glob is confined by `cwd`, but a symlinked entry could still name
      // a path outside it; the same check grep makes, for the same reason.
      if (!isWithin(abs, resolveWithin(abs, path))) continue;
      insert(root, path, isDir);
    }

    const r = render(root, MAX_ENTRIES);
    if (r.lines.length === 0) {
      return { output: `${rel}/\n(empty at depth ${depth})` };
    }
    const notes = [`${r.dirs} director(ies)`, `${r.files} file(s)`, `depth ${depth}`];
    if (r.hidden > 0) notes.push(`${r.hidden} entr(ies) not shown`);
    return { output: `${rel}/\n${r.lines.join("\n")}\n[${notes.join(" · ")}]` };
  },
};

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
