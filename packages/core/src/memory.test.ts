import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlMemoryStore, type MemoryRecord, NullMemoryStore, projectKey } from "./memory.js";

function rec(title: string, ts: number): MemoryRecord {
  return { id: `id-${title}`, kind: "learning", ts, type: "note", title };
}

describe("projectKey", () => {
  it("is stable and distinct per directory", () => {
    expect(projectKey("/a/b")).toBe(projectKey("/a/b"));
    expect(projectKey("/a/b")).not.toBe(projectKey("/a/c"));
  });
});

describe("NullMemoryStore", () => {
  it("stores nothing", async () => {
    const store = new NullMemoryStore();
    await store.append(rec("x", 1));
    expect(await store.all()).toEqual([]);
    expect(await store.recent(5)).toEqual([]);
  });
});

describe("JsonlMemoryStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `arterm-mem-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends and reads back in order", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append(rec("a", 1));
    await store.append(rec("b", 2));
    const all = await store.all();
    expect(all.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("recent returns the newest N (chronological)", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    for (let i = 0; i < 5; i++) await store.append(rec(`r${i}`, i));
    expect((await store.recent(2)).map((r) => r.title)).toEqual(["r3", "r4"]);
  });

  it("returns empty for a project with no file", async () => {
    const store = new JsonlMemoryStore("/nonexistent", dir);
    expect(await store.all()).toEqual([]);
  });

  it("scopes by project directory", async () => {
    const a = new JsonlMemoryStore("/proj-a", dir);
    const b = new JsonlMemoryStore("/proj-b", dir);
    await a.append(rec("only-a", 1));
    expect((await b.all()).length).toBe(0);
    expect((await a.all()).length).toBe(1);
  });

  it("skips corrupt lines", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append(rec("good", 1));
    const file = join(dir, `${projectKey("/proj")}.jsonl`);
    await fs.appendFile(file, "{ not json\n", "utf8");
    await store.append(rec("good2", 2));
    expect((await store.all()).map((r) => r.title)).toEqual(["good", "good2"]);
  });
});
