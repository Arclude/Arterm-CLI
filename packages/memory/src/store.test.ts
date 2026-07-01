import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemStore } from "./store.js";
import type { MemStore } from "./store.js";
import type { ObservationInput } from "./types.js";

function obs(over: Partial<ObservationInput> = {}): ObservationInput {
  return {
    ts: 1_700_000_000_000,
    project: "proj",
    type: "feature",
    title: "a title",
    subtitle: "a subtitle",
    facts: ["fact one", "fact two"],
    narrative: "the narrative",
    concepts: ["pattern"],
    filesRead: ["a.ts"],
    filesModified: ["b.ts"],
    discoveryTokens: 100,
    readTokens: 20,
    contentHash: `hash-${Math.random()}`,
    embedding: [0.1, 0.2, 0.3],
    ...over,
  };
}

let dir: string;
let store: MemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cmem-store-"));
  store = await openMemStore("/some/project", { dir, sqlite: false });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("openMemStore (in-memory/JSONL backend)", () => {
  it("reports the memory backend without FTS", () => {
    expect(store.id).toBe("memory");
    expect(store.fts).toBe(false);
  });

  it("round-trips put → get preserving arrays and embedding", async () => {
    const id = await store.put(obs({ contentHash: "h1" }));
    expect(id).toBe(1);
    const [got] = await store.get([id as number]);
    expect(got?.facts).toEqual(["fact one", "fact two"]);
    expect(got?.filesModified).toEqual(["b.ts"]);
    expect(got?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("orders recent newest-last and all oldest-first", async () => {
    await store.put(obs({ contentHash: "a", title: "first" }));
    await store.put(obs({ contentHash: "b", title: "second" }));
    await store.put(obs({ contentHash: "c", title: "third" }));
    const recent = await store.recent(2);
    expect(recent.map((o) => o.title)).toEqual(["second", "third"]);
    const all = await store.all();
    expect(all.map((o) => o.title)).toEqual(["first", "second", "third"]);
  });

  it("dedupes by content hash", async () => {
    expect(await store.put(obs({ contentHash: "dup" }))).toBe(1);
    expect(await store.put(obs({ contentHash: "dup" }))).toBeNull();
    expect(await store.hasHash("dup")).toBe(true);
    expect(await store.hasHash("missing")).toBe(false);
  });

  it("returns neighbors around an anchor", async () => {
    for (let i = 0; i < 5; i++) await store.put(obs({ contentHash: `n${i}`, title: `t${i}` }));
    const around = await store.around(3, 1, 1);
    expect(around.map((o) => o.id)).toEqual([2, 3, 4]);
  });

  it("replays JSONL on reopen and continues the id sequence", async () => {
    await store.put(obs({ contentHash: "p1" }));
    await store.put(obs({ contentHash: "p2" }));
    store.close();
    const reopened = await openMemStore("/some/project", { dir, sqlite: false });
    const all = await reopened.all();
    expect(all.map((o) => o.id)).toEqual([1, 2]);
    // Dedup survives the reload.
    expect(await reopened.put(obs({ contentHash: "p1" }))).toBeNull();
    // New ids continue after the replayed max.
    expect(await reopened.put(obs({ contentHash: "p3" }))).toBe(3);
    reopened.close();
  });
});
