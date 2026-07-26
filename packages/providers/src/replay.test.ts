import { ProviderError } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { withStreamReplay } from "./replay.js";

/** A sleep that never waits but records what backoff was asked for. */
function instantSleep(delays: number[]) {
  return async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    delays.push(ms);
  };
}

/** What `fetch` throws when the socket dies mid-body. */
function socketDeath(): Error {
  return Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("withStreamReplay", () => {
  it("forwards a successful stream untouched", async () => {
    const out = await collect(
      withStreamReplay("ollama", async function* () {
        yield 1;
        yield 2;
      }),
    );
    expect(out).toEqual([1, 2]);
  });

  it("replays a socket death that happened before any output", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const out = await collect(
      withStreamReplay(
        "ollama",
        async function* () {
          attempts++;
          if (attempts === 1) throw socketDeath();
          yield "recovered";
        },
        { sleep: instantSleep(delays) },
      ),
    );
    expect(out).toEqual(["recovered"]);
    expect(attempts).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it("never replays once a chunk has been emitted", async () => {
    // The half-written text is already in the transcript; a second attempt would
    // duplicate it, so the failure has to propagate.
    let attempts = 0;
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of withStreamReplay("ollama", async function* () {
          attempts++;
          yield "half a sentence";
          throw socketDeath();
        })) {
          out.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ name: "ProviderError", kind: "network" });
    expect(attempts).toBe(1);
    expect(out).toEqual(["half a sentence"]);
  });

  it("gives up after the replay budget and throws a ProviderError", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const err = await collect(
      withStreamReplay(
        "openai-compat",
        async function* () {
          attempts++;
          throw socketDeath();
          // biome-ignore lint/correctness/noUnreachable: shapes the generator's yield type
          yield "never";
        },
        { maxReplays: 2, sleep: instantSleep(delays) },
      ),
    ).catch((e: unknown) => e);
    expect(attempts).toBe(3); // the first try plus two replays
    expect(ProviderError.is(err)).toBe(true);
    expect((err as ProviderError).kind).toBe("network");
  });

  it("does not replay a failure that retrying cannot fix", async () => {
    let attempts = 0;
    const err = await collect(
      withStreamReplay("anthropic", async function* () {
        attempts++;
        throw new ProviderError("bad key", { provider: "anthropic", kind: "auth", status: 401 });
        // biome-ignore lint/correctness/noUnreachable: shapes the generator's yield type
        yield "never";
      }),
    ).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect((err as ProviderError).kind).toBe("auth");
  });

  it("does not replay an idle timeout", async () => {
    let attempts = 0;
    const err = await collect(
      withStreamReplay("ollama", async function* () {
        attempts++;
        throw new Error("stream idle: no data for 120000ms");
        // biome-ignore lint/correctness/noUnreachable: shapes the generator's yield type
        yield "never";
      }),
    ).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect((err as ProviderError).kind).toBe("timeout");
  });

  it("propagates cancellation as-is instead of retrying it", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const err = await collect(
      withStreamReplay(
        "ollama",
        async function* () {
          attempts++;
          controller.abort();
          throw new DOMException("aborted", "AbortError");
          // biome-ignore lint/correctness/noUnreachable: shapes the generator's yield type
          yield "never";
        },
        { signal: controller.signal },
      ),
    ).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(ProviderError.is(err)).toBe(false);
    expect((err as Error).name).toBe("AbortError");
  });

  it("normalizes every escaping failure into a ProviderError", async () => {
    const err = await collect(
      withStreamReplay("ollama", async function* () {
        throw new Error("plain old error");
        // biome-ignore lint/correctness/noUnreachable: shapes the generator's yield type
        yield "never";
      }),
    ).catch((e: unknown) => e);
    expect(ProviderError.is(err)).toBe(true);
    expect((err as ProviderError).provider).toBe("ollama");
  });
});
