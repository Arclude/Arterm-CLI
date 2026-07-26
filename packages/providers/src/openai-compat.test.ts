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
