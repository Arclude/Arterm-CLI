import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHashEmbedder } from "./embedder.js";
import { defaultMode } from "./mode.js";
import type { RawActivity } from "./mode.js";
import { observe } from "./observer.js";
import type { Summarizer } from "./observer.js";
import { openMemStore } from "./store.js";
import type { MemStore } from "./store.js";

const OUTPUT = `### Wired OAuth into the provider registry
TYPE: feature
SUBTITLE: registry prefers OAuth tokens over API keys for Anthropic
FACTS: createProvider resolves an access-token resolver; hasCredentials unified
NARRATIVE: The registry now stores OAuth tokens and auto-refreshes them, preferring them over API keys.
CONCEPTS: how-it-works, what-changed
FILES_MODIFIED: packages/providers/src/registry.ts`;

const activity: RawActivity[] = [
  { source: "tool", label: "read", text: "registry.ts contents" },
  { source: "assistant", label: "assistant", text: "wiring oauth" },
];

const embedder = createHashEmbedder(64);

let dir: string;
let store: MemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cmem-observer-"));
  store = await openMemStore("/p", { dir, sqlite: false });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("observe", () => {
  it("persists parsed observations with embeddings and token bookkeeping", async () => {
    const summarize: Summarizer = async () => OUTPUT;
    const saved = await observe({
      activity,
      summarize,
      store,
      mode: defaultMode,
      embedder,
      project: "proj",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.type).toBe("feature");
    expect(saved[0]?.embedding?.length).toBe(64);
    expect(saved[0]?.discoveryTokens).toBeGreaterThan(0);
    expect(saved[0]?.readTokens).toBeGreaterThan(0);
    expect(await store.all()).toHaveLength(1);
  });

  it("dedupes identical observations across runs", async () => {
    const summarize: Summarizer = async () => OUTPUT;
    await observe({ activity, summarize, store, mode: defaultMode, embedder, project: "proj" });
    const second = await observe({
      activity,
      summarize,
      store,
      mode: defaultMode,
      embedder,
      project: "proj",
    });
    expect(second).toHaveLength(0);
    expect(await store.all()).toHaveLength(1);
  });

  it("returns [] when the model produces NONE", async () => {
    const summarize: Summarizer = async () => "NONE";
    const saved = await observe({
      activity,
      summarize,
      store,
      mode: defaultMode,
      embedder,
      project: "proj",
    });
    expect(saved).toEqual([]);
  });

  it("returns [] for empty activity", async () => {
    const saved = await observe({
      activity: [],
      summarize: async () => OUTPUT,
      store,
      mode: defaultMode,
      embedder,
      project: "proj",
    });
    expect(saved).toEqual([]);
  });
});
