import type { EventBus } from "./eventBus.js";
import type { PermissionManager } from "./permissions.js";
import { parseToolCalls, toolSystemPrompt } from "./toolProtocol.js";
import type {
  ChatProvider,
  Message,
  PermissionAsker,
  Tool,
  ToolCall,
  ToolSchema,
} from "./types.js";

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  tools: Tool[];
  permissions: PermissionManager;
  /** Invoked when a tool needs interactive approval. */
  ask: PermissionAsker;
  bus: EventBus;
  cwd: string;
  temperature?: number;
  /** Hard cap on tool-call round-trips per user turn. */
  maxIterations?: number;
  /** Base system prompt (agent persona). */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM =
  "You are Arterm, a local AI coding agent running in the user's terminal. " +
  "You can read, search, and edit files and run shell commands via tools. " +
  "Be concise. Prefer using tools over guessing. Always read a file before editing it.";

/**
 * Drives the conversation: streams model output, executes tool calls (gated by
 * permissions), and feeds results back until the model produces a final answer.
 */
export class Agent {
  private messages: Message[] = [];
  private toolMap: Map<string, Tool>;
  readonly bus: EventBus;

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  reset(): void {
    this.messages = [];
  }

  get model(): string {
    return this.opts.model;
  }

  /** Switch the active model while preserving conversation history. */
  setModel(model: string): void {
    this.opts.model = model;
  }

  /** Switch the active backend while preserving conversation history. */
  setProvider(provider: ChatProvider): void {
    this.opts.provider = provider;
  }

  private toolSchemas(): ToolSchema[] {
    return this.opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  private async buildSystem(native: boolean): Promise<Message> {
    const base = this.opts.systemPrompt ?? DEFAULT_SYSTEM;
    const content =
      native || this.opts.tools.length === 0
        ? base
        : `${base}\n\n${toolSystemPrompt(this.toolSchemas())}`;
    return { role: "system", content };
  }

  /** Runs one user turn to completion (possibly many tool round-trips). */
  async run(userInput: string, signal?: AbortSignal): Promise<void> {
    const { provider, model, tools } = this.opts;
    const native = tools.length > 0 ? await provider.supportsNativeTools(model) : false;
    const maxIterations = this.opts.maxIterations ?? 12;

    this.messages.push({ role: "user", content: userInput });
    this.bus.emit({ type: "turn_start" });

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) break;

        const system = await this.buildSystem(native);
        const { text, calls } = await this.streamOnce(system, native, signal);

        const assistant: Message = { role: "assistant", content: text };
        if (calls.length > 0) assistant.toolCalls = calls;
        this.messages.push(assistant);
        this.bus.emit({ type: "assistant_message", message: assistant });

        if (calls.length === 0) break;

        for (const call of calls) {
          if (signal?.aborted) break;
          await this.runToolCall(call, signal);
        }
      }
    } catch (err) {
      this.bus.emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.bus.emit({ type: "turn_end" });
    }
  }

  private async streamOnce(
    system: Message,
    native: boolean,
    signal?: AbortSignal,
  ): Promise<{ text: string; calls: ToolCall[] }> {
    const { provider, model, tools, temperature } = this.opts;
    const calls: ToolCall[] = [];
    let text = "";

    const stream = provider.chat({
      model,
      messages: [system, ...this.messages],
      tools: native && tools.length > 0 ? this.toolSchemas() : undefined,
      temperature,
      signal,
    });

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        text += chunk.delta;
        this.bus.emit({ type: "text_delta", delta: chunk.delta });
      } else if (chunk.type === "tool_call") {
        calls.push(chunk.call);
        this.bus.emit({ type: "tool_call", call: chunk.call });
      } else if (chunk.type === "done" && chunk.usage) {
        this.bus.emit({ type: "usage", usage: chunk.usage });
      }
    }

    // Fallback path: recover tool calls from the text body.
    if (!native && tools.length > 0) {
      const parsed = parseToolCalls(text);
      if (parsed.calls.length > 0) {
        text = parsed.cleaned;
        for (const call of parsed.calls) {
          calls.push(call);
          this.bus.emit({ type: "tool_call", call });
        }
      }
    }

    return { text, calls };
  }

  private async runToolCall(call: ToolCall, signal?: AbortSignal): Promise<void> {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      this.pushToolResult(call, `Unknown tool: ${call.name}`, true);
      return;
    }

    const decision = await this.opts.permissions.check(tool, call.arguments, this.opts.ask);
    if (!decision.allowed) {
      this.bus.emit({ type: "tool_denied", callId: call.id, name: call.name });
      this.pushToolResult(call, "Tool call denied by the user.", true);
      return;
    }

    try {
      const result = await tool.execute(call.arguments, { cwd: this.opts.cwd, signal });
      this.pushToolResult(call, result.output, result.isError ?? false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushToolResult(call, `Tool error: ${msg}`, true);
    }
  }

  private pushToolResult(call: ToolCall, output: string, isError: boolean): void {
    this.messages.push({
      role: "tool",
      content: output,
      toolCallId: call.id,
      name: call.name,
    });
    this.bus.emit({ type: "tool_result", callId: call.id, name: call.name, output, isError });
  }
}
