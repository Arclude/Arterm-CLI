/**
 * Who calls what.
 *
 * `search` finds where text occurs and `symbols` finds where a name is
 * DECLARED. Neither answers the question that actually decides whether a change
 * is safe: who depends on this, and what does it depend on.
 *
 * What this is NOT is as important as what it is, and every tool built on it
 * says so in its output. The graph is keyed by NAME, not by resolved binding:
 * tree-sitter gives exact call sites, not a type checker's answer about which
 * `parse` a `parse(x)` refers to. Two functions with one name are therefore one
 * node. An import-aware pass narrows the common case — a call to a name this
 * file imported from a known module resolves to that module — but the general
 * case does not resolve, and a graph that quietly pretended otherwise would be
 * exactly the silent wrong answer the parser was chosen to avoid.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { ARTERM_HOME } from "@arterm/core";
import { type SqliteDb, openCacheDb } from "./sqlite.js";
import { CALL_GRAPH_EXTS, type TsNode, langOf, parseSource, walk } from "./treeSitter.js";

/** Directories never walked, whatever a .gitignore says. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".arterm",
  "build",
  "out",
  "coverage",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);
const MAX_FILE_BYTES = 512 * 1024;

export interface CallSite {
  /** The callee as written: `beta`, `obj.gamma`, `this.helper`. */
  expression: string;
  /** The bare name the graph is keyed by: `gamma` from `obj.gamma`. */
  name: string;
  /** The declaration the call sits inside, or "(top level)". */
  caller: string;
  path: string;
  line: number;
}

export interface DeclSite {
  name: string;
  path: string;
  line: number;
  exported: boolean;
}

export interface FileFacts {
  calls: CallSite[];
  decls: DeclSite[];
  /** Module specifiers this file imports from, with the names taken. */
  imports: Array<{ name: string; from: string }>;
}

/** Node types that introduce a named scope, per grammar family. */
const DECL_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "class_declaration",
  "function_definition",
  "class_definition",
  "variable_declarator",
  "public_field_definition",
]);

const CALL_TYPES = new Set(["call_expression", "call", "new_expression"]);

/** Function nodes with no name of their own — they borrow the enclosing call's. */
const ANON_FN_TYPES = new Set(["arrow_function", "function_expression", "lambda"]);

/** The declaration name for a scope-introducing node, when it has one. */
function declName(node: TsNode): string | undefined {
  const name = node.childForFieldName("name");
  if (name?.text) return name.text;
  // `method_definition` uses `property` in some grammar versions.
  const property = node.childForFieldName("property");
  return property?.text;
}

/**
 * The nearest enclosing declaration's name.
 *
 * A `variable_declarator` only counts when it holds a function — `const x = 1`
 * is not a scope, and treating it as one would attribute a call in the next
 * function to a constant.
 */
function enclosing(chain: Array<{ node: TsNode; name: string }>): string {
  return chain[chain.length - 1]?.name ?? "(top level)";
}

function holdsFunction(node: TsNode): boolean {
  const value = node.childForFieldName("value");
  if (!value) return false;
  return (
    value.type === "arrow_function" ||
    value.type === "function_expression" ||
    value.type === "function" ||
    value.type === "generator_function"
  );
}

/** The bare name a call expression targets. */
function bareName(expression: string): string {
  const cut = expression.lastIndexOf(".");
  const tail = cut >= 0 ? expression.slice(cut + 1) : expression;
  return tail.trim();
}

/**
 * Nodes that end the search for an enclosing `export`.
 *
 * A class body is the important one: `export class C { m() {} }` exports C, not
 * m. Without this boundary every private field and every constructor of every
 * exported class counted as an export, and `dead_code` filled up with them.
 */
const EXPORT_BOUNDARY = new Set([
  "class_body",
  "statement_block",
  "object",
  "function_declaration",
  "class_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
]);

/** True when a node is itself exported — not merely nested inside something that is. */
function isExported(ancestors: TsNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const type = ancestors[i]?.type ?? "";
    if (type === "export_statement") return true;
    if (EXPORT_BOUNDARY.has(type)) return false;
  }
  return false;
}

