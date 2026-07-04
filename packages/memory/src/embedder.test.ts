import { afterEach, describe, expect, it, vi } from "vitest";
import { cosine, createHashEmbedder, createOllamaEmbedder } from "./embedder.js";

describe("cosine", () => {
  it("is 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("is -1 for opposite vectors", () => {
    expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1);
  });
  it("is 0 when a vector is degenerate", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("createHashEmbedder", () => {
  it("is deterministic for the same text", async () => {
    const e = createHashEmbedder(64);
    const a = await e.embed("hello world");
    const b = await e.embed("hello world");
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });
  it("differs for different text and is L2-normalized", async () => {
    const e = createHashEmbedder(64);
    const a = await e.embed("authentication flow");
    const b = await e.embed("database migration");
    expect(a).not.toEqual(b);
    const norm = Math.sqrt((a as number[]).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });
  it("returns null for empty/no-token text", async () => {
    const e = createHashEmbedder(64);
    expect(await e.embed("   ")).toBeNull();
  });
});

describe("createOllamaEmbedder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the embedding on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) })),
    );
    const e = createOllamaEmbedder({ host: "http://x" });
    expect(await e.embed("hi")).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const e = createOllamaEmbedder({ host: "http://x" });
    expect(await e.embed("hi")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const e = createOllamaEmbedder({ host: "http://x" });
    expect(await e.embed("hi")).toBeNull();
  });

  it("passes an abort signal to fetch so the wait is bounded", async () => {
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ embedding: [1] }) };
    });
    vi.stubGlobal("fetch", spy);
    await createOllamaEmbedder({ host: "http://x" }).embed("hi");
    expect(spy).toHaveBeenCalled();
  });

  it("aborts and returns null when the host hangs past the timeout", async () => {
    // Respect the abort signal instead of ever resolving — models a dead host that
    // accepted the socket. Without the timeout this would hang embed() forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    );
    const e = createOllamaEmbedder({ host: "http://x", timeoutMs: 20 });
    expect(await e.embed("hi")).toBeNull();
  });
});
