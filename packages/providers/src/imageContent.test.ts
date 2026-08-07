import type { ImageContent, Message } from "@arterm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toAnthropicConversation } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * How each provider carries — or refuses to carry — an image.
 *
 * The assertions are on the REQUEST BODY rather than on a mapping function,
 * because the thing that matters is what reaches the server: a shape that is
 * right in a unit and wrong on the wire is a vendor 400 mid-turn, which is the
 * one failure none of these paths can recover from.
 */

const IMAGE: ImageContent = { mediaType: "image/png", data: "AAAABBBB" };

/** An SSE body of the shape an OpenAI-compatible server streams. */
function sseResponse(events: object[]): Response {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

function ndjsonResponse(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n"), { status: 200 });
}

/** Run one turn against a mocked fetch and return the parsed request body. */
async function captureBody(
  respond: () => Response,
  drive: () => AsyncIterable<unknown>,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return respond();
  });
  for await (const _ of drive()) {
    // drain
  }
  return body;
}

describe("Anthropic image content", () => {
  it("puts a user's images ahead of the text, in base64 source blocks", () => {
    const messages: Message[] = [{ role: "user", content: "what is this", images: [IMAGE] }];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAABBBB" } },
        { type: "text", text: "what is this" },
      ],
    });
  });

  it("keeps a tool result's image INSIDE the tool_result block", () => {
    // Attached to the call that produced it, not floating in a later turn —
    // this is the thing the OpenAI shape below cannot do.
    const messages: Message[] = [
      { role: "tool", content: "captured", toolCallId: "t1", name: "shoot", images: [IMAGE] },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAABBBB" },
            },
            { type: "text", text: "captured" },
          ],
        },
      ],
    });
  });

  it("omits the text block when a tool result is only an image", () => {
    // An empty text block is rejected outright by the API.
    const messages: Message[] = [{ role: "tool", content: "", toolCallId: "t1", images: [IMAGE] }];
    const { messages: out } = toAnthropicConversation(messages);
    const block = (out[0]?.content as Array<{ content: unknown[] }>)[0];
    expect(block?.content).toHaveLength(1);
  });

  it("leaves an image-free conversation byte-for-byte as before", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "out", toolCallId: "t1" },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
    });
  });

  it("skips a media type the API does not accept rather than sending it", () => {
    const messages: Message[] = [
      { role: "user", content: "x", images: [{ mediaType: "image/tiff", data: "AA" }] },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({ role: "user", content: "x" });
  });
});

describe("OpenAI-compatible image content", () => {
  afterEach(() => vi.restoreAllMocks());

  const provider = () => new OpenAICompatProvider({ baseUrl: "http://localhost:1234/v1" });

  it("sends a user's images as data: URI parts", async () => {
    const body = await captureBody(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      () =>
        provider().chat({
          model: "m",
          messages: [{ role: "user", content: "what is this", images: [IMAGE] }],
        }),
    );
    expect((body.messages as unknown[])[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAABBBB" } },
      ],
    });
  });

  it("splits a tool result's image into a following user turn", async () => {
    // The schema requires a `tool` message's content to be a string, so the
    // image has nowhere to go inside it — one turn late beats never.
    const body = await captureBody(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      () =>
        provider().chat({
          model: "m",
          messages: [
            { role: "tool", content: "captured", toolCallId: "t1", name: "shoot", images: [IMAGE] },
          ],
        }),
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "tool", content: "captured", tool_call_id: "t1" });
    expect(messages[1]?.role).toBe("user");
    const parts = messages[1]?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "Image output of shoot above:" });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAABBBB" },
    });
  });

  it("still emits exactly one message per message when there are no images", async () => {
    const body = await captureBody(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      () =>
        provider().chat({
          model: "m",
          messages: [
            { role: "user", content: "hi" },
            { role: "tool", content: "out", toolCallId: "t1" },
          ],
        }),
    );
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "tool", content: "out", tool_call_id: "t1" },
    ]);
  });
});

describe("Ollama image content", () => {
  afterEach(() => vi.restoreAllMocks());

  const provider = () => new OllamaProvider({ host: "http://localhost:11434" });

  it("recognizes the multimodal families", () => {
    for (const m of ["llava:13b", "llama3.2-vision", "moondream", "qwen3-vl", "minicpm-v"]) {
      expect(provider().supportsImages(m)).toBe(true);
    }
  });

  it("treats an unknown or text-only family as unable to see images", () => {
    // The safe direction: a miss costs a picture, a false positive costs the turn.
    for (const m of ["llama3:8b", "qwen3", "gemma3", "mistral-small"]) {
      expect(provider().supportsImages(m)).toBe(false);
    }
  });

  it("sends bare base64 in `images` to a vision model — no data: prefix", async () => {
    const body = await captureBody(
      () => ndjsonResponse([{ message: { content: "ok" } }, { done: true }]),
      () =>
        provider().chat({
          model: "llava",
          messages: [{ role: "user", content: "what is this", images: [IMAGE] }],
        }),
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "user",
      content: "what is this",
      images: ["AAAABBBB"],
    });
  });

  it("tells a text-only model what it is not being shown", async () => {
    const body = await captureBody(
      () => ndjsonResponse([{ message: { content: "ok" } }, { done: true }]),
      () =>
        provider().chat({
          model: "llama3:8b",
          messages: [{ role: "user", content: "what is this", images: [IMAGE] }],
        }),
    );
    const first = (body.messages as Array<Record<string, unknown>>)[0];
    expect(first?.images).toBeUndefined();
    expect(String(first?.content)).toContain("what is this");
    expect(String(first?.content)).toContain("cannot see images");
    expect(String(first?.content)).toContain("image/png");
  });

  it("adds nothing to a message that carries no images", async () => {
    const body = await captureBody(
      () => ndjsonResponse([{ message: { content: "ok" } }, { done: true }]),
      () => provider().chat({ model: "llama3:8b", messages: [{ role: "user", content: "hi" }] }),
    );
    expect((body.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "user",
      content: "hi",
    });
  });
});
