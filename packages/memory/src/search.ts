import { bm25Search } from "./bm25.js";
import { cosine } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import type { MemStore } from "./store.js";
import type { Observation, SearchResult } from "./types.js";
import { toLegendRow } from "./types.js";

/**
 * Hybrid retrieval: lexical (FTS5 when available, else BM25) fused with semantic
 * cosine over embeddings. Returns compact {@link SearchResult} rows only — never
 * narratives — so callers fetch full detail on demand via `get_observations`.
 */

const WEIGHT_LEXICAL = 0.5;
const WEIGHT_SEMANTIC = 0.5;

/** Concatenated searchable text of an observation (for BM25). */
function obsText(o: Observation): string {
  return [
    o.title,
    o.subtitle ?? "",
    o.facts.join(" "),
    o.narrative,
    o.concepts.join(" "),
    o.filesRead.join(" "),
    o.filesModified.join(" "),
  ].join(" ");
}

/** Normalize a list of `{ id, score }` to [0,1] by max score. */
function normalize(list: { id: number; score: number }[]): Map<number, number> {
  const max = list.reduce((m, x) => Math.max(m, x.score), 0);
  const out = new Map<number, number>();
  if (max <= 0) return out;
  for (const x of list) out.set(x.id, x.score / max);
  return out;
}

/** Hybrid-rank the project's observations for `query`. */
export async function hybridSearch(opts: {
  store: MemStore;
  embedder: Embedder;
  query: string;
  limit: number;
}): Promise<SearchResult[]> {
  const { store, embedder, query, limit } = opts;
  const all = await store.all();
  if (all.length === 0) return [];
  const byId = new Map<number, Observation>(all.map((o) => [o.id, o]));
  const pool = Math.max(limit * 4, limit);

  // Lexical candidates.
  let lexical: { id: number; score: number }[];
  if (store.fts) {
    const ids = await store.ftsSearch(query, pool);
    lexical = ids.map((id, i) => ({ id, score: (ids.length - i) / ids.length }));
  } else {
    lexical = bm25Search(
      all.map((o) => ({ id: o.id, text: obsText(o) })),
      query,
      pool,
    );
  }

  // Semantic candidates.
  const qvec = await embedder.embed(query);
  const semantic: { id: number; score: number }[] = qvec
    ? all
        .filter((o) => o.embedding && o.embedding.length > 0)
        .map((o) => ({ id: o.id, score: cosine(qvec, o.embedding as number[]) }))
        .filter((x) => x.score > 0)
    : [];

  // Fuse normalized scores.
  const lexNorm = normalize(lexical);
  const semNorm = normalize(semantic);
  const combined = new Map<number, number>();
  for (const [id, s] of lexNorm) combined.set(id, (combined.get(id) ?? 0) + WEIGHT_LEXICAL * s);
  for (const [id, s] of semNorm) combined.set(id, (combined.get(id) ?? 0) + WEIGHT_SEMANTIC * s);

  let ranked = [...combined.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  // Nothing matched → surface the most recent observations.
  if (ranked.length === 0) {
    const recent = await store.recent(limit);
    return recent.reverse().map((o) => ({ ...toLegendRow(o), score: 0 }));
  }

  ranked = ranked.slice(0, limit);
  const results: SearchResult[] = [];
  for (const { id, score } of ranked) {
    const o = byId.get(id);
    if (o) results.push({ ...toLegendRow(o), score });
  }
  return results;
}
