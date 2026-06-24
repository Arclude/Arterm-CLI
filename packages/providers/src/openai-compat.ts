import { randomUUID } from "node:crypto";
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  Message,
  ModelInfo,
  TokenUsage,
  ToolSchema,
} from "@arterm/core";

/** Max wait for metadata calls (model list/reachability) before giving up, in ms. */
const METADATA_TIMEOUT_MS = 5000;

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
      tool_calls?: OpenAIDeltaToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
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
}

/** Talks to any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, ...). */
export class OpenAICompatProvider implements ChatProvider {
  readonly id: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id ?? "openai-compat";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
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

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      temperature: req.temperature,
      tools: req.tools ? req.tools.map(toOpenAITool) : undefined,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI-compat /chat/completions failed: ${res.status} ${detail}`);
    }

    const pending = new Map<number, PendingToolCall>();
    let usage: TokenUsage | undefined;

    for await (const chunk of parseSse(res.body)) {
      const obj = chunk as OpenAIStreamChunk;
      const delta = obj.choices?.[0]?.delta;
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
        usage = {
          promptTokens: obj.usage.prompt_tokens,
          completionTokens: obj.usage.completion_tokens,
          totalTokens: obj.usage.total_tokens,
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
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
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
          if (payload) yield JSON.parse(payload);
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") yield JSON.parse(payload);
    }
  } finally {
    reader.releaseLock();
  }
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }
  return base;
}

function toOpenAITool(t: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}
