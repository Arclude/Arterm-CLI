import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { type ChatChunk, type Message, ProviderError, type ToolSchema } from "@arterm/core";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  completedTransactionIndex,
  toAnthropicConversation,
  toAnthropicSystem,
  toAnthropicTools,
  withCacheBreakpoints,
  withCachePoint,
} from "./anthropic.js";

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

/**
 * An SSE server that streams one text delta and a usage-bearing stop.
 *
 * `onBody` receives the parsed request body — the only place a claim about what
 * we send is actually checkable. A helper that built the right object and never
 * put it on the wire would satisfy every assertion that stops short of here.
 */
async function streamingServer(onBody?: (body: Record<string, unknown>) => void) {
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
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (onBody) onBody(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
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

describe("prompt caching", () => {
  const tools: ToolSchema[] = [
    { name: "read", description: "read a file", parameters: { type: "object" } },
    { name: "write", description: "write a file", parameters: { type: "object" } },
  ];

  it("seals the roster at the LAST tool, not every tool", () => {
    // A breakpoint caches everything before it, so one on the final tool covers
    // the whole roster. Marking each tool would spend four breakpoints (the
    // per-request limit) to buy exactly what one buys.
    const marked = toAnthropicTools(tools, true);
    expect(marked[0]).not.toHaveProperty("cache_control");
    expect(marked[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves the roster unmarked when caching is off", () => {
    expect(toAnthropicTools(tools, false).some((t) => "cache_control" in t)).toBe(false);
  });

  it("keeps the OAuth identity FIRST and the breakpoint LAST", () => {
    // Both are load-bearing and they pull in opposite directions: the identity
    // line has to lead or the subscription scope refuses the request, and the
    // breakpoint has to trail or it seals less than the whole system prompt.
    const blocks = toAnthropicSystem("project rules", { oauth: true, cache: true });
    if (!Array.isArray(blocks)) throw new Error("caching requires blocks");
    expect(blocks[0]?.text).toContain("Claude Code");
    expect(blocks[0]).not.toHaveProperty("cache_control");
    expect(blocks[1]?.text).toBe("project rules");
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("still sends a plain string when there is nothing to attach", () => {
    // Blocks buy nothing without a breakpoint; the API-key path keeps the shape
    // it has always sent rather than changing the wire for no gain.
    expect(toAnthropicSystem("rules", { oauth: false, cache: false })).toBe("rules");
    expect(toAnthropicSystem(undefined, { oauth: false, cache: true })).toBeUndefined();
  });

  it("marks the last content block of a message, whatever kind it is", () => {
    const marked = withCachePoint({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    });
    const blocks = marked.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("refuses to manufacture an empty text block to hold the marker", () => {
    // An empty text block is a 400 on the whole request. Not caching one message
    // is strictly better than losing the turn.
    const empty = { role: "user" as const, content: "" };
    expect(withCachePoint(empty)).toEqual(empty);
  });

  // The fourth breakpoint. It was left unspent for fear of guessing a fixed
  // offset; these pin that the position is computed, not counted.
  describe("the completed-transaction anchor", () => {
    const assistant = (text: string): Anthropic.MessageParam => ({
      role: "assistant",
      content: [{ type: "text", text }],
    });
    const toolUse = (id: string): Anthropic.MessageParam => ({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "read", input: {} }],
    });
    const toolResult = (id: string): Anthropic.MessageParam => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    });
    const marks = (messages: Anthropic.MessageParam[]) =>
      withCacheBreakpoints(messages)
        .map((m, i) =>
          typeof m.content === "string"
            ? undefined
            : m.content.some((b) => "cache_control" in b && b.cache_control)
              ? i
              : undefined,
        )
        .filter((i): i is number => i !== undefined);

    it("anchors at the results of a round-trip the model has already answered", () => {
      // [user, assistant(tool_use), user(tool_result), assistant] — index 2 is
      // frozen: every later request re-sends it byte-identical.
      const messages = [
        { role: "user" as const, content: "go" },
        toolUse("t1"),
        toolResult("t1"),
        assistant("done"),
      ];
      expect(completedTransactionIndex(messages)).toBe(2);
      expect(marks(messages)).toEqual([2, 3]);
    });

    it("spends nothing when no round-trip has completed", () => {
      // A text-only exchange has no frozen prefix to anchor, and a breakpoint on
      // a position that never repeats is a write nobody reads.
      const messages = [{ role: "user" as const, content: "hi" }, assistant("hello")];
      expect(completedTransactionIndex(messages)).toBeUndefined();
      expect(marks(messages)).toEqual([1]);
    });

    it("never marks the same message twice", () => {
      // Results as the LAST message already carry the moving breakpoint; a
      // second marker there would spend one of four to buy nothing.
      const messages = [{ role: "user" as const, content: "go" }, toolUse("t1"), toolResult("t1")];
      expect(completedTransactionIndex(messages)).toBeUndefined();
      expect(marks(messages)).toEqual([2]);
    });

    it("takes the most recent completed round-trip, not the first", () => {
      const messages = [
        { role: "user" as const, content: "go" },
        toolUse("t1"),
        toolResult("t1"),
        toolUse("t2"),
        toolResult("t2"),
        assistant("done"),
      ];
      expect(completedTransactionIndex(messages)).toBe(4);
      expect(marks(messages)).toEqual([4, 5]);
    });
  });

  // A text-only exchange: no completed round-trip, so the fourth anchor has
  // nothing to attach to and three is the whole policy here.
  it("puts the breakpoints on the wire, and none when switched off", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = await streamingServer((b) => bodies.push(b));
    const request = {
      model: "claude-opus-5",
      messages: [
        { role: "system" as const, content: "be brief" },
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "hello" },
        { role: "user" as const, content: "now do it" },
      ],
      tools,
    };
    try {
      const on = new AnthropicProvider({ apiKey: "k", baseUrl: server.baseUrl });
      for await (const _ of on.chat(request)) void _;
      const off = new AnthropicProvider({
        apiKey: "k",
        baseUrl: server.baseUrl,
        promptCache: false,
      });
      for await (const _ of off.chat(request)) void _;
    } finally {
      await server.close();
    }

    type Body = {
      tools: Array<Record<string, unknown>>;
      system: unknown;
      messages: Array<{ content: unknown }>;
    };
    const [cached, plain] = bodies as [Body, Body];
    // Roster, system prompt, and the conversation as it stands — the three
    // reusable parts of an agent loop's prompt.
    expect(cached.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(cached.system).toEqual([
      { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
    ]);
    const last = cached.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(last[0]?.cache_control).toEqual({ type: "ephemeral" });
    // …and only the LAST message: an earlier one would spend a breakpoint on a
    // position the next request never re-sends unchanged.
    expect(JSON.stringify(cached.messages.slice(0, -1))).not.toContain("cache_control");

    expect(JSON.stringify(plain)).not.toContain("cache_control");
    expect(plain.system).toBe("be brief");
  });
});
