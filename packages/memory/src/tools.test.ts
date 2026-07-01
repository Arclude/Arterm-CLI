import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHashEmbedder } from "./embedder.js";
import { openMemStore } from "./store.js";
import type { MemStore } from "./store.js";
import { createCmemTools } from "./tools.js";

const embedder = createHashEmbedder(64);

let dir: string;
let store: MemStore;
let tools: Record<string, Tool>;

async function run(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools[name];
  if (!tool) throw new Error(`no tool ${name}`);
  const res = await tool.execute(args, { cwd: "/p" });
  return res.output;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cmem-tools-"));
  store = await openMemStore("/p", { dir, sqlite: false });
  const list = createCmemTools({ store, embedder, project: "proj" });
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("createCmemTools", () => {
  it("exposes the four progressive-disclosure tools as read/allow", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "get_observations",
      "mem_search",
      "remember_observation",
      "timeline",
    ]);
    for (const t of Object.values(tools)) {
      expect(t.category).toBe("read");
      expect(t.permission).toBe("allow");
    }
  });

  it("remember_observation persists and dedupes", async () => {
    const first = await run("remember_observation", {
      type: "decision",
      title: "use sqlite for the store",
      narrative: "chosen over jsonl for FTS and scale",
    });
    expect(first).toContain("Remembered #1");
    const dup = await run("remember_observation", {
      type: "decision",
      title: "use sqlite for the store",
      narrative: "chosen over jsonl for FTS and scale",
    });
    expect(dup).toContain("Already remembered");
    expect(await store.all()).toHaveLength(1);
  });

  it("mem_search returns compact rows without the narrative", async () => {
    await run("remember_observation", {
      type: "feature",
      title: "oauth login flow",
      narrative: "secret-narrative-token about PKCE",
    });
    const out = await run("mem_search", { query: "oauth login" });
    expect(out).toContain("#1");
    expect(out).toContain("oauth login flow");
    expect(out).not.toContain("secret-narrative-token");
  });

  it("get_observations expands full detail and notes unknown ids", async () => {
    await run("remember_observation", {
      type: "feature",
      title: "oauth login flow",
      narrative: "secret-narrative-token about PKCE",
    });
    const out = await run("get_observations", { ids: [1, 999] });
    expect(out).toContain("secret-narrative-token");
    expect(out).toContain("not found: 999");
  });

  it("timeline returns compact neighbors around an anchor", async () => {
    for (let i = 0; i < 4; i++) {
      await run("remember_observation", { type: "change", title: `step ${i}`, narrative: `n${i}` });
    }
    const out = await run("timeline", { anchor: 2, before: 1, after: 1 });
    expect(out).toContain("#1");
    expect(out).toContain("#2");
    expect(out).toContain("#3");
    expect(out).not.toContain("#4");
  });
});
