import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlSessionStore, NullSessionStore } from "./sessionStore.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-sessions-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Create N session files, oldest first, with increasing mtimes. */
async function seed(store: JsonlSessionStore, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const handle = await store.create({ model: "m", provider: "ollama" });
    await handle.logMessage({ role: "user", content: `msg ${i}` });
    ids.push(handle.id);
    // Stamp ascending mtimes so ordering is deterministic (i = newest last).
    await fs.utimes(join(dir, `${handle.id}.jsonl`), new Date(), new Date(1_000_000 + i * 10_000));
  }
  return ids;
}

describe("JsonlSessionStore", () => {
  it("writes a session file and lists it", async () => {
    const store = new JsonlSessionStore(dir);
    const handle = await store.create({ model: "llama3.2", provider: "ollama" });
    await handle.logMessage({ role: "user", content: "hi" });
    const list = await store.list();
    expect(list.map((s) => s.id)).toContain(handle.id);
  });

  it("prune(maxSessions) keeps the N newest and returns the removed ids", async () => {
    const store = new JsonlSessionStore(dir);
    const ids = await seed(store, 5); // ids[4] newest by mtime
    const removed = await store.prune({ maxSessions: 2 });
    expect(removed).toHaveLength(3);
    const remaining = (await store.list()).map((s) => s.id).sort();
    expect(remaining).toEqual([ids[3], ids[4]].sort());
  });

  it("prune(maxAgeDays) deletes files older than the cutoff", async () => {
    const store = new JsonlSessionStore(dir);
    const handle = await store.create({ model: "m", provider: "ollama" });
    const old = new Date(Date.now() - 10 * 86_400_000);
    await fs.utimes(join(dir, `${handle.id}.jsonl`), old, old);
    const removed = await store.prune({ maxAgeDays: 1 });
    expect(removed).toEqual([handle.id]);
    expect(await store.list()).toHaveLength(0);
  });

  it("prune is a no-op with no policy", async () => {
    const store = new JsonlSessionStore(dir);
    await seed(store, 3);
    expect(await store.prune({})).toEqual([]);
    expect(await store.list()).toHaveLength(3);
  });

  it("list returns [] when the dir does not exist", async () => {
    const store = new JsonlSessionStore(join(dir, "missing"));
    expect(await store.list()).toEqual([]);
  });
});

describe("NullSessionStore", () => {
  it("writes nothing and lists/prunes empty", async () => {
    const store = new NullSessionStore();
    const handle = await store.create();
    await handle.logMessage({ role: "user", content: "hi" }); // no throw, no write
    expect(handle.id).toMatch(/[0-9a-f-]{36}/);
    expect(await store.list()).toEqual([]);
    expect(await store.prune({ maxSessions: 1 })).toEqual([]);
  });
});
