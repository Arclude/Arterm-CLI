import type { AgentEvent, EventBus } from "@arterm/core";
import { estimateTokens } from "@arterm/core";
import type { Embedder } from "./embedder.js";
import type { ExtractionMode, RawActivity } from "./mode.js";
import { hashObservation } from "./mode.js";
import type { MemStore } from "./store.js";
import type { Observation, ObservationInput } from "./types.js";

/**
 * Capture + observer pass — the new engine's parallel to `MemoryRecorder`/`digest`
 * in `@arterm/core`. `CmemRecorder` buffers session activity off the event bus and
 * `observe()` runs it through the observer LLM, then persists deduped, embedded,
 * richly-typed observations. Kept separate from the legacy recorder because it maps
 * events to {@link RawActivity} and drives the richer pipeline.
 */

/** Runs a prompt through a model and returns its text (same shape core uses). */
export type Summarizer = (prompt: string) => Promise<string>;

/** Max characters kept per captured activity item (bounds the observer prompt). */
const ACT_TEXT_MAX = 600;
/** Max activity items retained in the buffer (most recent win). */
const ACT_BUFFER_MAX = 120;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Buffers a session's activity from the event bus for the observer pass. */
export class CmemRecorder {
  private buffer: RawActivity[] = [];
  private off?: () => void;
  private pending = 0;
  private threshold = 0;
  private onFlush?: () => void;
  private flushRequested = false;

  /** Start listening on `bus`. Idempotent. */
  attach(bus: EventBus): void {
    if (this.off) return;
    this.off = bus.on((e) => this.onEvent(e));
  }

  /** Stop listening. */
  detach(): void {
    this.off?.();
    this.off = undefined;
  }

  /**
   * Fire `onFlush` once every `threshold` newly-captured items (0 disables). Edge-
   * guarded: fires once per crossing until the next `clear()`.
   */
  setAutoFlush(threshold: number, onFlush: () => void): void {
    this.threshold = threshold;
    this.onFlush = onFlush;
  }

  private onEvent(e: AgentEvent): void {
    if (e.type === "tool_result") {
      const text = e.output.trim();
      if (text) this.push({ source: "tool", label: e.name, text });
    } else if (e.type === "assistant_message") {
      const text = e.message.content.trim();
      if (text) this.push({ source: "assistant", label: "assistant", text });
    } else if (e.type === "goal_set") {
      this.push({ source: "user", label: "goal", text: e.goal });
    }
  }

  private push(item: RawActivity): void {
    this.buffer.push({ ...item, text: truncate(item.text, ACT_TEXT_MAX) });
    if (this.buffer.length > ACT_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - ACT_BUFFER_MAX);
    }
    this.pending++;
    if (this.threshold > 0 && !this.flushRequested && this.pending >= this.threshold) {
      this.flushRequested = true;
      this.onFlush?.();
    }
  }

  /** The buffered activity in capture order. */
  activity(): RawActivity[] {
    return [...this.buffer];
  }

  /** Discard the buffer and reset the periodic window. */
  clear(): void {
    this.buffer = [];
    this.pending = 0;
    this.flushRequested = false;
  }
}

/** Text embedded for semantic recall. */
function embedText(o: { title: string; subtitle?: string; narrative: string }): string {
  return [o.title, o.subtitle ?? "", o.narrative].join(" ").trim();
}

/** Tokens to reload an observation's full detail on demand (savings denominator). */
export function readTokensFor(o: {
  subtitle?: string;
  facts: string[];
  narrative: string;
}): number {
  return estimateTokens([o.subtitle ?? "", o.facts.join(" "), o.narrative].join(" "));
}

/**
 * Compress buffered activity into rich observations via `summarize`, dedup by
 * content hash, embed (best-effort), and persist. Returns the saved observations
 * (empty on nothing-to-do or any failure — never throws).
 */
export async function observe(opts: {
  activity: RawActivity[];
  summarize: Summarizer;
  store: MemStore;
  mode: ExtractionMode;
  embedder: Embedder;
  project: string;
  now?: number;
}): Promise<Observation[]> {
  const { activity, summarize, store, mode, embedder, project } = opts;
  const now = opts.now ?? Date.now();
  if (activity.length === 0) return [];
  try {
    const output = await summarize(mode.buildPrompt(activity));
    const parsed = mode.parse(output);
    if (parsed.length === 0) return [];

    const activityTokens = estimateTokens(activity.map((a) => a.text).join("\n"));
    const discoveryPer = Math.max(1, Math.ceil(activityTokens / parsed.length));

    const saved: Observation[] = [];
    for (const p of parsed) {
      const contentHash = hashObservation(p, project);
      if (await store.hasHash(contentHash)) continue;
      const embedding = await embedder.embed(embedText(p));
      const input: ObservationInput = {
        ts: now,
        project,
        type: p.type,
        title: p.title,
        ...(p.subtitle ? { subtitle: p.subtitle } : {}),
        facts: p.facts,
        narrative: p.narrative,
        concepts: p.concepts,
        filesRead: p.filesRead,
        filesModified: p.filesModified,
        discoveryTokens: discoveryPer,
        readTokens: readTokensFor(p),
        contentHash,
        embedding,
      };
      const id = await store.put(input);
      if (id !== null) saved.push({ ...input, id });
    }
    return saved;
  } catch {
    return [];
  }
}
