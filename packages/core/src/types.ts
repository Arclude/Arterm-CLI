/**
 * Shared types for Arterm. `core` defines the interfaces; `providers` and `tools`
 * implement them. This keeps the dependency direction one-way (everything → core).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  /** Stable id used to correlate a call with its result. */
  id: string;
  name: string;
  /** Parsed arguments object (already JSON-decoded). */
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tool execution. */
  toolCalls?: ToolCall[];
  /** Present on `tool` messages: the id of the call this result answers. */
  toolCallId?: string;
  /** Optional tool/function name (for `tool` messages). */
  name?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelInfo {
  name: string;
  /** Provider id that owns this model ("ollama" | "llamacpp" | ...). */
  provider: string;
  sizeBytes?: number;
  /** Whether this model is known to support native function-calling. */
  supportsTools?: boolean;
}

/** A JSON-Schema description of a tool, sent to the model for function-calling. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object describing the parameters. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  /** Sampling temperature, if the provider supports it. */
  temperature?: number;
  signal?: AbortSignal;
}

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage?: TokenUsage };

/**
 * Unified streaming interface implemented by every backend (Ollama, llama.cpp, ...).
 */
export interface ChatProvider {
  readonly id: string;
  /** True when the backend exposes a real function-calling API for the active model. */
  supportsNativeTools(model: string): boolean | Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
}

/** Result returned by a tool's execute(). */
export interface ToolResult {
  /** Text fed back to the model as the tool result. */
  output: string;
  /** True when the tool failed; the model is told so it can recover. */
  isError?: boolean;
}

export type PermissionLevel = "allow" | "ask" | "deny";

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for parameters (consumed directly as ToolSchema.parameters). */
  parameters: Record<string, unknown>;
  /** Default permission level for this tool. */
  permission: PermissionLevel;
  /** Short human-readable summary of a pending call, shown in the permission prompt. */
  preview?(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  /** Working directory the agent operates within. */
  cwd: string;
  signal?: AbortSignal;
}

/** Callback the agent uses to ask the host (TUI/CLI) for permission. */
export type PermissionAsker = (
  tool: Tool,
  args: Record<string, unknown>,
) => Promise<"allow" | "allow_always" | "deny">;
