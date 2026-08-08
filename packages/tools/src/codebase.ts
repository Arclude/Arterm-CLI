import type { Tool } from "@arterm/core";
import { CallGraph, type CallSite, type DeclSite } from "./callGraph.js";
import { optionalString, requireString } from "./paths.js";
import { sqliteFailure } from "./sqlite.js";

/** Call sites listed before the rest are counted. */
const MAX_ROWS = 80;

/**
 * One graph per working directory, kept for the process.
 *
 * Parsing a repo costs seconds; a tool that rebuilt per call would make the
 * second question more expensive than the first, which is the opposite of why
 * these exist.
 */
const graphs = new Map<string, CallGraph>();

async function graphFor(cwd: string): Promise<CallGraph> {
  let graph = graphs.get(cwd);
  if (!graph) {
    graph = new CallGraph(cwd);
    graphs.set(cwd, graph);
  }
  await graph.refresh();
  return graph;
}

/** Drop the cached graphs (session teardown, and the tests' isolation). */
export function resetCallGraphs(): void {
  for (const g of graphs.values()) g.close();
  graphs.clear();
}

/**
 * The sentence every one of these tools ends with.
 *
 * The graph is keyed by NAME. Saying so once per answer is the difference
 * between a tool a reader can calibrate and one that reads like a compiler.
 */
const NAME_KEYED =
  "[matched by name — two declarations sharing a name are one node here, and a call " +
  "through a variable or a string is not seen at all]";

function renderCalls(sites: CallSite[]): string {
  const shown = sites.slice(0, MAX_ROWS);
  const lines = shown.map((s) => `${s.path}:${s.line}  ${s.caller} → ${s.expression}`);
  if (sites.length > shown.length) {
    lines.push(`… ${sites.length - shown.length} more call site(s)`);
  }
  return lines.join("\n");
}

function renderDecls(decls: DeclSite[]): string {
  return decls.map((d) => `${d.path}:${d.line}${d.exported ? " (exported)" : ""}`).join("\n");
}

/** The distinct names behind a pile of external calls, most frequent first. */
function summariseExternal(sites: CallSite[]): string {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
  return counts.size > top.length ? `${top.join(", ")}, …` : top.join(", ");
}

export const callersTool: Tool = {
  name: "callers",
  maxOutputBytes: 65_536,
  description:
    "Find every call site of a function or method, across the project. Use before changing a " +
    "signature or deleting something.",
  usageHint:
    "This is the question `grep` answers badly: a search for `parse(` also finds it in comments, " +
    "in strings and in unrelated files, and misses `obj.parse(x)`. The graph is built from a real " +
    "parser, so a call site here is a call site. It is keyed by name, though — if two files each " +
    "declare `run`, their callers are pooled, so check the paths before concluding.",
  permission: "allow",
  category: "read",
  concurrent: true,
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Function, method or class name." },
    },
    required: ["name"],
  },
  preview: (args) => `callers of ${String(args.name)}`,
  async execute(args, ctx) {
    const name = requireString(args, "name");
    const graph = await graphFor(ctx.cwd);
    const stats = graph.stats();
    if (stats.unavailable) {
      return { output: `The call graph is unavailable: ${stats.unavailable}`, isError: true };
    }

    const sites = graph.callers(name);
    const decls = graph.declarations(name);
    const where = decls.length > 0 ? `declared at:\n${renderDecls(decls)}\n\n` : "";
    if (sites.length === 0) {
      return {
        output: `${where}No call site of ${name} found in ${stats.files} indexed file(s).\n${NAME_KEYED}`,
      };
    }
    return {
      output: `${where}${sites.length} call site(s) of ${name}:\n${renderCalls(sites)}\n${NAME_KEYED}`,
    };
  },
};

