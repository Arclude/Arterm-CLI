/**
 * Pluggable embeddings for semantic recall. The Ollama embedder talks to the
 * host over `fetch` (no `@arterm/providers` dependency — the URL is passed in);
 * the hash embedder is a deterministic, offline fallback so cosine ranking and
 * tests still work without a model. All embedding is best-effort: any failure
 * yields `null` and callers degrade to lexical search.
 */

/** Produces a dense vector for a piece of text (or null when unavailable). */
export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(text: string): Promise<number[] | null>;
}

/** FNV-1a hash of a token → non-negative 32-bit int. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/**
 * Embedder backed by an Ollama server's `/api/embeddings` endpoint. `host` is the
 * base URL (e.g. `http://127.0.0.1:11434`). Returns `null` on any network/parse
 * error or when the model is missing, so shutdown is never blocked.
 */
export function createOllamaEmbedder(opts: {
  host: string;
  model?: string;
  timeoutMs?: number;
}): Embedder {
  const model = opts.model?.trim() ? opts.model.trim() : "nomic-embed-text";
  const base = opts.host.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10_000;
  return {
    id: `ollama:${model}`,
    dims: 768,
    async embed(text: string): Promise<number[] | null> {
      const prompt = text.trim();
      if (!prompt) return null;
      try {
        // A host that accepts the socket but never responds would otherwise hang
        // embed() forever — it's awaited during recall/digest, so an unbounded wait
        // stalls the whole session (incl. shutdown). The catch below turns the
        // resulting AbortError into a null, matching every other failure path.
        const res = await fetch(`${base}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { embedding?: unknown };
        const vec = data.embedding;
        if (Array.isArray(vec) && vec.length > 0 && vec.every((v) => typeof v === "number")) {
          return vec as number[];
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Deterministic bag-of-words hashing embedder. Gives cosine a lexical signal
 * offline and is fully reproducible for tests. L2-normalized.
 */
export function createHashEmbedder(dims = 256): Embedder {
  return {
    id: "hash",
    dims,
    async embed(text: string): Promise<number[] | null> {
      const vec = new Array<number>(dims).fill(0);
      for (const token of tokenize(text)) {
        const slot = hashToken(token) % dims;
        vec[slot] = (vec[slot] ?? 0) + 1;
      }
      let sumSq = 0;
      for (const v of vec) sumSq += v * v;
      const norm = Math.sqrt(sumSq);
      if (norm === 0) return null;
      return vec.map((v) => v / norm);
    },
  };
}

/** Cosine similarity of two vectors (0 when either is degenerate). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
