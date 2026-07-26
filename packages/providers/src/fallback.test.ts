import type { ChatChunk, ChatProvider, ChatRequest, ModelInfo } from "@arterm/core";
import { ProviderError } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { FallbackChatProvider, type FallbackNotice, withFallbacks } from "./fallback.js";

/** A provider whose every call either fails with `fail` or answers `reply`. */
class StubProvider implements ChatProvider {
  calls: string[] = [];
  constructor(
    readonly id: string,
    private readonly behavior: { fail?: unknown; reply?: string; emitThenFail?: unknown } = {},
  ) {}
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ name: `${this.id}-model`, provider: this.id, supportsTools: true }];
  }
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.calls.push(req.model);
    if (this.behavior.emitThenFail) {
      yield { type: "text", delta: "partial" };
      throw this.behavior.emitThenFail;
    }
    if (this.behavior.fail) throw this.behavior.fail;
    yield { type: "text", delta: this.behavior.reply ?? "ok" };
    yield { type: "done" };
  }
}

const quota = () =>
  new ProviderError("rate limited", { provider: "primary", kind: "quota", status: 429 });
const auth = () => new ProviderError("bad key", { provider: "primary", kind: "auth", status: 401 });

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function text(chunks: ChatChunk[]): string {
  return chunks
    .filter((c) => c.type === "text")
    .map((c) => c.delta)
    .join("");
}

describe("FallbackChatProvider", () => {
  it("answers from the primary and never touches the fallback", async () => {
    const primary = new StubProvider("primary", { reply: "from primary" });
    const backup = new StubProvider("backup", { reply: "from backup" });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    const out = await collect(chain.chat({ model: "a", messages: [] }));
    expect(text(out)).toBe("from primary");
    expect(backup.calls).toEqual([]);
  });

  it("moves to the next target when the active model is out of quota", async () => {
    const primary = new StubProvider("primary", { fail: quota() });
    const backup = new StubProvider("backup", { reply: "from backup" });
    const notices: FallbackNotice[] = [];
    const chain = new FallbackChatProvider(
      [{ provider: primary }, { provider: backup, model: "big-model" }],
      { onFallback: (n) => notices.push(n) },
    );

    const out = await collect(chain.chat({ model: "small-model", messages: [] }));
    expect(text(out)).toBe("from backup");
    // The fallback target's pinned model is used, not the caller's.
    expect(backup.calls).toEqual(["big-model"]);
    expect(notices).toEqual([
      {
        from: { provider: "primary", model: "small-model" },
        to: { provider: "backup", model: "big-model" },
        reason: "quota",
        detail: "rate limited",
      },
    ]);
  });

  it("keeps walking the chain until one answers", async () => {
    const a = new StubProvider("a", { fail: quota() });
    const b = new StubProvider("b", { fail: quota() });
    const c = new StubProvider("c", { reply: "third time" });
    const chain = new FallbackChatProvider([
      { provider: a },
      { provider: b, model: "mb" },
      { provider: c, model: "mc" },
    ]);

    expect(text(await collect(chain.chat({ model: "ma", messages: [] })))).toBe("third time");
  });

  it("does not burn the chain on a failure every target would share", async () => {
    // A dead key is not fixed by asking a different model — falling through would
    // turn one clear error into three slow ones.
    const primary = new StubProvider("primary", { fail: auth() });
    const backup = new StubProvider("backup", { reply: "unused" });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    await expect(collect(chain.chat({ model: "a", messages: [] }))).rejects.toMatchObject({
      kind: "auth",
    });
    expect(backup.calls).toEqual([]);
  });

  it("does not switch models once output has reached the caller", async () => {
    // Half an answer is already rendered; a second model would splice a different
    // answer onto it.
    const primary = new StubProvider("primary", { emitThenFail: quota() });
    const backup = new StubProvider("backup", { reply: "from backup" });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    const seen: ChatChunk[] = [];
    await expect(
      (async () => {
        for await (const c of chain.chat({ model: "a", messages: [] })) seen.push(c);
      })(),
    ).rejects.toMatchObject({ kind: "quota" });
    expect(backup.calls).toEqual([]);
    expect(text(seen)).toBe("partial");
  });

  it("surfaces the last target's failure when the whole chain is exhausted", async () => {
    const primary = new StubProvider("primary", { fail: quota() });
    const backup = new StubProvider("backup", {
      fail: new ProviderError("backup down", { provider: "backup", kind: "server", status: 500 }),
    });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    await expect(collect(chain.chat({ model: "a", messages: [] }))).rejects.toMatchObject({
      provider: "backup",
      kind: "server",
    });
  });

  it("normalizes a raw transport failure before deciding", async () => {
    const primary = new StubProvider("primary", {
      fail: Object.assign(new TypeError("terminated"), { code: "ECONNRESET" }),
    });
    const backup = new StubProvider("backup", { reply: "from backup" });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    expect(text(await collect(chain.chat({ model: "a", messages: [] })))).toBe("from backup");
  });

  it("propagates cancellation without consuming the chain", async () => {
    const controller = new AbortController();
    const primary = new StubProvider("primary", {
      fail: new DOMException("aborted", "AbortError"),
    });
    const backup = new StubProvider("backup", { reply: "unused" });
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: backup, model: "b" },
    ]);

    controller.abort();
    await expect(
      collect(chain.chat({ model: "a", messages: [], signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(backup.calls).toEqual([]);
  });

  it("stands in for the primary's identity and catalog", async () => {
    const primary = new StubProvider("primary");
    const chain = new FallbackChatProvider([
      { provider: primary },
      { provider: new StubProvider("backup"), model: "b" },
    ]);
    expect(chain.id).toBe("primary");
    expect((await chain.listModels()).map((m) => m.name)).toEqual(["primary-model"]);
  });
});

describe("withFallbacks", () => {
  it("returns the bare provider when nothing is configured", () => {
    const primary = new StubProvider("primary");
    expect(withFallbacks(primary, [])).toBe(primary);
  });

  it("wraps the provider once targets exist", () => {
    const primary = new StubProvider("primary");
    const wrapped = withFallbacks(primary, [{ provider: new StubProvider("b"), model: "m" }]);
    expect(wrapped).not.toBe(primary);
    expect(wrapped.id).toBe("primary");
  });
});
