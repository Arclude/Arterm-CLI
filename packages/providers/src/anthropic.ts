import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  Message,
  ModelInfo,
  ToolSchema,
} from "@arterm/core";

/** Anthropic requires `max_tokens`; this is the default per-response output cap. */
const DEFAULT_MAX_TOKENS = 8192;

/** Current Claude models surfaced in the picker (no network/key required). */
const KNOWN_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-fable-5",
];

export interface AnthropicOptions {
  apiKey?: string;
  /** Override the API base URL (e.g. a proxy). */
  baseUrl?: string;
  /** Per-response output token cap. */
  maxTokens?: number;
}

export interface AnthropicConversation {
  system?: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Convert Arterm messages to Anthropic's Messages-API shape: system messages are
 * hoisted to the top-level `system` string, assistant tool calls become
 * `tool_use` blocks, and `tool` messages become `user` messages with
 * `tool_result` blocks (Anthropic requires tool results in a user turn).
 */
export function toAnthropicConversation(messages: Message[]): AnthropicConversation {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      // Anthropic rejects empty assistant content.
      if (content.length === 0) content.push({ type: "text", text: " " });
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/** Convert Arterm tool schemas to Anthropic tool definitions (`input_schema`). */
export function toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool["input_schema"],
  }));
}

/** Talks to the Anthropic Messages API via the official SDK (streaming + tools). */
export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic";
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = new Anthropic({
      apiKey: this.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  supportsNativeTools(): boolean {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    return KNOWN_MODELS.map((name) => ({ name, provider: this.id, supportsTools: true }));
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (!this.apiKey) {
      throw new Error(
        "No Anthropic API key. Run `arterm auth set anthropic`, or sign in with /login.",
      );
    }
    const { system, messages } = toAnthropicConversation(req.messages);
    // `temperature` is intentionally omitted — current Claude models (Opus
    // 4.8/4.7, Fable 5) reject sampling parameters with a 400.
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools && req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }

    // The SDK accumulates tool-call input JSON; read the complete blocks here.
    const final = await stream.finalMessage();
    for (const block of final.content) {
      if (block.type === "tool_use") {
        yield {
          type: "tool_call",
          call: {
            id: block.id,
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          },
        };
      }
    }
    yield {
      type: "done",
      usage: {
        promptTokens: final.usage.input_tokens,
        completionTokens: final.usage.output_tokens,
        totalTokens: final.usage.input_tokens + final.usage.output_tokens,
      },
    };
  }
}
