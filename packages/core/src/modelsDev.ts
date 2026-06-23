import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME } from "./config.js";

/**
 * The models.dev catalog (~140 providers / thousands of models) for model
 * discovery and the type-to-search picker. Fetched once and cached under
 * ARTERM_HOME; falls back to a stale cache (or []) when offline.
 */

const CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "models-dev.json";

export interface CatalogModel {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** USD per 1M input tokens. */
  inputCost?: number;
  /** USD per 1M output tokens. */
  outputCost?: number;
  toolCall?: boolean;
}

/** Flatten the raw models.dev catalog (provider → models map) into a flat list. */
export function flattenCatalog(raw: unknown): CatalogModel[] {
  const out: CatalogModel[] = [];
  if (!raw || typeof raw !== "object") return out;
  for (const [providerId, prov] of Object.entries(raw as Record<string, unknown>)) {
    const models = (prov as { models?: Record<string, unknown> }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, m] of Object.entries(models)) {
      const model = m as {
        id?: string;
        name?: string;
        tool_call?: boolean;
        cost?: { input?: number; output?: number };
        limit?: { context?: number; output?: number };
      };
      out.push({
        id: model.id ?? modelId,
        provider: providerId,
        name: model.name,
        contextWindow: model.limit?.context,
        maxOutput: model.limit?.output,
        inputCost: model.cost?.input,
        outputCost: model.cost?.output,
        toolCall: model.tool_call,
      });
    }
  }
  return out;
}

/** Rank-filter catalog models by a query over id / name / provider (all terms must match). */
export function searchCatalog(models: CatalogModel[], query: string, limit = 30): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const terms = q.split(/\s+/);
  const scored: { m: CatalogModel; score: number }[] = [];
  for (const m of models) {
    const haystack = `${m.id} ${m.name ?? ""} ${m.provider}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    let score = 0;
    const id = m.id.toLowerCase();
    for (const t of terms) {
      if (id.includes(t)) score += 2;
      if (m.provider.toLowerCase().includes(t)) score += 1;
    }
    scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || a.m.id.length - b.m.id.length);
  return scored.slice(0, limit).map((s) => s.m);
}

/**
 * Returns the models.dev catalog as a flat list. Uses a cache under `dir`
 * (default ARTERM_HOME) when fresh; otherwise fetches and re-caches. On network
 * failure falls back to a stale cache, then to [].
 */
export async function fetchCatalog(
  opts: { ttlMs?: number; dir?: string } = {},
): Promise<CatalogModel[]> {
  const dir = opts.dir ?? ARTERM_HOME;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = join(dir, CACHE_FILE);

  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs < ttl) {
      return flattenCatalog(JSON.parse(await fs.readFile(cachePath, "utf8")));
    }
  } catch {
    // No cache yet.
  }

  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const text = await res.text();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(cachePath, text, "utf8");
      return flattenCatalog(JSON.parse(text));
    }
  } catch {
    // Network failure — fall through to stale cache.
  }

  try {
    return flattenCatalog(JSON.parse(await fs.readFile(cachePath, "utf8")));
  } catch {
    return [];
  }
}
