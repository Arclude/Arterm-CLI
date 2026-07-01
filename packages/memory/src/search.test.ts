import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHashEmbedder } from "./embedder.js";
import { hybridSearch } from "./search.js";
import { openMemStore } from "./store.js";
import type { MemStore } from "./store.js";
import type { ObservationInput } from "./types.js";

const embedder = createHashEmbedder(128);

async function seed(
  store: MemStore,
  title: string,
  narrative: string,
  hash: string,
): Promise<void> {
  const embedding = await embedder.embed(`${title} ${narrative}`);
  const input: ObservationInput = {
    ts: 1_700_000_000_000,
    project: "proj",
    type: "discovery",
    title,
    facts: [],
    narrative,
    concepts: [],
    filesRead: [],
    filesModified: [],
    discoveryTokens: 100,
    readTokens: 20,
    contentHash: hash,
    embedding,
  };
  await store.put(input);
}

let dir: string;
let store: MemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cmem-search-"));
  store = await openMemStore("/p", { dir, sqlite: false });
  await seed(store, "authentication and oauth login", "PKCE token refresh flow", "h1");
  await seed(store, "sqlite symbol index", "regex extraction cached on disk", "h2");
  await seed(store, "terminal ui scrolling", "mouse wheel viewport handling", "h3");
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("hybridSearch (BM25 + cosine fallback path)", () => {
  it("ranks the lexically relevant observation first", async () => {
    const hits = await hybridSearch({ store, embedder, query: "oauth login token", limit: 3 });
    expect(hits[0]?.title).toContain("oauth");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns compact rows only (no narrative)", async () => {
    const hits = await hybridSearch({ store, embedder, query: "sqlite index", limit: 3 });
    const top = hits[0];
    expect(top?.title).toContain("sqlite");
    expect(top).not.toHaveProperty("narrative");
    expect(typeof top?.readTokens).toBe("number");
  });

  it("dedupes ids across lexical and semantic candidates", async () => {
    const hits = await hybridSearch({ store, embedder, query: "oauth", limit: 5 });
    const ids = hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to recent when nothing matches", async () => {
    const hits = await hybridSearch({ store, embedder, query: "zzzznomatch", limit: 2 });
    expect(hits.length).toBe(2);
  });
});