/** Extract calls, declarations and imports from one parsed file. */
export async function extractFacts(path: string, content: string): Promise<FileFacts | undefined> {
  const lang = langOf(path);
  if (!lang) return undefined;
  const root = await parseSource(lang, content);
  if (!root) return undefined;

  const calls: CallSite[] = [];
  const decls: DeclSite[] = [];
  const imports: Array<{ name: string; from: string }> = [];
  // Python has no export keyword: a module-level definition IS the public
  // surface, so `exported` means "declared at module level" there. Said out
  // loud because `dead_code` reads this field and would otherwise report a
  // different thing per language without saying which.
  const pythonic = lang === "python";

  // Manual stack walk rather than a recursive visitor, because the enclosing
  // declaration is needed at every call site and recomputing it by walking up
  // per call is quadratic on a deep file.
  const stack: Array<{ node: TsNode; name: string }> = [];
  const ancestors: TsNode[] = [];
  /** Callee names of the enclosing call expressions, innermost last. */
  const enclosingCalls: string[] = [];

  const visit = (node: TsNode): void => {
    let pushed =
      DECL_TYPES.has(node.type) &&
      (node.type !== "variable_declarator" || holdsFunction(node)) &&
      declName(node) !== undefined;

    if (pushed) {
      const name = declName(node) as string;
      const exported = pythonic ? ancestors.length <= 1 : isExported(ancestors);
      decls.push({ name, path, line: node.startPosition.row + 1, exported });
      stack.push({ node, name });
    } else if (ANON_FN_TYPES.has(node.type)) {
      // A callback borrows the name of the call it was passed to. Without this
      // every assertion inside `it(…, () => …)` is attributed to "(top level)"
      // — true, and useless. `it → clampMiddle` is what a reader wants back
      // from "who calls this"; the anonymous arrow has no name to give.
      const owner = enclosingCalls[enclosingCalls.length - 1];
      if (owner) {
        stack.push({ node, name: owner });
        pushed = true;
      }
    }
    ancestors.push(node);

    if (CALL_TYPES.has(node.type)) {
      const fn =
        node.childForFieldName("function") ?? node.childForFieldName("constructor") ?? null;
      const expression = (fn?.text ?? "").trim();
      const name = bareName(expression);
      // A call whose callee is an expression rather than a name (`(await f())()`,
      // `arr[i]()`) has no name to key on. Recording it as "" would make every
      // such site a caller of everything.
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        calls.push({
          expression,
          name,
          caller: enclosing(stack),
          path,
          line: node.startPosition.row + 1,
        });
      }
      enclosingCalls.push(name);
    }

    // `<Foo />` is how a component is used, and it is not a call expression.
    // Without this every component in a React codebase reads as unreferenced —
    // observed here, where `dead_code` offered up the transcript's MessageList.
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const tag = node.childForFieldName("name")?.text ?? "";
      // Lowercase tags are host elements (`div`, `span`), not project symbols.
      if (/^[A-Z]/.test(tag)) {
        calls.push({
          expression: `<${tag}>`,
          name: bareName(tag),
          caller: enclosing(stack),
          path,
          line: node.startPosition.row + 1,
        });
      }
    }

    if (node.type === "import_statement" || node.type === "import_from_statement") {
      const source = node.childForFieldName("source")?.text ?? "";
      const from = source.replace(/^['"`]|['"`]$/g, "");
      for (const child of node.namedChildren) {
        if (child === node.childForFieldName("source")) continue;
        walk(child, (n) => {
          if (n.type === "identifier" || n.type === "dotted_name") {
            imports.push({ name: n.text, from });
          }
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }

    ancestors.pop();
    if (CALL_TYPES.has(node.type)) enclosingCalls.pop();
    if (pushed) stack.pop();
  };

  visit(root);
  return { calls, decls, imports };
}

const SCHEMA_VERSION = 1;

function openDb(cwd: string, dir: string): Promise<SqliteDb | null> {
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return openCacheDb({
    dir,
    file: `${key}.db`,
    schemaVersion: SCHEMA_VERSION,
    onMigrate: (db) => db.exec("DROP TABLE IF EXISTS cg_files; DROP TABLE IF EXISTS cg_facts;"),
    schema: `CREATE TABLE IF NOT EXISTS cg_files (path TEXT PRIMARY KEY, mtime REAL);
       CREATE TABLE IF NOT EXISTS cg_facts (path TEXT PRIMARY KEY, json TEXT);`,
  });
}

export interface GraphStats {
  files: number;
  decls: number;
  calls: number;
  exported: number;
  /** True when SQLite is caching parses across sessions. */
  persistent: boolean;
  /** Set when the parser could not be loaded; the graph is then empty. */
  unavailable?: string;
}

/**
 * A call graph over a working directory, refreshed incrementally by mtime.
 *
 * Parsing is the expensive part — a few seconds on a mid-sized repo — so the
 * facts are cached in SQLite the way `symbolIndex.ts` caches symbols. Without
 * `node:sqlite` it still works; it just re-parses each session.
 */
export class CallGraph {
  private facts = new Map<string, FileFacts>();
  private mtimes = new Map<string, number>();
  private db: SqliteDb | null = null;
  private opened = false;
  private dbDir: string;
  private failure: string | undefined;

  constructor(
    private cwd: string,
    opts: { dbDir?: string } = {},
  ) {
    this.dbDir = opts.dbDir ?? join(ARTERM_HOME, "callgraph");
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    this.db = await openDb(this.cwd, this.dbDir);
    if (!this.db) return;
    for (const row of this.db.prepare("SELECT path, mtime FROM cg_files").all() as {
      path: string;
      mtime: number;
    }[]) {
      this.mtimes.set(row.path, row.mtime);
    }
    for (const row of this.db.prepare("SELECT path, json FROM cg_facts").all() as {
      path: string;
      json: string;
    }[]) {
      try {
        this.facts.set(row.path, JSON.parse(row.json) as FileFacts);
      } catch {
        this.mtimes.delete(row.path);
      }
    }
  }

  /** Walk the tree, re-parsing only what changed. */
  async refresh(): Promise<void> {
    await this.open();
    const seen = new Set<string>();
    await this.walkDir(this.cwd, this.cwd, seen);
    for (const path of [...this.mtimes.keys()]) {
      if (seen.has(path)) continue;
      this.facts.delete(path);
      this.mtimes.delete(path);
      this.db?.prepare("DELETE FROM cg_facts WHERE path = ?").run(path);
      this.db?.prepare("DELETE FROM cg_files WHERE path = ?").run(path);
    }
  }

  /** Drop everything and re-parse from scratch. */
  async rebuild(): Promise<void> {
    await this.open();
    this.facts.clear();
    this.mtimes.clear();
    this.db?.exec("DELETE FROM cg_facts; DELETE FROM cg_files;");
    await this.refresh();
  }

  private async walkDir(root: string, dir: string, seen: Set<string>): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await this.walkDir(root, abs, seen);
      } else if (entry.isFile()) {
        await this.indexFile(root, abs, seen);
      }
    }
  }

  private async indexFile(root: string, abs: string, seen: Set<string>): Promise<void> {
    const rel = relative(root, abs).split(sep).join("/");
    const dot = rel.lastIndexOf(".");
    if (dot < 0 || !CALL_GRAPH_EXTS.includes(rel.slice(dot + 1).toLowerCase())) return;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) return;
    seen.add(rel);
    if (this.mtimes.get(rel) === stat.mtimeMs) return;

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      return;
    }
    const facts = await extractFacts(rel, content);
    if (!facts) {
      // A file we know the extension of but could not parse means the grammar
      // is unavailable. Recorded once, reported by every tool, never patched
      // over with a regex.
      const { parserFailure } = await import("./treeSitter.js");
      this.failure ??= parserFailure();
      return;
    }
    this.facts.set(rel, facts);
    this.mtimes.set(rel, stat.mtimeMs);
    if (this.db) {
      this.db
        .prepare("INSERT OR REPLACE INTO cg_facts (path, json) VALUES (?, ?)")
        .run(rel, JSON.stringify(facts));
      this.db
        .prepare("INSERT OR REPLACE INTO cg_files (path, mtime) VALUES (?, ?)")
        .run(rel, stat.mtimeMs);
    }
  }

  /** Every call site targeting `name`. */
  callers(name: string): CallSite[] {
    const out: CallSite[] = [];
    for (const facts of this.facts.values()) {
      for (const call of facts.calls) {
        if (call.name === name) out.push(call);
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /**
   * Every call made from inside a declaration named `name`, split by whether
   * the target is declared in this project.
   *
   * Without the split this answer is unreadable: on a real file most call sites
   * are `.map`, `.trim`, `.push` and a regex's `.exec`, and the two or three
   * project functions that actually matter sit somewhere in the middle of
   * thirty rows of standard library.
   *
   * Only a BARE name (or `this.x`) counts as local, even when the project also
   * declares the name behind a dot. Observed here: this repository declares a
   * `trim` method, which made every `raw.trim()` in it report as a call into
   * project code. Resolving `raw.trim` properly needs the type of `raw`, which
   * no syntax tree has — so the choice is which way to be wrong, and a quiet
   * false negative in a counted summary beats a confident false positive in the
   * list a reader is using to decide what a change touches.
   */
  callees(name: string): { local: CallSite[]; external: CallSite[] } {
    const declared = new Set<string>();
    for (const facts of this.facts.values()) {
      for (const decl of facts.decls) declared.add(decl.name);
    }
    const local: CallSite[] = [];
    const external: CallSite[] = [];
    for (const facts of this.facts.values()) {
      for (const call of facts.calls) {
        if (call.caller !== name) continue;
        const addressable =
          call.expression === call.name || call.expression === `this.${call.name}`;
        (addressable && declared.has(call.name) ? local : external).push(call);
      }
    }
    const byPos = (a: CallSite, b: CallSite) => a.path.localeCompare(b.path) || a.line - b.line;
    return { local: local.sort(byPos), external: external.sort(byPos) };
  }

  /** Where a name is declared. */
  declarations(name: string): DeclSite[] {
    const out: DeclSite[] = [];
    for (const facts of this.facts.values()) {
      for (const decl of facts.decls) {
        if (decl.name === name) out.push(decl);
      }
    }
    return out;
  }

  /**
   * Exported declarations with no call site anywhere in the tree.
   *
   * "Unreferenced HERE" — never "dead". An exported function is a package's
   * public surface, and this graph cannot see the consumer that lives in
   * another repository, a test fixture loaded by name, or a route table built
   * from strings. The tool that prints this says so; acting on it without
   * checking is how a library deletes its own API.
   */
  unreferencedExports(): DeclSite[] {
    const called = new Set<string>();
    for (const facts of this.facts.values()) {
      for (const call of facts.calls) called.add(call.name);
    }
    // A name that is imported somewhere is referenced even if never called —
    // re-exported, passed as a value, used as a type.
    const imported = new Set<string>();
    for (const facts of this.facts.values()) {
      for (const imp of facts.imports) imported.add(imp.name);
    }
    const out: DeclSite[] = [];
    for (const facts of this.facts.values()) {
      for (const decl of facts.decls) {
        if (!decl.exported) continue;
        // A constructor is reached by `new`, never by its own name.
        if (decl.name === "constructor") continue;
        if (called.has(decl.name) || imported.has(decl.name)) continue;
        out.push(decl);
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  stats(): GraphStats {
    let decls = 0;
    let calls = 0;
    let exported = 0;
    for (const f of this.facts.values()) {
      decls += f.decls.length;
      calls += f.calls.length;
      exported += f.decls.filter((d) => d.exported).length;
    }
    return {
      files: this.facts.size,
      decls,
      calls,
      exported,
      persistent: this.db !== null,
      ...(this.facts.size === 0 && this.failure ? { unavailable: this.failure } : {}),
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
