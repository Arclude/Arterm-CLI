import type { MemoryRecord, MemoryStore } from "@arterm/core";
import { describe, expect, it } from "vitest";
import {
  createForgetTool,
  createMemorySearchTool,
  createRelatedMemoriesTool,
  createRememberTool,
} from "./memoryTools.js";

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
  async remove(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length !== before;
  }
}

/** The shape a store has when it cannot delete — e.g. the MCP cross-project view. */
class ReadOnlyStore implements MemoryStore {
  readonly id = "read-only";
  constructor(public records: MemoryRecord[] = []) {}
  async append(): Promise<void> {}
  async all(): Promise<MemoryRecord[]> {
    return [...this.records];
  }
  async recent(limit: number): Promise<MemoryRecord[]> {
    return limit > 0 ? this.records.slice(-limit) : [...this.records];
  }
}

/** A store that keeps the record despite being asked to drop it. */
class StubbornStore extends FakeStore {
  override async remove(_id: string): Promise<boolean> {
    return false;
  }
}

const ctx = { cwd: "/proj" };

function learning(title: string, body: string, id?: string): MemoryRecord {
  return {
    id: id ?? `${title.toLowerCase().replace(/[^a-z0-9]/g, "")}0000000000000000`,
    kind: "learning",
    ts: 1,
    type: "note",
    title,
    body,
  };
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

  it("prints an id forget can address the record by", async () => {
    // The seam between the two tools: search is the only place an id is shown,
    // so a rendering that dropped it would leave nothing deletable.
    const store = new FakeStore();
    store.records = [learning("Auth flow", "jwt login", "abcd1234ffff0000")];
    const found = await createMemorySearchTool(store).execute({ query: "jwt" }, ctx);
    expect(found.output).toContain("abcd1234");

    const id = (found.output.split(/\s+/)[0] ?? "") as string;
    const res = await createForgetTool(store).execute({ id, title: "Auth flow" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(store.records).toHaveLength(0);
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

describe("forget tool", () => {
  function seeded(): FakeStore {
    const store = new FakeStore();
    store.records = [
      learning("Prefer npm", "installs use npm", "aaaa1111000000000000"),
      learning("Database", "postgres pooling tuned", "bbbb2222000000000000"),
    ];
    return store;
  }

  it("declares itself as a mutating, asking edit", () => {
    // Its two siblings are allow/read; this one destroys the only copy.
    const tool = createForgetTool(new FakeStore());
    expect(tool.permission).toBe("ask");
    expect(tool.category).toBe("edit");
    expect(tool.mutating).toBe(true);
    expect(tool.riskTier).toBe("caution");
  });

  it("names the record in the permission preview, not just the id", () => {
    // preview() only ever sees the arguments, so the quoted title is the only
    // way the human approving the call learns what disappears.
    const tool = createForgetTool(new FakeStore());
    expect(tool.preview?.({ id: "aaaa1111", title: "Prefer npm" })).toContain("Prefer npm");
  });

  it("deletes the addressed record and echoes what it was", async () => {
    const store = seeded();
    const res = await createForgetTool(store).execute(
      { id: "aaaa1111000000000000", title: "Prefer npm" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("Forgotten:");
    expect(res.output).toContain("Prefer npm");
    expect(store.records.map((r) => r.title)).toEqual(["Database"]);
  });

  it("accepts an unambiguous id prefix", async () => {
    const store = seeded();
    const res = await createForgetTool(store).execute({ id: "aaaa", title: "Prefer npm" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(store.records).toHaveLength(1);
  });

  it("tolerates case and spacing in the quoted title", async () => {
    const store = seeded();
    const res = await createForgetTool(store).execute(
      { id: "aaaa1111", title: "  prefer   NPM " },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(store.records).toHaveLength(1);
  });

  it("refuses when the title does not describe the record the id names", async () => {
    // The transposed-hex-digit case: without the witness this deletes a bystander.
    const store = seeded();
    const res = await createForgetTool(store).execute({ id: "bbbb2222", title: "Prefer npm" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Refused");
    expect(res.output).toContain("Database");
    expect(store.records).toHaveLength(2);
  });

  it("refuses an ambiguous prefix and lists the candidates", async () => {
    const store = new FakeStore();
    store.records = [
      learning("One", "first", "dupe1111aaaa"),
      learning("Two", "second", "dupe1111bbbb"),
    ];
    const res = await createForgetTool(store).execute({ id: "dupe", title: "One" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("matches 2 memories");
    expect(res.output).toContain("One");
    expect(res.output).toContain("Two");
    expect(store.records).toHaveLength(2);
  });

  it("reports an id that matches nothing", async () => {
    const store = seeded();
    const res = await createForgetTool(store).execute({ id: "cccc", title: "Prefer npm" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No memory has id");
    expect(store.records).toHaveLength(2);
  });

  it("reports an empty memory rather than a silent success", async () => {
    const res = await createForgetTool(new FakeStore()).execute(
      { id: "aaaa", title: "Anything" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("nothing to forget");
  });

  it("says so when the store cannot delete at all", async () => {
    // A read-only view must not answer a deletion request with a success line.
    const store = new ReadOnlyStore([learning("Prefer npm", "installs", "aaaa1111")]);
    const res = await createForgetTool(store).execute({ id: "aaaa1111", title: "Prefer npm" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("read-only");
    expect(store.records).toHaveLength(1);
  });

  it("does not claim a deletion the store refused", async () => {
    const store = new StubbornStore();
    store.records = [learning("Prefer npm", "installs", "aaaa1111")];
    const res = await createForgetTool(store).execute({ id: "aaaa1111", title: "Prefer npm" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Nothing was removed");
  });

  it("requires both arguments", async () => {
    const store = seeded();
    await expect(createForgetTool(store).execute({ id: "aaaa1111" }, ctx)).rejects.toThrow(/title/);
    await expect(createForgetTool(store).execute({ title: "Prefer npm" }, ctx)).rejects.toThrow(
      /id/,
    );
    expect(store.records).toHaveLength(2);
  });
});

describe("find_related_memories tool", () => {
  function seeded(): FakeStore {
    const store = new FakeStore();
    store.records = [
      learning("Auth flow", "login issues a JWT signed with the session key", "aaaa1111"),
      learning("Token refresh", "the JWT is refreshed by the session key rotation", "bbbb2222"),
      learning("Icons", "the sidebar glyphs come from a sprite sheet", "cccc3333"),
    ];
    return store;
  }

  it("relates free text to the project's memory", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute({ text: "jwt session" }, ctx);
    expect(res.output).toContain("Auth flow");
    expect(res.output).toContain("Token refresh");
    expect(res.output).not.toContain("Icons");
  });

  it("uses an anchor's own text as the query and never returns the anchor", async () => {
    // Returning the anchor would make every call's best hit the thing the
    // caller already had.
    const res = await createRelatedMemoriesTool(seeded()).execute({ id: "aaaa1111" }, ctx);
    expect(res.output).toContain("Related to");
    expect(res.output).toContain("Token refresh");
    const lines = res.output.split("\n").slice(1);
    expect(lines.some((l) => l.startsWith("aaaa1111"))).toBe(false);
  });

  it("does not lose a result slot to the excluded anchor", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute(
      { id: "aaaa1111", limit: 2 },
      ctx,
    );
    expect(res.output.split("\n").slice(1)).toHaveLength(2);
  });

  it("combines an anchor with steering text", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute(
      { id: "aaaa1111", text: "sprite sheet glyphs" },
      ctx,
    );
    expect(res.output).toContain("Icons");
  });

  it("requires an anchor or some text", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("`text`");
  });

  it("reports an unknown anchor id", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute({ id: "zzzz" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No memory has id");
  });

  it("refuses an ambiguous anchor id", async () => {
    const store = new FakeStore();
    store.records = [learning("One", "a", "dupe1111a"), learning("Two", "b", "dupe1111b")];
    const res = await createRelatedMemoriesTool(store).execute({ id: "dupe" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("matches 2 memories");
  });

  it("reports an empty memory", async () => {
    const res = await createRelatedMemoriesTool(new FakeStore()).execute({ text: "x" }, ctx);
    expect(res.output).toBe("Project memory is empty.");
  });

  it("reports when the anchor stands alone", async () => {
    const store = new FakeStore();
    store.records = [learning("Only one", "nothing else is stored", "aaaa1111")];
    const res = await createRelatedMemoriesTool(store).execute({ id: "aaaa1111" }, ctx);
    expect(res.output).toContain("Nothing else in memory relates to aaaa1111");
  });

  it("reports when free text matches nothing", async () => {
    const res = await createRelatedMemoriesTool(seeded()).execute({ text: "kubernetes" }, ctx);
    expect(res.output).toContain("Nothing in memory relates to");
  });
});
