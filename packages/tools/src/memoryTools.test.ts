import type { MemoryRecord, MemoryStore } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { createMemorySearchTool, createRememberTool } from "./memoryTools.js";

/** In-memory store stub for tests. */
class FakeStore implements MemoryStore {
  readonly id = "fake";
  records: MemoryRecord[] = [];
  async append(record: MemoryRecord): Promise<void> {
    this.records.push(record);
  }
  async all(): Promise<MemoryRecord[]> {
    return [...this.records];
  }
  async recent(limit: number): Promise<MemoryRecord[]> {
    return limit > 0 ? this.records.slice(-limit) : [...this.records];
  }
}

const ctx = { cwd: "/proj" };

function learning(title: string, body: string): MemoryRecord {
  return { id: `id-${title}`, kind: "learning", ts: 1, type: "note", title, body };
}

describe("memory_search tool", () => {
  it("reports an empty memory", async () => {
    const tool = createMemorySearchTool(new FakeStore());
    const res = await tool.execute({ query: "anything" }, ctx);
    expect(res.output).toBe("Project memory is empty.");
  });

  it("ranks matching learnings by relevance", async () => {
    const store = new FakeStore();
    store.records = [
      learning("Auth flow", "we use JWT tokens for login"),
      learning("Database", "postgres connection pooling tuned"),
    ];
    const tool = createMemorySearchTool(store);
    const res = await tool.execute({ query: "jwt login" }, ctx);
    expect(res.output).toContain("Auth flow");
    expect(res.output).not.toContain("Database");
  });

  it("reports when nothing matches", async () => {
    const store = new FakeStore();
    store.records = [learning("Auth", "jwt")];
    const tool = createMemorySearchTool(store);
    const res = await tool.execute({ query: "kubernetes" }, ctx);
    expect(res.output).toContain("No memory matches");
  });
});

describe("remember tool", () => {
  it("persists a learning with defaults", async () => {
    const store = new FakeStore();
    const tool = createRememberTool(store, () => 7);
    const res = await tool.execute({ title: "Prefer pnpm" }, ctx);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ type: "note", title: "Prefer pnpm", ts: 7 });
    expect(res.output).toContain("Remembered:");
  });

  it("honors type, body, and files", async () => {
    const store = new FakeStore();
    const tool = createRememberTool(store, () => 1);
    await tool.execute(
      { title: "API moved", type: "decision", body: "now under /v2", files: ["api.ts"] },
      ctx,
    );
    expect(store.records[0]).toMatchObject({
      type: "decision",
      body: "now under /v2",
      files: ["api.ts"],
    });
  });

  it("clamps an unknown type to note", async () => {
    const store = new FakeStore();
    const tool = createRememberTool(store, () => 1);
    await tool.execute({ title: "X", type: "bogus" }, ctx);
    expect(store.records[0]?.type).toBe("note");
  });
});
