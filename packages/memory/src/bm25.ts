/**
 * A tiny, self-contained BM25 ranker used as the lexical fallback when SQLite
 * FTS5 is unavailable. This is a deliberate copy of the scoring core in
 * `@arterm/tools`' `codeIndex.ts` (kept here to avoid a memory→tools dependency),
 * adapted to rank observations by numeric id rather than file path.
 */

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Lowercase and split into alphanumeric runs; empty tokens are dropped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/** A document to rank: an observation id and its searchable text. */
export interface Bm25Doc {
  id: number;
  text: string;
}

/** BM25-rank `docs` for `query`, returning up to `limit` `{ id, score }` hits. */
export function bm25Search(
  docs: Bm25Doc[],
  query: string,
  limit: number,
): { id: number; score: number }[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const docFreq = new Map<string, number>();
  const prepared = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const termFreq = new Map<string, number>();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    for (const term of termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    return { id: doc.id, termFreq, length: tokens.length };
  });

  const n = prepared.length;
  const totalLength = prepared.reduce((sum, d) => sum + d.length, 0);
  const avgDocLen = totalLength / n || 1;

  const hits: { id: number; score: number }[] = [];
  for (const doc of prepared) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgDocLen);
      score += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    if (score > 0) hits.push({ id: doc.id, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
