import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ChatChunk, type Message, ProviderError, type ToolSchema } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, toAnthropicConversation, toAnthropicTools } from "./anthropic.js";

describe("toAnthropicConversation", () => {
  it("hoists system messages into the top-level system string", () => {
    const messages: Message[] = [
      { role: "system", content: "be terse" },
      { role: "system", content: "use tools" },
      { role: "user", content: "hi" },
    ];
    const { system, messages: out } = toAnthropicConversation(messages);
    expect(system).toBe("be terse\n\nuse tools");
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps assistant tool calls to tool_use content blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "t1", name: "read", arguments: { path: "a.ts" } }],
      },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me read it" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
      ],
    });
  });

  it("maps tool messages to user tool_result blocks", () => {
    const messages: Message[] = [
      { role: "tool", content: "file contents", toolCallId: "t1", name: "read" },
    ];
    const { messages: out } = toAnthropicConversation(messages);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
    });
  });

  it("never emits empty assistant content", () => {
    const { messages: out } = toAnthropicConversation([{ role: "assistant", content: "" }]);
    expect(out[0]).toEqual({ role: "assistant", content: [{ type: "text", text: " " }] });
  });

  it("returns undefined system when there are no system messages", () => {
    const { system } = toAnthropicConversation([{ role: "user", content: "hi" }]);
    expect(system).toBeUndefined();
  });
});

describe("toAnthropicTools", () => {
  it("maps parameters to input_schema", () => {
    const tools: ToolSchema[] = [
      {
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    expect(toAnthropicTools(tools)).toEqual([
      {
        name: "read",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });
});

/** A server that refuses every request with the given status and headers. */
async function refusingServer(status: number, headers: Record<string, string>) {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "no" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function drain(provider: AnthropicProvider): Promise<unknown> {
  try {
    for await (const _ of provider.chat({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      void _;
    }
  } catch (err) {
    return err;
  }
  return undefined;
}

/** An SSE server that streams one text delta and a usage-bearing stop. */
async function streamingServer() {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("AnthropicProvider resilience", () => {
  // The retry wrapper replaces the SDK's transport, so the happy path has to be
  // proven too: a fetch wrapper that broke streaming would pass every error test.
  it("streams a normal turn through the retrying transport", async () => {
    const server = await streamingServer();
    try {
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl });
      const chunks: ChatChunk[] = [];
      for await (const c of provider.chat({
        model: "claude-opus-5",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(c);
      }
      expect(chunks).toEqual([
        { type: "text", delta: "hello" },
        { type: "done", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
      ]);
    } finally {
      await server.close();
    }
  });

  // Regression: the SDK's own retry loop obeys Retry-After with NO cap ("just do
  // what it says"), so `Retry-After: 60` slept for a full minute inside the
  // provider — twice — while the fallback chain waited for an error that never
  // came. The 2s budget here IS the assertion: on a regression this times out.
  it("abandons a long Retry-After instead of sleeping it out", { timeout: 2000 }, async () => {
    const server = await refusingServer(429, { "retry-after": "60" });
    try {
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl });
      const err = await drain(provider);
      expect(ProviderError.is(err)).toBe(true);
      const pe = err as ProviderError;
      expect(pe.kind).toBe("quota");
      expect(pe.retryable).toBe(true);
      // Carried through from the SDK error's response headers, so the message can
      // say how long — and so a caller can decide without re-parsing.
      expect(pe.retryAfterMs).toBe(60_000);
      expect(pe.message).toContain("1m");
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("still retries a transient refusal that carries no Retry-After", async () => {
    const server = await refusingServer(503, {});
    try {
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl });
      const err = await drain(provider);
      expect((err as ProviderError).kind).toBe("overloaded");
      expect(server.requests).toBeGreaterThan(1);
    } finally {
      await server.close();
    }
  });
});
