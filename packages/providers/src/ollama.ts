import { randomUUID } from "node:crypto";
import {
  type ChatChunk,
  type ChatProvider,
  type ChatRequest,
  type Message,
  type ModelInfo,
  type ToolSchema,
  modelToolCall,
} from "@arterm/core";
import { parseNdjson } from "./ndjson.js";
import { streamIdleGuard } from "./timeout.js";

/** Abort a streaming chat if no bytes arrive for this long — bounds a hung server. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Model families known to handle Ollama's native tool-calling well. Substrings, so
 * "llama3" covers llama3.0–3.3 and "qwen2" covers qwen2 / qwen2.5. Kept conservative:
 * a false positive here makes a non-tool model receive `tools` without the JSON
 * fallback instructions, so only confirmed-capable families are listed.
 */
const TOOL_CAPABLE = [
  "llama3",
  "llama4",
  "qwen2",
  "qwen3",
  "mistral",
  "mixtral",
  "command-r",
  "command-a",
  "firefunction",
  "hermes3",
  "granite3",
  "nemotron",
  "athene",
  "qwq",
];

/** Max wait for metadata calls (tags/reachability) before giving up, in ms. */
const METADATA_TIMEOUT_MS = 5000;

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number }>;
}

interface OllamaChatMessage {
  role: string;
  content?: string;
  // Most templates emit `arguments` as an object, but some emit a JSON string.
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
}

interface OllamaChatResponse {
  message?: OllamaChatMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaOptions {
  host: string;
}

/** Coerce tool-call arguments to an object — some templates emit a JSON string. */
function normalizeToolArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Talks to a running Ollama server over its HTTP API. */
export class OllamaProvider implements ChatProvider {
  readonly id = "ollama";
  private host: string;

  constructor(opts: OllamaOptions) {
    this.host = opts.host.replace(/\/$/, "");
  }

  supportsNativeTools(model: string): boolean {
    // The hand-maintained allowlist is authoritative for what it names (a known
    // tool-capable family). The models.dev catalog only *adds* coverage for a
    // capable family the list doesn't name yet — it never retracts a heuristic
    // match, since the catalog's per-provider `tool_call` flags are unreliable.
    const lower = model.toLowerCase();
    if (TOOL_CAPABLE.some((fam) => lower.includes(fam))) return true;
    return modelToolCall(model, "ollama") === true;
  }

  /** True if the Ollama server responds, used for auto-detection. */
  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.host}/api/tags`, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    }).catch((err) => {
      throw new Error(`Ollama /api/tags unreachable at ${this.host}: ${(err as Error).message}`);
    });
    if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`);
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => ({
      name: m.name,
      provider: this.id,
      sizeBytes: m.size,
      supportsTools: this.supportsNativeTools(m.name),
    }));
  }

  /** Streams `pull` progress lines (status strings) for a model. */
  async *pull(model: string): AsyncGenerator<string> {
    const res = await fetch(`${this.host}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama /api/pull failed: ${res.status}`);
    for await (const obj of parseNdjson(res.body)) {
      const status = (obj as { status?: string }).status;
      if (status) yield status;
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      options: req.temperature !== undefined ? { temperature: req.temperature } : undefined,
      tools: req.tools ? req.tools.map(toOllamaTool) : undefined,
    };

    // Bound the stream with an idle timeout (reset on each chunk) so a server that
    // accepts the connection but never streams can't hang the turn forever.
    const guard = streamIdleGuard(STREAM_IDLE_TIMEOUT_MS, req.signal);
    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama /api/chat failed: ${res.status} ${detail}`);
      }

      let promptTokens: number | undefined;
      let completionTokens: number | undefined;

      for await (const raw of parseNdjson(res.body)) {
        guard.reset();
        const obj = raw as OllamaChatResponse;
        const msg = obj.message;
        if (msg?.content) yield { type: "text", delta: msg.content };
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield {
              type: "tool_call",
              call: {
                id: randomUUID(),
                name: tc.function.name,
                arguments: normalizeToolArgs(tc.function.arguments),
              },
            };
          }
        }
        if (obj.done) {
          promptTokens = obj.prompt_eval_count;
          completionTokens = obj.eval_count;
        }
      }

      yield {
        type: "done",
        usage: {
          promptTokens,
          completionTokens,
          totalTokens:
            promptTokens !== undefined && completionTokens !== undefined
              ? promptTokens + completionTokens
              : undefined,
        },
      };
    } finally {
      guard.clear();
    }
  }
}

function toOllamaMessage(m: Message): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((c) => ({
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.role === "tool" && m.name) base.tool_name = m.name;
  return base;
}

function toOllamaTool(t: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}
