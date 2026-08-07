/**
 * Shared types for Arterm. `core` defines the interfaces; `providers` and `tools`
 * implement them. This keeps the dependency direction one-way (everything → core).
 */

import type { CredentialSettings } from "./credentials.js";
import type { SandboxRunner } from "./sandbox.js";

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
  /**
   * Cached prompt tokens, reported separately because they are BILLED
   * separately — providers charge a cache read at roughly a tenth of the
   * standard input rate. An agent loop is mostly cache hits by the third
   * iteration, so pricing these at the input rate overstates a run by close to
   * an order of magnitude. Providers that report neither leave both undefined
   * and pricing degrades to prompt/completion only.
   *
   * `promptTokens` stays the vendor's own figure — the context gauge needs the
   * real prompt size, cached or not — so the shape is declared rather than
   * guessed: see `cachedInPrompt`.
   */
  cacheReadTokens?: number;
  /** Tokens written INTO the cache (billed above the input rate). */
  cacheWriteTokens?: number;
  /**
   * True when `promptTokens` ALREADY counts the cache tokens (the
   * OpenAI-compatible shape, where `prompt_tokens` includes
   * `cached_tokens`); absent when it does not (Anthropic reports
   * `input_tokens` exclusive of both cache fields).
   *
   * Declared by the provider rather than inferred, because the two shapes are
   * indistinguishable from the numbers alone whenever prompt ≥ cache — and
   * guessing wrong silently misprices every request in the run.
   */
  cachedInPrompt?: boolean;
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
  /**
   * The backend's most recent rate-limit report, when it sends one (Anthropic's
   * `anthropic-ratelimit-*` and OpenAI-style `x-ratelimit-*` response headers).
   * Undefined until a response carried the headers — and never invented: a
   * backend that reports nothing simply has no snapshot to show.
   */
  rateLimits?(): RateLimitSnapshot | undefined;
}

/** A provider's most recent rate-limit report, harvested from response headers. */
export interface RateLimitSnapshot {
  /** ms epoch when the reporting response arrived (staleness signal). */
  at: number;
  /** Raw headers (lowercased name → value), vendor prefix and all. */
  headers: Record<string, string>;
}

/** Result returned by a tool's execute(). */
/** One rendered line of a file diff, for rich transcript rendering (TUI-only). */
export interface DiffRow {
  kind: "context" | "add" | "del" | "hunk";
  /** 1-based old-file line number (present on context + del rows). */
  old?: number;
  /** 1-based new-file line number (present on context + add rows). */
  new?: number;
  /** The line's code text, or the "@@ … @@" header for a `hunk` row. */
  text: string;
}

export interface ToolResult {
  /** Text fed back to the model as the tool result. */
  output: string;
  /** True when the tool failed; the model is told so it can recover. */
  isError?: boolean;
  /**
   * Rich per-line diff for file-mutating tools (edit/write/multi_edit), rendered
   * in the transcript. TUI-only metadata — it is NOT sent to the model.
   */
  diff?: DiffRow[];
  /** Path of the file a mutating tool changed (drives the "changed files" summary). */
  path?: string;
}

export type PermissionLevel = "allow" | "ask" | "deny";

/**
 * How the autonomy engine runs a goal:
 *   - "once":     stops when the goal is done.
 *   - "eternal":  keeps going until stopped.
 *   - "parallel": each round the leader decomposes the goal into concurrent subagent
 *                 tasks (fleet), aggregates the results, reflects, and repeats.
 *   - "team":     the leader assembles a named team of specialist members (from
 *                 `.arterm/agents/*.md` definitions or ad-hoc) and assigns work per round.
 */
export type AutonomyMode = "once" | "eternal" | "parallel" | "phased" | "team";

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

/** Result of one live MCP server health probe (for /mcp check and `arterm status`). */
export interface McpCheckResult {
  name: string;
  ok: boolean;
  /** Round-trip time of the probe (ping, or listTools fallback) in ms. */
  latencyMs?: number;
  /** Tool count known from connect time. */
  toolCount?: number;
  error?: string;
}

/** Result of validating one local plugin on disk (for /plugins check). */
export interface PluginCheckResult {
  name: string;
  ok: boolean;
  toolCount?: number;
  error?: string;
}

/** Combined live health report for MCP servers and plugins. */
export interface ExtensionsCheck {
  mcp: McpCheckResult[];
  plugins: PluginCheckResult[];
}

/** Result of reloading extensions: refreshed summaries plus newly registered tool names. */
export interface ExtensionsReload {
  mcp: McpServerSummary[];
  plugins: PluginSummary[];
  addedTools: string[];
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
  /**
   * How to use the tool well — best practice, pitfalls, when NOT to reach for
   * it. Deliberately NOT part of `description`, and deliberately not in the
   * schema the model sees every turn: the roster is paid for on every request,
   * so a paragraph per tool would cost more than it teaches. This is delivered
   * once, attached to the tool's first failed call, where it is read at the
   * moment it is needed.
   */
  usageHint?: string;
  /**
   * When another tool is the better answer. Rendered into the roster line as
   * "use X instead when Y", because the roster is the only place a model is
   * choosing between tools. Without it `grep` and `search` read as synonyms.
   */
  selection?: { doNotUseWhen: string; useInstead: string };
  /**
   * Ceiling on what this tool may put into the context, in bytes. Enforced
   * centrally, so the cap is one number a reader can find rather than a
   * different constant inside every tool.
   */
  maxOutputBytes?: number;
  /** Wall-clock ceiling for one call, when the tool does not manage its own. */
  timeoutMs?: number;
  /** Short human-readable summary of a pending call, shown in the permission prompt. */
  preview?(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  /** Working directory the agent operates within. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * The execution boundary shell commands run inside, when one is established
   * (see `sandbox.ts`). Absent means the command runs on the host with the
   * user's own identity — which is what every run did before this existed, and
   * what an attended run still does unless `sandbox.enabled` says otherwise.
   */
  sandbox?: SandboxRunner;
  /**
   * Which environment variables a spawned command inherits (see
   * `credentials.ts`). Absent does NOT mean "hand everything over" — the
   * scrub's defaults apply, so a context assembled without this wiring is not
   * the one path that still leaks the session's API keys into the transcript.
   */
  credentials?: CredentialSettings;
  /**
   * The agent's current tool roster, injected at execute time. Meta-tools use it:
   * `tool_search` lists/searches it and `batch` dispatches to it. Optional so
   * standalone tool calls and tests work without it.
   */
  tools?: readonly Tool[];
}

/** The three answers a permission prompt can produce. */
export type PermissionAnswer = "allow" | "allow_always" | "deny";

/** Callback the agent uses to ask the host (TUI/CLI) for permission. */
export type PermissionAsker = (
  tool: Tool,
  args: Record<string, unknown>,
  /**
   * Aborts when the request was already answered elsewhere — today that means
   * the desktop answered it through the status server while the TUI prompt was
   * still up (see `PermissionBroker`). The host should dismiss its prompt; the
   * promise's eventual resolution is ignored.
   */
  signal?: AbortSignal,
) => Promise<PermissionAnswer>;
