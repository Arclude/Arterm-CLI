import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlMemoryStore, type MemoryRecord, NullMemoryStore, projectKey } from "./memory.js";

/**
 * Deletion in an append-only store. Everything here is about the same property:
 * a `remove` that reports success must leave the fact off the disk, and one that
 * reports nothing must leave every other record untouched.
 */

function rec(title: string, ts: number): MemoryRecord {
  return { id: `id-${title}`, kind: "learning", ts, type: "note", title };
}

describe("JsonlMemoryStore.remove", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `arterm-mem-rm-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("drops one record and keeps the rest in order", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    for (const t of ["a", "b", "c"]) await store.append(rec(t, 1));
    expect(await store.remove("id-b")).toBe(true);
    expect((await store.all()).map((r) => r.title)).toEqual(["a", "c"]);
  });

  it("takes the fact off the disk, not just out of the read", async () => {
    // The whole point of forgetting: a tombstone would have satisfied `all()`
    // while leaving the text in ~/.arterm/memory.
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append({ ...rec("secret", 1), body: "hunter2" });
    await store.append(rec("kept", 2));
    expect(await store.remove("id-secret")).toBe(true);
    const raw = await fs.readFile(join(dir, `${projectKey("/proj")}.jsonl`), "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("kept");
  });

  it("reports false for an unknown id and changes nothing", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append(rec("a", 1));
    const before = await fs.readFile(join(dir, `${projectKey("/proj")}.jsonl`), "utf8");
    expect(await store.remove("id-missing")).toBe(false);
    expect(await fs.readFile(join(dir, `${projectKey("/proj")}.jsonl`), "utf8")).toBe(before);
  });

  it("reports false for a project with no file, and creates none", async () => {
    expect(await new JsonlMemoryStore("/nonexistent", dir).remove("id-a")).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("leaves no temp file behind", async () => {
    // The rewrite goes through a sibling temp file; one surviving a normal
    // removal would mean the rename never happened.
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append(rec("a", 1));
    await store.append(rec("b", 2));
    await store.remove("id-a");
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the file appendable afterwards", async () => {
    const store = new JsonlMemoryStore("/proj", dir);
    await store.append(rec("a", 1));
    await store.append(rec("b", 2));
    await store.remove("id-a");
    await store.append(rec("c", 3));
    expect((await store.all()).map((r) => r.title)).toEqual(["b", "c"]);
  });

  it("drops corrupt lines it rewrites past", async () => {
    // Stated rather than incidental: those lines are already invisible to every
    // reader, and the rewrite is what finally clears them out.
    const store = new JsonlMemoryStore("/proj", dir);
    const file = join(dir, `${projectKey("/proj")}.jsonl`);
    await store.append(rec("a", 1));
    await fs.appendFile(file, "{ not json\n", "utf8");
    await store.append(rec("b", 2));
    expect(await store.remove("id-a")).toBe(true);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("not json");
    expect((await store.all()).map((r) => r.title)).toEqual(["b"]);
  });

  it("scopes deletion to the project", async () => {
    const a = new JsonlMemoryStore("/proj-a", dir);
    const b = new JsonlMemoryStore("/proj-b", dir);
    await a.append(rec("shared", 1));
    await b.append(rec("shared", 1));
    expect(await a.remove("id-shared")).toBe(true);
    expect((await b.all()).map((r) => r.title)).toEqual(["shared"]);
  });
});

describe("NullMemoryStore.remove", () => {
  it("removes nothing and says so", async () => {
    expect(await new NullMemoryStore().remove("id-a")).toBe(false);
  });
});
