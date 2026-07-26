import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  Message,
  ModelInfo,
  ToolSchema,
} from "@arterm/core";

import { withStreamReplay } from "./replay.js";
import { fetchWithRetry } from "./retry.js";
import { streamIdleGuard } from "./timeout.js";

/** Anthropic requires `max_tokens`; this is the default per-response output cap. */
const DEFAULT_MAX_TOKENS = 8192;

/** Abort a streaming chat if no bytes arrive for this long — bounds a hung server. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Beta header that opts a request into subscription (OAuth) inference. */
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Required leading system block when authenticating with a Claude subscription
 * token: the OAuth inference scope only serves requests that identify as the
 * Claude Code client, so this exact line must be the first system block.
 */
const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Retry settings handed to every SDK client. The SDK's own retry loop is turned
 * OFF and replaced with ours, because of one line in its `retryRequest`:
 *
 *   > If the API asks us to wait a certain amount of time, just do what it says
 *
 * It has no cap. A `Retry-After: 3600` makes the SDK `await sleep(3_600_000)` —
 * twice, by default — *inside* `streamOnce`. Nothing above it can intervene: the
 * fallback chain never sees an error to act on, the turn simply stops for an
 * hour, and this is the provider most likely to be rate-limited in the first
 * place. Routing the transport through `fetchWithRetry` gives Anthropic the same
 * bounded budget as the fetch-based providers — retry the transient, abandon a
 * refusal longer than we'd wait — while the SDK still turns the final response
 * into a typed `APIError` the taxonomy understands.
 */
const RESILIENCE = {
  maxRetries: 0,
  fetch: ((input: string | URL, init?: RequestInit): Promise<Response> =>
    fetchWithRetry(String(input), init ?? {}, {
      ...(init?.signal ? { signal: init.signal } : {}),
    })) as unknown as typeof fetch,
} as const;

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
  /**
   * Resolve a fresh subscription (OAuth) access token per request. When set, the
   * provider authenticates with a Bearer token + the OAuth beta header instead of
   * an API key, and prepends the required Claude Code system identity. The caller
   * owns refresh/persistence — this is invoked once at the start of every `chat`.
   */
  getAccessToken?: () => Promise<string>;
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
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly getAccessToken: (() => Promise<string>) | undefined;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.getAccessToken = opts.getAccessToken;
    this.baseUrl = opts.baseUrl;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** Whether this provider authenticates with a subscription (OAuth) token. */
  private get usesOauth(): boolean {
    return this.getAccessToken !== undefined;
  }

  /** Build the SDK client for a request — Bearer (OAuth) or API key. */
  private async resolveClient(): Promise<Anthropic> {
    if (this.getAccessToken) {
      const token = await this.getAccessToken();
      return new Anthropic({
        authToken: token,
        defaultHeaders: { "anthropic-beta": OAUTH_BETA },
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        ...RESILIENCE,
      });
    }
    return new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      ...RESILIENCE,
    });
  }

  supportsNativeTools(): boolean {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    return KNOWN_MODELS.map((name) => ({ name, provider: this.id, supportsTools: true }));
  }

  /**
   * The SDK retries the connection phase but not a stream that dies mid-flight,
   * which is exactly when a long generation is most expensive to lose — so the
   * request is replayable until the first chunk reaches the caller.
   */
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (!this.usesOauth && !this.apiKey) {
      throw new Error(
        "No Anthropic credentials. Run `arterm login` to sign in with a Claude " +
          "subscription, or `arterm auth set anthropic` for an API key.",
      );
    }
    yield* withStreamReplay(this.id, () => this.streamOnce(req), { signal: req.signal });
  }

  private async *streamOnce(req: ChatRequest): AsyncIterable<ChatChunk> {
    // Resolved per attempt so a replay picks up a token refreshed in between.
    const client = await this.resolveClient();
    const { system, messages } = toAnthropicConversation(req.messages);
    // OAuth inference only serves requests that lead with the Claude Code identity,
    // so under a subscription token send `system` as blocks with that line first.
    const systemParam = this.usesOauth
      ? [
          { type: "text" as const, text: OAUTH_SYSTEM_IDENTITY },
          ...(system ? [{ type: "text" as const, text: system }] : []),
        ]
      : system;
    // Bound the stream with an idle timeout (reset on each event) so a server that
    // accepts the connection but never streams can't hang the turn forever.
    const guard = streamIdleGuard(STREAM_IDLE_TIMEOUT_MS, req.signal);
    try {
      // `temperature` is intentionally omitted — current Claude models (Opus
      // 4.8/4.7, Fable 5) reject sampling parameters with a 400.
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: this.maxTokens,
          ...(systemParam ? { system: systemParam } : {}),
          messages,
          ...(req.tools && req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
        },
        { signal: guard.signal },
      );

      for await (const event of stream) {
        guard.reset();
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
    } finally {
      guard.clear();
    }
  }
}
