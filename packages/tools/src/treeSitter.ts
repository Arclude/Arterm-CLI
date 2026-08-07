/**
 * Loading tree-sitter grammars, lazily and at most once.
 *
 * The call graph is the first thing here that a REGEX cannot answer. The
 * existing `symbolIndex.ts` finds declarations with line patterns and that is
 * fine, because a missed declaration shows up as a symbol you cannot jump to —
 * visibly wrong. "Who calls this?" fails the other way: a `foo()` inside a
 * comment or a string counts as a caller, and a caller that is not real is a
 * wrong answer that LOOKS like an answer. Nobody re-checks it.
 *
 * The grammars ship prebuilt `.wasm`, so nothing is compiled at install time —
 * pnpm blocks these packages' native build scripts and that is fine, because
 * the native bindings are not what we load.
 *
 * Everything is behind `await import`, and an unavailable parser is REPORTED,
 * never worked around. Falling back to a regex here would put the wrong answer
 * back on the path the parser exists to keep it off.
 */

import { createRequire } from "node:module";

/** Languages with a call graph. Others are simply not indexed. */
export type CallLang = "typescript" | "tsx" | "javascript" | "python";

/** Minimal view of the web-tree-sitter surface we use. */
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  childCount: number;
  child(i: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
  namedChildren: TsNode[];
}
interface TsTree {
  rootNode: TsNode;
}
interface TsParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TsTree | null;
}

const GRAMMAR: Record<CallLang, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};

const EXT_LANG: Record<string, CallLang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  py: "python",
};

/** The grammar for a path's extension, or undefined when it has none. */
export function langOf(path: string): CallLang | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : EXT_LANG[path.slice(dot + 1).toLowerCase()];
}

/** Every extension the call graph can read. */
export const CALL_GRAPH_EXTS = Object.keys(EXT_LANG);

let runtime: Promise<{ Parser: unknown; Language: unknown } | undefined> | undefined;
const parsers = new Map<CallLang, TsParser | null>();
let lastFailure: string | undefined;

/** Why the parser is unavailable, when it is. */
export function parserFailure(): string | undefined {
  return lastFailure;
}

async function loadRuntime(): Promise<{ Parser: unknown; Language: unknown } | undefined> {
  runtime ??= (async () => {
    try {
      const mod = (await import("web-tree-sitter")) as unknown as {
        Parser: { init(): Promise<void>; new (): TsParser };
        Language: { load(path: string): Promise<unknown> };
      };
      await mod.Parser.init();
      return { Parser: mod.Parser, Language: mod.Language };
    } catch (err) {
      lastFailure = `web-tree-sitter could not be loaded (${err instanceof Error ? err.message : String(err)})`;
      return undefined;
    }
  })();
  return runtime;
}

/**
 * A parser for one language, or null when the grammar is unreachable.
 *
 * Cached including the failure: a missing grammar is a property of the install,
 * not of the file being parsed, and retrying it once per file would turn one
 * problem into one per file.
 */
export async function parserFor(lang: CallLang): Promise<TsParser | null> {
  const cached = parsers.get(lang);
  if (cached !== undefined) return cached;

  const rt = await loadRuntime();
  if (!rt) {
    parsers.set(lang, null);
    return null;
  }
  try {
    // Resolved through `createRequire` rather than a relative path: the tools
    // package is INLINED into the CLI bundle, so a path relative to this file
    // means something different in the built binary than it does in source.
    // The vendor packages are externalized (declared in arterm-cli too), so
    // node resolution is the one thing that is the same in both.
    const require = createRequire(import.meta.url);
    const wasm = require.resolve(GRAMMAR[lang]);
    const language = await (rt.Language as { load(p: string): Promise<unknown> }).load(wasm);
    const parser = new (rt.Parser as new () => TsParser)();
    parser.setLanguage(language);
    parsers.set(lang, parser);
    return parser;
  } catch (err) {
    lastFailure = `the ${lang} grammar could not be loaded (${err instanceof Error ? err.message : String(err)})`;
    parsers.set(lang, null);
    return null;
  }
}

/** Parse source into a syntax tree, or undefined when the grammar is unavailable. */
export async function parseSource(lang: CallLang, source: string): Promise<TsNode | undefined> {
  const parser = await parserFor(lang);
  if (!parser) return undefined;
  try {
    return parser.parse(source)?.rootNode;
  } catch {
    return undefined;
  }
}

/** Depth-first walk over every node. */
export function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, visit);
  }
}
