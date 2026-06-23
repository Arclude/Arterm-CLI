import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CatalogModel, fetchCatalog, flattenCatalog, searchCatalog } from "./modelsDev.js";

const RAW = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        tool_call: true,
        cost: { input: 5, output: 25 },
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
  ollama: {
    name: "Ollama",
    models: {
      "qwen2.5:7b": { id: "qwen2.5:7b", name: "Qwen2.5 7B", tool_call: true },
    },
  },
};

describe("flattenCatalog", () => {
  it("flattens provider→models into a list with cost/limit fields", () => {
    const models = flattenCatalog(RAW);
    expect(models).toHaveLength(2);
    const opus = models.find((m) => m.id === "claude-opus-4-8");
    expect(opus).toMatchObject({
      provider: "anthropic",
      contextWindow: 1000000,
      maxOutput: 128000,
      inputCost: 5,
      outputCost: 25,
      toolCall: true,
    });
  });

  it("returns [] for non-object input", () => {
    expect(flattenCatalog(null)).toEqual([]);
    expect(flattenCatalog("nope")).toEqual([]);
  });
});

describe("searchCatalog", () => {
  const models: CatalogModel[] = flattenCatalog(RAW);

  it("returns all (capped) for an empty query", () => {
    expect(searchCatalog(models, "")).toHaveLength(2);
  });

  it("filters by a term across id/name/provider", () => {
    expect(searchCatalog(models, "opus").map((m) => m.id)).toEqual(["claude-opus-4-8"]);
    expect(searchCatalog(models, "ollama").map((m) => m.id)).toEqual(["qwen2.5:7b"]);
  });

  it("requires all terms to match", () => {
    expect(searchCatalog(models, "claude qwen")).toEqual([]);
  });
});

describe("fetchCatalog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-catalog-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads a fresh cache without hitting the network", async () => {
    await fs.writeFile(join(dir, "models-dev.json"), JSON.stringify(RAW), "utf8");
    const models = await fetchCatalog({ dir, ttlMs: 60_000 });
    expect(models.map((m) => m.id).sort()).toEqual(["claude-opus-4-8", "qwen2.5:7b"]);
  });
});
