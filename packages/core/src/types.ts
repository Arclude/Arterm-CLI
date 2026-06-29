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

/**
 * How the autonomy engine runs a goal:
 *   - "once":     stops when the goal is done.
 *   - "eternal":  keeps going until stopped.
 *   - "parallel": each round the leader decomposes the goal into concurrent subagent
 *                 tasks (fleet), aggregates the results, reflects, and repeats.
 */
export type AutonomyMode = "once" | "eternal" | "parallel" | "phased";

/** Connection status of one configured MCP server (for the /mcp view). */
export interface McpServerSummary {
  name: string;
  status: "connected" | "failed";
  toolCount: number;
  error?: string;
}

/** Whether a plugin's tools are trusted. Untrusted tools are gated (ask + no execute). */
export type TrustTier = "trusted" | "untrusted";

/** Load status of one local plugin (for the /plugins view). */
export interface PluginSummary {
  name: string;
  status: "loaded" | "failed";
  toolCount: number;
  trust: TrustTier;
  /** Number of tools blocked by capability gating (untrusted execute tools). */
  blocked?: number;
  error?: string;
}

/** A reusable prompt-based capability surfaced to the model and run via /skill. */
export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * What a tool does, used by permission modes: "read" tools never mutate, "edit"
 * tools change files in the project, "execute" tools run arbitrary commands.
 */
export type ToolCategory = "read" | "edit" | "execute";

/** Intrinsic danger of a tool, independent of its arguments. */
export type RiskTier = "safe" | "caution" | "destructive";

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for parameters (consumed directly as ToolSchema.parameters). */
  parameters: Record<string, unknown>;
  /** Default permission level for this tool. */
  permission: PermissionLevel;
  /** Effect category; drives auto/plan permission modes. Defaults to "execute". */
  category?: ToolCategory;
  /** True when this tool changes state (writes files, runs commands). Read tools omit it. */
  mutating?: boolean;
  /**
   * How dangerous this tool is, independent of its arguments. "destructive" tools
   * are gated even under yolo when `confirmDestructive` is on. Defaults to "safe".
   */
  riskTier?: RiskTier;
  /** Short human-readable summary of a pending call, shown in the permission prompt. */
  preview?(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  /** Working directory the agent operates within. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * The agent's current tool roster, injected at execute time. Meta-tools use it:
   * `tool_search` lists/searches it and `batch` dispatches to it. Optional so
   * standalone tool calls and tests work without it.
   */
  tools?: readonly Tool[];
}

/** Callback the agent uses to ask the host (TUI/CLI) for permission. */
export type PermissionAsker = (
  tool: Tool,
  args: Record<string, unknown>,
) => Promise<"allow" | "allow_always" | "deny">;