export const calleesTool: Tool = {
  name: "callees",
  maxOutputBytes: 65_536,
  description: "List what a function calls — the other side of `callers`.",
  usageHint:
    "Use it to size a change before making one: what a function reaches decides how far its " +
    "behaviour can move. Combined with `callers` it gives the blast radius in both directions " +
    "without reading the file.",
  permission: "allow",
  category: "read",
  concurrent: true,
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The enclosing function or method name." },
    },
    required: ["name"],
  },
  preview: (args) => `callees of ${String(args.name)}`,
  async execute(args, ctx) {
    const name = requireString(args, "name");
    const graph = await graphFor(ctx.cwd);
    const stats = graph.stats();
    if (stats.unavailable) {
      return { output: `The call graph is unavailable: ${stats.unavailable}`, isError: true };
    }
    const { local, external } = graph.callees(name);
    if (local.length === 0 && external.length === 0) {
      const known = graph.declarations(name).length > 0;
      return {
        output: known
          ? `${name} is declared but calls nothing.`
          : `No declaration named ${name} was found in ${stats.files} indexed file(s).`,
      };
    }
    // Project functions first and standard-library calls counted, not listed:
    // on a real function the `.map`/`.trim`/`.exec` calls outnumber the ones
    // that matter, and burying three useful rows in thirty is not an answer.
    const head =
      local.length > 0
        ? `${name} calls ${local.length} project declaration(s):\n${renderCalls(local)}`
        : `${name} calls nothing declared in this project.`;
    const rest =
      external.length > 0
        ? `\n[plus ${external.length} call(s) to names not declared here — standard library, ` +
          `dependencies, or built-in methods: ${summariseExternal(external)}]`
        : "";
    return { output: `${head}${rest}\n${NAME_KEYED}` };
  },
};

export const deadCodeTool: Tool = {
  name: "dead_code",
  maxOutputBytes: 65_536,
  description:
    "List exported declarations with no reference anywhere in this project — candidates for " +
    "removal, NOT proof that they are unused.",
  usageHint:
    "Treat every row as a question, not a verdict. This graph cannot see a consumer in another " +
    "repository, a name reached through a string, a route table, a plugin loaded by convention, " +
    "or reflection — and an exported function is a package's public surface, which is unreferenced " +
    "HERE by design. Check each one before deleting it; a library that acts on this list deletes " +
    "its own API.",
  permission: "allow",
  category: "read",
  concurrent: true,
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      path_prefix: {
        type: "string",
        description: "Only report declarations under this path.",
      },
    },
  },
  preview: () => "scan for unreferenced exports",
  async execute(args, ctx) {
    const graph = await graphFor(ctx.cwd);
    const stats = graph.stats();
    if (stats.unavailable) {
      return { output: `The call graph is unavailable: ${stats.unavailable}`, isError: true };
    }
    const prefix = optionalString(args, "path_prefix");
    const all = graph.unreferencedExports();
    const rows = prefix ? all.filter((d) => d.path.startsWith(prefix)) : all;
    if (rows.length === 0) {
      return { output: `Every exported declaration in ${stats.files} file(s) is referenced.` };
    }
    const shown = rows.slice(0, MAX_ROWS);
    const body = shown.map((d) => `${d.path}:${d.line}  ${d.name}`).join("\n");
    const more = rows.length > shown.length ? `\n… ${rows.length - shown.length} more` : "";
    const caveat =
      "[candidates, not verdicts — a public API is unreferenced here by design, and a name " +
      "reached through a string or another repository is invisible to this graph]";
    return {
      output: `${rows.length} exported declaration(s) with no reference inside this project:\n${body}${more}\n${caveat}`,
    };
  },
};

export const codeStatsTool: Tool = {
  name: "code_stats",
  maxOutputBytes: 8_192,
  description:
    "Report what the code index covers: files parsed, declarations, call sites. Set `rebuild` " +
    "to re-parse from scratch.",
  permission: "allow",
  category: "read",
  concurrent: true,
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      rebuild: { type: "boolean", description: "Discard the cache and re-parse everything." },
    },
  },
  preview: (args) => (args.rebuild === true ? "rebuild the code index" : "code index status"),
  async execute(args, ctx) {
    const graph = await graphFor(ctx.cwd);
    if (args.rebuild === true) await graph.rebuild();
    const s = graph.stats();
    if (s.unavailable) {
      const fallback =
        "`callers`, `callees` and `dead_code` cannot answer. `grep` and `search` still work; " +
        "they answer a different, weaker question.";
      return {
        output: `The call graph is unavailable: ${s.unavailable}\n${fallback}`,
        isError: true,
      };
    }
    const why = sqliteFailure();
    return {
      output: [
        `files parsed:  ${s.files}`,
        `declarations:  ${s.decls} (${s.exported} exported)`,
        `call sites:    ${s.calls}`,
        `cache:         ${
          s.persistent
            ? "SQLite, incremental by mtime"
            : `in memory — re-parsed every session${why ? ` (${why})` : ""}`
        }`,
      ].join("\n"),
    };
  },
};

export const codebaseTools: Tool[] = [callersTool, calleesTool, deadCodeTool, codeStatsTool];
