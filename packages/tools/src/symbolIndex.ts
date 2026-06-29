import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { ARTERM_HOME } from "@arterm/core";

/**
 * Symbol-level code index: extracts declarations (functions, classes, methods,
 * types, …) from source files and lets the agent jump straight to where a symbol
 * is DEFINED — complementing the BM25 full-text `search`, which finds where text
 * *occurs*. Extraction is regex-based (no native tree-sitter dependency) and
 * deliberately conservative.
 *
 * Persistence is incremental and backed by `node:sqlite` when the runtime
 * provides it (Node ≥ 22 with the API enabled): per-project symbols are cached
 * under ARTERM_HOME and only changed files (by mtime) are re-parsed across
 * sessions. When `node:sqlite` is unavailable the index still works fully —
 * it just rebuilds in memory each session.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "constant";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** Path relative to the indexed root, forward slashes. */
  path: string;
  /** 1-based line of the declaration. */
  line: number;
  /** Trimmed, length-capped declaration line. */
  signature: string;
}

const SIGNATURE_MAX = 160;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".arterm", "build", "out", "coverage"]);
const SOURCE_EXTS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "rb",
]);

/** Line-starting keywords that look like declarations but aren't, for method detection. */
const NON_DECL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "do",
  "else",
  "function",
  "await",
  "typeof",
  "new",
  "case",
  "throw",
  "with",
  "yield",
]);

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
}

// TypeScript / JavaScript — the primary target.
const TS_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
    kind: "function",
  },
  // Arrow / function-expression const: `export const foo = (…) =>` / `= async (…) =>` / `= function`.
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=>]+)?=>|<[^>]*>\s*\(|[A-Za-z_$][\w$]*\s*=>)/,
    kind: "function",
  },
];

const PY_PATTERNS: Pattern[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
];

const GO_PATTERNS: Pattern[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
];

const RUST_PATTERNS: Pattern[] = [
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
];

const JAVA_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:public|private|protected)\s+(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/,
    kind: "class",
  },
  { re: /^\s*(?:public|private|protected)\s+interface\s+([A-Za-z_]\w*)/, kind: "interface" },
];

const RUBY_PATTERNS: Pattern[] = [
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: "function" },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*module\s+([A-Za-z_]\w*)/, kind: "class" },
];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function patternsFor(ext: string): Pattern[] | null {
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return TS_PATTERNS;
    case "py":
      return PY_PATTERNS;
    case "go":
      return GO_PATTERNS;
    case "rs":
      return RUST_PATTERNS;
    case "java":
      return JAVA_PATTERNS;
    case "rb":
      return RUBY_PATTERNS;
    default:
      return null;
  }
}

function clip(line: string): string {
  const t = line.trim();
  return t.length > SIGNATURE_MAX ? `${t.slice(0, SIGNATURE_MAX - 1)}…` : t;
}

const TS_LIKE = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);

/**
 * Detect a class/object method declaration in TS/JS: an indented `name(args) {`
 * (or `name(args): T {`) that isn't a control-flow keyword. Top-level functions
 * use `function`/arrow forms and are handled by the main patterns.
 */
function tsMethod(line: string): string | null {
  const m = line.match(
    /^[ \t]+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^={]+)?\{\s*$/,
  );
  if (!m) return null;
  const name = m[1];
  if (!name || NON_DECL.has(name)) return null;
  return name;
}

/** Extract declared symbols from one file's content. Pure; no filesystem. */
export function extractSymbols(path: string, content: string): CodeSymbol[] {
  const patterns = patternsFor(extOf(path));
  if (!patterns) return [];
  const isTs = TS_LIKE.has(extOf(path));
  const out: CodeSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let matched = false;
    for (const { re, kind } of patterns) {
      const m = line.match(re);
      if (m?.[1]) {
        out.push({ name: m[1], kind, path, line: i + 1, signature: clip(line) });
        matched = true;
        break;
      }
    }
    if (!matched && isTs) {
      const method = tsMethod(line);
      if (method) {
        out.push({ name: method, kind: "method", path, line: i + 1, signature: clip(line) });
      }
    }
  }
  return out;
}

