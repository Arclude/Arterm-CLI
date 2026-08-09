import { randomUUID } from "node:crypto";
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  ImageContent,
  Message,
  ModelInfo,
  RateLimitSnapshot,
  TokenUsage,
  ToolSchema,
} from "@arterm/core";
import { providerErrorFromResponse } from "@arterm/core";
import { harvestRateLimits } from "./rateLimits.js";
import { withStreamReplay } from "./replay.js";
import { fetchWithRetry } from "./retry.js";
import { streamIdleGuard } from "./timeout.js";

/** Max wait for metadata calls (model list/reachability) before giving up, in ms. */
const METADATA_TIMEOUT_MS = 5000;

/** Abort a streaming chat if no bytes arrive for this long — bounds a hung server. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

interface OpenAIModelsResponse {
  data?: Array<{ id: string }>;
}

interface OpenAIDeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      /**
       * Reasoning streamed beside the answer. Not in the OpenAI spec — it is
       * the convention DeepSeek introduced and Zhipu/GLM, Moonshot and most
       * OpenAI-compatible reasoning backends copied, so it arrives on the same
       * endpoint under one of two names and is simply absent otherwise.
       *
       * Reading a field a server never sends costs nothing. NOT reading it cost
       * the user the tokens twice over: billed as output, and invisible — a
       * reasoning model streaming only `reasoning_content` for thirty seconds
       * looked exactly like a hung request.
       */
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: OpenAIDeltaToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Accumulates the streamed fragments of a single tool call. */
interface PendingToolCall {
  id?: string;
  name: string;
  arguments: string;
}

export interface OpenAICompatOptions {
  /** Reported provider id (defaults to "openai-compat"); hosted presets set their own. */
  id?: string;
  baseUrl: string;
  apiKey?: string;
  /**
   * Extra headers sent on every request. Some gateways (one-api/new-api relays)
   * gate access on a recognized client User-Agent — this lets the user supply one.
   */
  headers?: Record<string, string>;
}

/** Talks to any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, ...). */
export class OpenAICompatProvider implements ChatProvider {
  readonly id: string;
  private baseUrl: string;
  private apiKey?: string;
  private extraHeaders: Record<string, string>;
  private limits: RateLimitSnapshot | undefined;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id ?? "openai-compat";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers ?? {};
  }

  /** The latest `x-ratelimit-*` report (OpenAI/OpenRouter-style), when sent. */
  rateLimits(): RateLimitSnapshot | undefined {
    return this.limits;
  }

  /** These servers accept the OpenAI `tools` param across models. */
  supportsNativeTools(): boolean {
    return true;
  }

  /** True if the server responds, used for auto-detection. */
  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    }).catch((err) => {
      throw new Error(
        `OpenAI-compat /models unreachable at ${this.baseUrl}: ${(err as Error).message}`,
      );
    });
    if (!res.ok) throw new Error(`OpenAI-compat /models failed: ${res.status}`);
    const data = (await res.json()) as OpenAIModelsResponse;
    return (data.data ?? []).map((m) => ({
      name: m.id,
      provider: this.id,
      supportsTools: true,
    }));
  }

  /**
   * A socket that dies before the first chunk costs nothing to re-issue, so the
   * whole request is replayable until output starts flowing.
   */
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    yield* withStreamReplay(this.id, () => this.streamOnce(req), { signal: req.signal });
  }

  private async *streamOnce(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = {
      model: req.model,
      messages: req.messages.flatMap(toOpenAIMessages),
      stream: true,
      temperature: req.temperature,
      tools: req.tools ? req.tools.map(toOpenAITool) : undefined,
    };

    // Bound the stream with an idle timeout (reset on each chunk) so a server that
    // accepts the connection but never streams can't hang the turn forever.
    const guard = streamIdleGuard(STREAM_IDLE_TIMEOUT_MS, req.signal);
    // Held outside the try so the `finally` can CANCEL it. Clearing the guard
    // stops our timer; it does nothing to the socket, and a stream abandoned
    // mid-flight keeps the connection — and Node's event loop — alive. Observed
    // exactly that: a wall-clock deadline correctly ended the run at 10s, the
    // result document was written, and the process then sat there until an
    // external kill 80 seconds later. Same class as the sandbox teardown bug:
    // every in-process assertion passes while the process refuses to exit.
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      // Retry only covers the connection phase — a transient 429/5xx or network
      // blip shouldn't end the whole turn. Mid-stream failures still propagate.
      const res = await fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers() },
          body: JSON.stringify(body),
          signal: guard.signal,
        },
        { signal: guard.signal },
      );
      // Harvest before the ok-check: a 429's headers are exactly the report
      // worth keeping (they say when the door reopens).
      this.limits = harvestRateLimits(res.headers) ?? this.limits;
      if (!res.ok || !res.body) {
        throw await providerErrorFromResponse(this.id, res, "/chat/completions");
      }
      responseBody = res.body;

      const pending = new Map<number, PendingToolCall>();
      let usage: TokenUsage | undefined;

      for await (const chunk of parseSse(res.body)) {
        guard.reset();
        const obj = chunk as OpenAIStreamChunk;
        const delta = obj.choices?.[0]?.delta;
        // Reasoning first: a backend that sends both in one delta produced the
        // thinking before the answer, and the display should say so.
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { type: "thinking", delta: reasoning };
        }
        if (typeof delta?.content === "string") {
          yield { type: "text", delta: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const acc = pending.get(tc.index) ?? { name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            pending.set(tc.index, acc);
          }
        }
        if (obj.usage) {
          // Cached prompt tokens bill at a fraction of the input rate. Unlike
          // Anthropic's, OpenAI's `prompt_tokens` INCLUDES them, so the pricing
          // side subtracts rather than adds — reported here as-is.
          const cached = obj.usage.prompt_tokens_details?.cached_tokens;
          usage = {
            promptTokens: obj.usage.prompt_tokens,
            completionTokens: obj.usage.completion_tokens,
            totalTokens: obj.usage.total_tokens,
            ...(cached ? { cacheReadTokens: cached, cachedInPrompt: true } : {}),
          };
        }
      }

      for (const tc of pending.values()) {
        let args: Record<string, unknown>;
        try {
          args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        yield {
          type: "tool_call",
          call: { id: tc.id ?? randomUUID(), name: tc.name, arguments: args },
        };
      }

      yield { type: "done", usage };
    } finally {
      guard.clear();
      // A fully drained stream is already closed and cancelling it is a no-op,
      // so this is unconditional rather than guarded on how we got here — the
      // paths that need it (an abort, a throw, a `break` upstream) are exactly
      // the ones least likely to be remembered.
      await responseBody?.cancel().catch(() => {});
    }
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

