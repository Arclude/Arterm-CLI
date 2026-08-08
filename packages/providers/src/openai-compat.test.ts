import type { ChatChunk } from "@arterm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "./openai-compat.js";

/** An SSE body of the shape these servers stream. */
function sseResponse(events: object[]): Response {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

/** A 200 whose body dies the way a dropped socket does, before any content. */
function dyingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        }),
      );
    },
  });
  return new Response(stream, { status: 200 });
}

const provider = () =>
  new OpenAICompatProvider({ id: "lmstudio", baseUrl: "http://localhost:1234/v1" });

describe("OpenAICompatProvider.chat resilience", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recovers a turn whose connection dropped before the first token", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls === 1) return dyingResponse();
      return sseResponse([{ choices: [{ delta: { content: "hi" } }] }]);
    });

    const chunks: ChatChunk[] = [];
    for await (const c of provider().chat({ model: "local", messages: [] })) chunks.push(c);

    expect(calls).toBe(2);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.delta)).toEqual(["hi"]);
  });

  it("does not replay once text has reached the caller", async () => {
    // The half-written sentence is already rendered; replaying would double it.
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      // Errored on the *second* pull, so the first chunk is actually delivered —
      // `controller.error()` discards anything still queued.
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}\n\n`,
              ),
            );
            return;
          }
          controller.error(Object.assign(new TypeError("terminated"), { code: "ECONNRESET" }));
        },
      });
      return new Response(stream, { status: 200 });
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const c of provider().chat({ model: "local", messages: [] })) {
          if (c.type === "text") seen.push(c.delta);
        }
      })(),
    ).rejects.toMatchObject({ name: "ProviderError", kind: "network" });

    expect(calls).toBe(1);
    expect(seen).toEqual(["half"]);
  });

  it("surfaces an oversized-context rejection as a non-retryable bad request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("context length exceeded", { status: 400 }),
    );

    await expect(
      (async () => {
        for await (const _ of provider().chat({ model: "local", messages: [] }));
      })(),
    ).rejects.toMatchObject({
      name: "ProviderError",
      kind: "bad_request",
      status: 400,
      retryable: false,
    });
  });
});

describe("reasoning streamed beside the answer", () => {
  afterEach(() => vi.restoreAllMocks());

  const drain = async (events: object[]): Promise<ChatChunk[]> => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => sseResponse(events));
    const chunks: ChatChunk[] = [];
    for await (const c of provider().chat({ model: "local", messages: [] })) chunks.push(c);
    return chunks;
  };

  it("surfaces reasoning_content as its own kind, never as answer text", async () => {
    // DeepSeek's field name, which Zhipu/GLM and most OpenAI-compatible
    // reasoning backends copied. It was being dropped on the floor: billed as
    // output tokens, shown nowhere.
    const chunks = await drain([
      { choices: [{ delta: { reasoning_content: "let me check the file" } }] },
      { choices: [{ delta: { content: "the answer" } }] },
    ]);
    expect(chunks).toEqual([
      { type: "thinking", delta: "let me check the file" },
      { type: "text", delta: "the answer" },
      { type: "done", usage: undefined },
    ]);
  });

  it("accepts the other spelling gateways use", async () => {
    const chunks = await drain([{ choices: [{ delta: { reasoning: "hmm" } }] }]);
    expect(chunks[0]).toEqual({ type: "thinking", delta: "hmm" });
  });

  it("puts the reasoning before the answer when one delta carries both", async () => {
    // The model thought first; the display should say so.
    const chunks = await drain([
      { choices: [{ delta: { reasoning_content: "because", content: "so" } }] },
    ]);
    expect(chunks.slice(0, 2)).toEqual([
      { type: "thinking", delta: "because" },
      { type: "text", delta: "so" },
    ]);
  });

  it("changes nothing for a server that never sends it", async () => {
    // The whole feature has to be free for LM Studio, vLLM and every
    // non-reasoning model — reading a field nobody sends must be a no-op, not
    // an empty chunk per delta.
    const chunks = await drain([{ choices: [{ delta: { content: "plain" } }] }]);
    expect(chunks).toEqual([
      { type: "text", delta: "plain" },
      { type: "done", usage: undefined },
    ]);
  });

  it("skips an empty reasoning delta rather than emitting a blank chunk", async () => {
    const chunks = await drain([{ choices: [{ delta: { reasoning_content: "" } }] }]);
    expect(chunks.some((c) => c.type === "thinking")).toBe(false);
  });
});