/** Minimal subset of the `node:sqlite` DatabaseSync surface we rely on. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA_VERSION = 1;

/** Open the per-project SQLite cache, or null when `node:sqlite` is unavailable. */
async function openDb(cwd: string, dir: string): Promise<SqliteDb | null> {
  let DatabaseSync: (new (path: string) => SqliteDb) | undefined;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDb;
    });
  } catch {
    return null; // runtime without node:sqlite — fall back to in-memory only
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
    const db = new DatabaseSync(join(dir, `${key}.db`));
    const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version;
    if (version !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols;");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL);
       CREATE TABLE IF NOT EXISTS symbols (path TEXT, name TEXT, kind TEXT, line INTEGER, signature TEXT);
       CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols (name);`,
    );
    return db;
  } catch {
    return null;
  }
}

/**
 * A symbol index over a working directory. Build/refresh is incremental: only
 * files whose mtime changed since the last scan are re-parsed. Searchable in
 * memory; persisted to SQLite when available.
 */
export class SymbolIndex {
  private byPath = new Map<string, CodeSymbol[]>();
  private mtimes = new Map<string, number>();
  private db: SqliteDb | null = null;
  private opened = false;
  private dbDir: string;

  constructor(
    private cwd: string,
    opts: { dbDir?: string } = {},
  ) {
    this.dbDir = opts.dbDir ?? join(ARTERM_HOME, "symbols");
  }

  /** Total symbols currently indexed. */
  get size(): number {
    let n = 0;
    for (const list of this.byPath.values()) n += list.length;
    return n;
  }

  /** Whether the SQLite persistence layer is active. */
  get persistent(): boolean {
    return this.db !== null;
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    this.db = await openDb(this.cwd, this.dbDir);
    if (!this.db) return;
    // Seed memory from the persisted cache so a refresh only touches changed files.
    for (const row of this.db.prepare("SELECT path, mtime FROM files").all() as {
      path: string;
      mtime: number;
    }[]) {
      this.mtimes.set(row.path, row.mtime);
    }
    for (const row of this.db
      .prepare("SELECT path, name, kind, line, signature FROM symbols")
      .all() as CodeSymbol[]) {
      const list = this.byPath.get(row.path);
      if (list) list.push(row);
      else this.byPath.set(row.path, [row]);
    }
  }

  private persistFile(path: string, mtime: number, symbols: CodeSymbol[]): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
    const ins = this.db.prepare(
      "INSERT INTO symbols (path, name, kind, line, signature) VALUES (?, ?, ?, ?, ?)",
    );
    for (const s of symbols) ins.run(s.path, s.name, s.kind, s.line, s.signature);
    this.db.prepare("INSERT OR REPLACE INTO files (path, mtime) VALUES (?, ?)").run(path, mtime);
  }

  private dropFile(path: string): void {
    this.byPath.delete(path);
    this.mtimes.delete(path);
    if (!this.db) return;
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  /** Walk the tree and (re)parse only changed/new files; forget deleted ones. */
  async refresh(): Promise<void> {
    await this.open();
    const seen = new Set<string>();
    await this.walk(this.cwd, this.cwd, seen);
    for (const path of [...this.mtimes.keys()]) {
      if (!seen.has(path)) this.dropFile(path);
    }
  }

  private async walk(root: string, dir: string, seen: Set<string>): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await this.walk(root, abs, seen);
      } else if (entry.isFile()) {
        await this.indexFile(root, abs, seen);
      }
    }
  }

  private async indexFile(root: string, abs: string, seen: Set<string>): Promise<void> {
    const rel = relative(root, abs).split(sep).join("/");
    if (!SOURCE_EXTS.has(extOf(rel))) return;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) return;
    seen.add(rel);
    if (this.mtimes.get(rel) === stat.mtimeMs) return; // unchanged since last scan

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      return;
    }
    const symbols = extractSymbols(rel, content);
    this.byPath.set(rel, symbols);
    this.mtimes.set(rel, stat.mtimeMs);
    this.persistFile(rel, stat.mtimeMs, symbols);
  }

  /**
   * Rank symbols by name against `query`. Exact name > prefix > substring;
   * shorter names and earlier files break ties. Optional `kind` filter.
   */
  search(query: string, opts: { kind?: SymbolKind; limit?: number } = {}): CodeSymbol[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 20;
    const scored: { s: CodeSymbol; score: number }[] = [];
    for (const list of this.byPath.values()) {
      for (const s of list) {
        if (opts.kind && s.kind !== opts.kind) continue;
        const name = s.name.toLowerCase();
        let score = 0;
        if (name === q) score = 100;
        else if (name.startsWith(q)) score = 60 - name.length;
        else if (name.includes(q)) score = 30 - name.length;
        else continue;
        scored.push({ s, score });
      }
    }
    scored.sort(
      (a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line,
    );
    return scored.slice(0, limit).map((x) => x.s);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
