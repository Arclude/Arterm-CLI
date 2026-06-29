import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CatalogModel,
  fetchCatalog,
  findModelById,
  flattenCatalog,
  modelContextWindow,
  modelToolCall,
  searchCatalog,
} from "./modelsDev.js";

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

describe("findModelById", () => {
  const models: CatalogModel[] = [
    ...flattenCatalog(RAW),
    {
      id: "qwen-2.5-coder",
      provider: "alibaba",
      name: "Qwen2.5 Coder",
      toolCall: true,
      contextWindow: 32768,
    },
    // Same id under two providers, to exercise provider preference.
    { id: "shared-model", provider: "a", name: "A's", toolCall: false },
    { id: "shared-model", provider: "b", name: "B's", toolCall: true },
  ];

  it("matches an exact id", () => {
    expect(findModelById(models, "claude-opus-4-8")?.provider).toBe("anthropic");
  });

  it("matches fuzzily across separators and an Ollama-style tag", () => {
    // `qwen2.5-coder:7b` -> normalized `qwen25coder` -> the `qwen-2.5-coder` entry.
    expect(findModelById(models, "qwen2.5-coder:7b")?.id).toBe("qwen-2.5-coder");
  });

  it("prefers the model owned by the requested provider on an id collision", () => {
    expect(findModelById(models, "shared-model", "b")?.provider).toBe("b");
    expect(findModelById(models, "shared-model", "a")?.provider).toBe("a");
  });

  it("returns undefined when nothing matches", () => {
    expect(findModelById(models, "no-such-model")).toBeUndefined();
  });

  it("does not match on a loose prefix", () => {
    expect(findModelById(models, "claude")).toBeUndefined();
  });
});

describe("modelToolCall / modelContextWindow", () => {
  const models = flattenCatalog(RAW);

  it("reports tool-call support for a known model", () => {
    expect(modelToolCall("claude-opus-4-8", "anthropic", models)).toBe(true);
  });

  it("returns undefined for an unknown model so callers keep their heuristic", () => {
    expect(modelToolCall("mystery-model", "ollama", models)).toBeUndefined();
  });

  it("returns undefined when the catalog is empty", () => {
    expect(modelToolCall("claude-opus-4-8", "anthropic", [])).toBeUndefined();
  });

  it("aggregates as TRUE when any matching entry supports tools (intrinsic capability)", () => {
    // Same family across providers with disagreeing metadata — one bad `false`
    // entry must not mask the real capability.
    const split: CatalogModel[] = [
      { id: "qwen2.5-coder-7b-fast", provider: "helicone", toolCall: false },
      { id: "qwen2.5-coder-7b-instruct", provider: "nvidia", toolCall: true },
    ];
    expect(modelToolCall("qwen2.5-coder:7b", undefined, split)).toBe(true);
  });

  it("is FALSE only when every match explicitly denies tools", () => {
    const allFalse: CatalogModel[] = [
      { id: "base-model-1b", provider: "a", toolCall: false },
      { id: "base-model-1b", provider: "b", toolCall: false },
    ];
    expect(modelToolCall("base-model-1b", undefined, allFalse)).toBe(false);
  });

  it("reports the context window for a known model", () => {
    expect(modelContextWindow("claude-opus-4-8", "anthropic", models)).toBe(1000000);
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