/**
 * Reads an OpenAI-style SSE stream and yields each parsed `data:` JSON payload,
 * buffering partial lines. A `data: [DONE]` line terminates the stream.
 */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          // Skip a malformed payload rather than killing the stream — some proxies
          // (e.g. OpenRouter) emit non-JSON `data:` keep-alive lines mid-response.
          if (payload) {
            try {
              yield JSON.parse(payload);
            } catch {
              // skip malformed payload
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          yield JSON.parse(payload);
        } catch {
          // skip malformed trailing payload
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Images as OpenAI content parts — a `data:` URI is this schema's base64 carrier. */
function toOpenAIImageParts(images: ImageContent[] | undefined): Record<string, unknown>[] {
  return (images ?? []).map((image) => ({
    type: "image_url",
    image_url: { url: `data:${image.mediaType};base64,${image.data}` },
  }));
}

/**
 * One Arterm message becomes one OpenAI message — except a tool result carrying
 * an image, which becomes two.
 *
 * The schema requires a `tool` message's `content` to be a plain string, so
 * there is nowhere inside it to put an image part. A following `user` turn is
 * the only slot the protocol has for one, and arriving one turn late beats not
 * arriving: a model that is shown nothing describes the screenshot it imagines.
 * The label goes first so the image has something naming what produced it.
 */
function toOpenAIMessages(m: Message): Record<string, unknown>[] {
  const parts = toOpenAIImageParts(m.images);
  if (m.role === "tool") {
    const result = { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    if (parts.length === 0) return [result];
    const label = { type: "text", text: `Image output of ${m.name ?? "the tool call"} above:` };
    return [result, { role: "user", content: [label, ...parts] }];
  }
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  // Only a user turn may carry image parts: the schema takes a string for an
  // assistant's content, so an image there is rejected rather than ignored.
  if (m.role === "user" && parts.length > 0) {
    base.content = [...(m.content ? [{ type: "text", text: m.content }] : []), ...parts];
  }
  if (m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }
  return [base];
}

function toOpenAITool(t: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}
