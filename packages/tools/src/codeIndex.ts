import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";

/** A single ranked search result pointing at a file:line location. */
export interface SearchHit {
  /** Path relative to the indexed root, with forward slashes. */
  path: string;
  /** BM25 score (higher is more relevant). */
  score: number;
  /** 1-based line number of the most representative matching line. */
  line: number;
  /** Trimmed, length-capped text of that line. */
  snippet: string;
}

interface Doc {
  path: string;
  /** Raw lines of the document, used to pick a representative line per hit. */
  lines: string[];
  /** Term -> frequency within this document. */
  termFreq: Map<string, number>;
  /** Total number of tokens in this document. */
  length: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const SNIPPET_MAX = 120;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".arterm"]);

/** Lowercase and split into alphanumeric runs; empty tokens are dropped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/**
 * A pure in-memory BM25 index over text documents. It can be populated directly
 * via `addDocument` (no filesystem, for tests) or by walking a directory with
 * `buildFromDir`. `search` returns the best file:line locations for a query.
 */
export class CodeIndex {
  private docs: Doc[] = [];
  /** Term -> number of documents that contain it (document frequency). */
  private docFreq = new Map<string, number>();
  private totalLength = 0;

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.length;
  }

  /** Tokenize `content` and add it to the corpus under `path`. */
  addDocument(path: string, content: string): void {
    const lines = content.split("\n");
    const tokens = tokenize(content);
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    for (const term of termFreq.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
    this.totalLength += tokens.length;
    this.docs.push({ path, lines, termFreq, length: tokens.length });
  }

  /**
   * Recursively walk `cwd`, skipping ignored/hidden dirs, oversized files, and
   * binary files, and add every readable UTF-8 file to the index. Paths are
   * stored relative to `cwd` with forward slashes.
   */
  async buildFromDir(cwd: string): Promise<void> {
    await this.walk(cwd, cwd);
  }

  private async walk(cwd: string, dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const name = entry.name;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        await this.walk(cwd, abs);
      } else if (entry.isFile()) {
        await this.addFile(cwd, abs);
      }
    }
  }

  private async addFile(cwd: string, abs: string): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) return;
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      return;
    }
    // Skip files that look binary (contain a NUL byte).
    if (content.includes(String.fromCharCode(0))) return;
    const rel = relative(cwd, abs).split(sep).join("/");
    this.addDocument(rel, content);
  }

  /** BM25-rank the corpus for `query` and return up to `limit` hits. */
  search(query: string, limit = 10): SearchHit[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    const uniqueQueryTerms = [...new Set(queryTerms)];
    const n = this.docs.length;
    const avgDocLen = this.totalLength / n;

    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of uniqueQueryTerms) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgDocLen);
        score += idf * ((tf * (BM25_K1 + 1)) / denom);
      }
      if (score <= 0) continue;
      const { line, snippet } = bestLine(doc, uniqueQueryTerms);
      hits.push({ path: doc.path, score, line, snippet });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/**
 * Pick the line in `doc` that contains the most distinct query terms (ties go to
 * the earlier line). Returns a 1-based line number and a trimmed/capped snippet.
 */
function bestLine(doc: Doc, queryTerms: string[]): { line: number; snippet: string } {
  const wanted = new Set(queryTerms);
  let bestIdx = 0;
  let bestCount = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    const lineTokens = new Set(tokenize(doc.lines[i] ?? ""));
    let count = 0;
    for (const term of wanted) {
      if (lineTokens.has(term)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestIdx = i;
    }
  }
  const raw = (doc.lines[bestIdx] ?? "").trim();
  const snippet = raw.length > SNIPPET_MAX ? `${raw.slice(0, SNIPPET_MAX - 3)}...` : raw;
  return { line: bestIdx + 1, snippet };
}
