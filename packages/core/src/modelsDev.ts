import { readFileSync } from "node:fs";
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
      if (dir === ARTERM_HOME) clearCatalogMemo(); // keep the sync read current
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

/** Drop an Ollama-style `:tag`, lowercase, and strip separators for fuzzy compare. */
function normalizeId(id: string): string {
  const noTag = id.includes(":") ? (id.split(":")[0] ?? id) : id;
  return noTag.toLowerCase().replace(/[\s._/-]+/g, "");
}

/** The leaf of a namespaced catalog id, e.g. `@cf/qwen/qwen2.5-coder-32b` -> `qwen2.5-coder-32b`. */
function leafId(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] ?? id;
}

/** Size tokens like `7b`, `32b`, `1.5b` anywhere in a model id (catalog ids embed the size). */
function sizeTokens(id: string): string[] {
  return id.toLowerCase().match(/\d+(?:\.\d+)?b\b/g) ?? [];
}

/** Pick the most "base" candidate (shortest id), preferring the requested provider. */
function pickBest(candidates: CatalogModel[], providerId?: string): CatalogModel | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => a.id.length - b.id.length);
  return sorted.find((m) => m.provider === providerId) ?? sorted[0];
}

/**
 * All catalog entries matching `modelId`, from the most precise tier that yields
 * any hit. The catalog lists the same model under many providers (often with
 * inconsistent metadata), so callers that care about an intrinsic property —
 * "does this model support tools?" — should aggregate across the whole set
 * rather than trust a single entry. Tiers, most precise first:
 *   1. exact id
 *   2. normalized whole-id OR leaf OR name equality (handles namespace prefixes
 *      like `meta/llama-3.2-3b` and separators)
 *   3. family match — only when the query carries a version/size digit (so bare
 *      names like `claude` never match): leaf starts with the query core, and if
 *      the query has a size (`:7b`) the candidate must carry it too. This lets
 *      `qwen2.5-coder:7b` find `qwen2.5-coder-7b-fast` and `llama3.2` find
 *      `llama-3.2-3b-instruct`.
 */
function matchModels(models: CatalogModel[], modelId: string): CatalogModel[] {
  const exact = models.filter((m) => m.id === modelId);
  if (exact.length > 0) return exact;

  const want = normalizeId(modelId);
  const normEq = models.filter(
    (m) =>
      normalizeId(m.id) === want ||
      normalizeId(leafId(m.id)) === want ||
      (m.name !== undefined && normalizeId(m.name) === want),
  );
  if (normEq.length > 0) return normEq;

  // Tier 3 — gated on a digit so it can't fire for a bare family name.
  if (!/\d/.test(modelId)) return [];
  const sizes = sizeTokens(modelId);
  return models.filter((m) => {
    const leaf = normalizeId(leafId(m.id));
    if (!leaf.startsWith(want)) return false;
    return sizes.length === 0 || sizes.some((s) => leafId(m.id).toLowerCase().includes(s));
  });
}

/**
 * Find a single best catalog model by id (most base variant, preferring
 * `providerId`). Use this for display facts like context window and pricing.
 * For tool-call support prefer {@link modelToolCall}, which aggregates.
 */
export function findModelById(
  models: CatalogModel[],
  modelId: string,
  providerId?: string,
): CatalogModel | undefined {
  return pickBest(matchModels(models, modelId), providerId);
}

let memo: { loaded: boolean; data: CatalogModel[] } = { loaded: false, data: [] };

/**
 * Synchronous, memoized read of the on-disk catalog cache (flattened) — for hot
 * paths like a provider's `supportsNativeTools` that can't await. Returns [] when
 * no cache exists yet (caller falls back to its heuristic). Populated whenever
 * `fetchCatalog` refreshes the default-dir cache.
 */
export function cachedCatalogSync(): CatalogModel[] {
  if (memo.loaded) return memo.data;
  try {
    const raw = JSON.parse(readFileSync(join(ARTERM_HOME, CACHE_FILE), "utf8"));
    memo = { loaded: true, data: flattenCatalog(raw) };
  } catch {
    memo = { loaded: true, data: [] };
  }
  return memo.data;
}

/** Drop the sync memo (tests, or after a refresh writes a new cache). */
export function clearCatalogMemo(): void {
  memo = { loaded: false, data: [] };
}

/**
 * Whether `modelId` supports native tool calls per the catalog. Tool-calling is
 * an intrinsic property of the weights, but the catalog's per-provider entries
 * disagree (some omit or mis-set `tool_call`), so we aggregate: TRUE if ANY
 * matching entry reports support, FALSE only if matches exist and all explicitly
 * deny it, and UNDEFINED when the model isn't found (caller keeps its heuristic).
 * Because of this asymmetry, callers should treat the catalog as able to *add*
 * tool support, not retract a heuristic's. Reads the sync cache when no list is given.
 */
export function modelToolCall(
  modelId: string,
  providerId?: string,
  models?: CatalogModel[],
): boolean | undefined {
  const list = models ?? cachedCatalogSync();
  if (list.length === 0) return undefined;
  const matches = matchModels(list, modelId);
  if (matches.length === 0) return undefined;
  if (matches.some((m) => m.toolCall === true)) return true;
  if (matches.some((m) => m.toolCall === false)) return false;
  return undefined;
}

/** A model's context window (input token limit) from the catalog, or undefined. */
export function modelContextWindow(
  modelId: string,
  providerId?: string,
  models?: CatalogModel[],
): number | undefined {
  const list = models ?? cachedCatalogSync();
  if (list.length === 0) return undefined;
  return findModelById(list, modelId, providerId)?.contextWindow;
}
