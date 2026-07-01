import type { ArtermConfig, EventBus, Tool } from "@arterm/core";
import { projectKey } from "@arterm/core";
import type { Embedder } from "./embedder.js";
import { createHashEmbedder, createOllamaEmbedder } from "./embedder.js";
import { defaultMode } from "./mode.js";
import type { ExtractionMode } from "./mode.js";
import { CmemRecorder, observe } from "./observer.js";
import type { Summarizer } from "./observer.js";
import { computeSavings, renderLegend } from "./recall.js";
import type { MemStore } from "./store.js";
import { openMemStore } from "./store.js";
import { createCmemTools } from "./tools.js";
import { toLegendRow } from "./types.js";

/**
 * The composed rich-memory engine. Owns the store, the capture recorder, the
 * embedder, and the extraction mode, and exposes the four seams the CLI wires in:
 * `attach(bus)` (capture), `recall()` (session-start legend), `tools()` (agent
 * tools), and `observe()` (compress buffered activity at flush / session end).
 */
export interface CmemEngine {
  readonly store: MemStore;
  readonly recorder: CmemRecorder;
  attach(bus: EventBus): void;
  detach(): void;
  /** The compact session-start legend + savings figure (empty when no memory). */
  recall(): Promise<string>;
  /** The progressive-disclosure tool set. */
  tools(): Tool[];
  /** Run the observer over buffered activity, then clear the buffer. */
  observe(): Promise<void>;
  /** Release the store handle. */
  close(): void;
}

/**
 * Build the rich-memory engine for a session. Opens the store under
 * `~/.arterm/cmem/`, selects the embedder (Ollama unless `memory.embeddings` is
 * false), and closes over `summarize` (the session's one-shot summarizer) for the
 * observer pass.
 */
export async function createCmemEngine(opts: {
  cwd: string;
  config: ArtermConfig;
  summarize: Summarizer;
  embedHost: string;
  mode?: ExtractionMode;
}): Promise<CmemEngine> {
  const project = projectKey(opts.cwd);
  const store = await openMemStore(opts.cwd);
  const mode = opts.mode ?? defaultMode;
  const useEmbeddings = opts.config.memory?.embeddings !== false;
  const embedder: Embedder = useEmbeddings
    ? createOllamaEmbedder({ host: opts.embedHost, model: opts.config.memory?.embedModel })
    : createHashEmbedder();
  const recorder = new CmemRecorder();
  const legendLimit = opts.config.memory?.legendLimit ?? 12;

  return {
    store,
    recorder,
    attach(bus) {
      recorder.attach(bus);
    },
    detach() {
      recorder.detach();
    },
    async recall() {
      try {
        const recent = await store.recent(legendLimit);
        if (recent.length === 0) return "";
        return renderLegend(recent.map(toLegendRow), computeSavings(recent));
      } catch {
        return "";
      }
    },
    tools() {
      return createCmemTools({ store, embedder, project });
    },
    async observe() {
      const activity = recorder.activity();
      if (activity.length === 0) return;
      await observe({ activity, summarize: opts.summarize, store, mode, embedder, project });
      recorder.clear();
    },
    close() {
      store.close();
    },
  };
}
