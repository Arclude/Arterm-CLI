/**
 * The richer observation model for `@arterm/memory` — a fuller claude-mem clone.
 *
 * Unlike the legacy `MemoryRecord` in `@arterm/core` (a flat title/body/files
 * learning), an {@link Observation} carries a typed icon, a subtitle, structured
 * facts/concepts, separate read/modified file lists, and token bookkeeping used
 * to render the session-start legend and its "tokens saved" figure. The `id` is a
 * monotonic per-project rowid — the durable `#ID` the model references when it
 * calls `get_observations`.
 */

/** Coarse classification of an observation, mirroring claude-mem's typed memory. */
export type ObsType = "bugfix" | "feature" | "refactor" | "change" | "discovery" | "decision";

/** All observation types, in display order (drives the legend header). */
export const OBS_TYPES: readonly ObsType[] = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
];

/** Emoji shown for each type in the legend and compact rows. */
export const TYPE_ICON: Record<ObsType, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

/** Clamp an arbitrary string to a known {@link ObsType}, defaulting to "discovery". */
export function toObsType(raw: string | undefined): ObsType {
  const t = (raw ?? "").trim().toLowerCase();
  return (OBS_TYPES as readonly string[]).includes(t) ? (t as ObsType) : "discovery";
}

/** One persisted observation. `id` is assigned by the store on write. */
export interface Observation {
  /** Monotonic per-project rowid — the durable `#ID` used by `get_observations`. */
  id: number;
  /** Epoch milliseconds the observation was written. */
  ts: number;
  /** Stable per-project key (matches `projectKey(cwd)` from @arterm/core). */
  project: string;
  type: ObsType;
  /** Short one-line title (shown in the legend). */
  title: string;
  /** One-sentence explanation (≤ ~24 words). */
  subtitle?: string;
  /** Self-contained factual statements. */
  facts: string[];
  /** Full context: what / how / why. The expensive field fetched on demand. */
  narrative: string;
  /** 2–5 tags from a fixed vocabulary (how-it-works, gotcha, trade-off, …). */
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  /** Estimated tokens originally spent producing this (savings numerator). */
  discoveryTokens: number;
  /** Estimated tokens to reload full detail on demand (savings denominator). */
  readTokens: number;
  /** sha1 over normalized fields — dedup guard. */
  contentHash: string;
  /** Semantic embedding, or null when embeddings are unavailable. */
  embedding?: number[] | null;
}

/** An observation ready to persist, before the store assigns its `id`. */
export type ObservationInput = Omit<Observation, "id">;

/** Compact projection of an observation for the legend / search results. */
export interface LegendRow {
  id: number;
  ts: number;
  type: ObsType;
  title: string;
  readTokens: number;
}

/** A ranked search hit — a compact row plus its relevance score. */
export interface SearchResult extends LegendRow {
  score: number;
}

/** Project a full observation down to its compact legend row. */
export function toLegendRow(o: Observation): LegendRow {
  return { id: o.id, ts: o.ts, type: o.type, title: o.title, readTokens: o.readTokens };
}
