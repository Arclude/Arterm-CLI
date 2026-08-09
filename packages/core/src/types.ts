/**
 * Shared types for Arterm. `core` defines the interfaces; `providers` and `tools`
 * implement them. This keeps the dependency direction one-way (everything → core).
 */

import type { CredentialSettings } from "./credentials.js";
import type { ProcessRegistry } from "./processRegistry.js";
import type { SandboxRunner } from "./sandbox.js";
import type { PathReservation } from "./toolBatch.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  /** Stable id used to correlate a call with its result. */
  id: string;
  name: string;
  /** Parsed arguments object (already JSON-decoded). */
  arguments: Record<string, unknown>;
}

/**
 * An image carried alongside a message or a tool result.
 *
 * Deliberately a SIDE CHANNEL rather than a `Message.content` union. The text is
 * still the text, and `content` is read in dozens of places — the token
 * estimator, both compaction strategies, every provider's message mapping, the
 * session log, the transcript. A union would force all of them to handle a case
 * most of them have no answer for; an optional field leaves every one of them
 * correct as written, and a provider that cannot render images degrades to
 * exactly the behavior it has today.
 */
export interface ImageContent {
  /**
   * IANA media type. Only the four formats every vision model accepts —
   * image/png, image/jpeg, image/gif, image/webp — reach a provider; anything
   * else is refused upstream, because a media type the vendor rejects is a 400
   * that kills the turn and tells the model nothing it can act on.
   */
  mediaType: string;
  /**
   * Base64-encoded bytes: no `data:` URI prefix and no newlines. Both are what
   * a tool written somewhere else tends to send, and both are rejected by the
   * wire formats this feeds — so they are caught where a tool result enters the
   * loop rather than at the provider, where the failure is a vendor error
   * arriving mid-turn.
   */
  data: string;
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
  /**
   * Images attached to this message — a tool result's screenshot, a picture the
   * user pasted. `content` remains the whole text either way, so a reader that
   * does not know about images still sees a complete message.
   */
  images?: ImageContent[];
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
  /**
   * The model's reasoning, when the backend streams it separately from the
   * answer. Its own chunk kind rather than more `text`, because the two have
   * opposite fates: this is displayed and metered, and then DROPPED. Folding it
   * into the answer would put the model's working notes into the transcript, the
   * next request's history, and every compaction after that.
   */
  | { type: "thinking"; delta: string }
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
  /**
   * Images the tool produced: a screenshot, a rendered chart, a PNG the model
   * asked to see. Unlike `diff`, this IS sent to the model — by the providers
   * that accept image content, and as a line of text naming what was withheld
   * by the ones that don't.
   */
  images?: ImageContent[];
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
   * Safe to run at the SAME TIME as the other calls in one assistant turn.
   *
   * Declared by the tool rather than inferred, and absent means no — the loop
   * runs anything it is unsure about one at a time, which is what it always did.
   *
   * `category: "read"` is not the answer to this question and cannot be made
   * into it: the category drives the auto/plan permission modes, and several
   * tools that carry it change session state anyway (`set_working_dir` moves the
   * cwd every later path resolves against, `todo` and `remember` write stores,
   * `batch` dispatches other tools and can reach an edit through one). Reading
   * concurrency off the category would have parallelized all of those.
   *
   * The bar is not "does not write files" but "its result cannot depend on
   * whether it ran before or after its siblings". `git` fails it despite being
   * read-only — `git status` takes `index.lock` to refresh the index, so two at
   * once is a race over a lock file, not over the repository.
   */
  concurrent?: boolean;
  /**
   * Which paths ONE CALL touches, so admission to a concurrent batch can be a
   * property of the call instead of the tool.
   *
   * `concurrent` answers "may this tool ever share a batch" and cannot answer
   * more: it is a constant, so every writing tool has to say no, and two writes
   * to unrelated files — which have nothing to say to each other — are serialized
   * for a conflict that does not exist. This says what a specific call will read
   * and write, and the planner keeps reader↔reader overlap parallel while any
   * overlap involving a writer closes the run.
   *
   * Read the paths from the argument that will actually be USED. A patch names
   * its files in the body, so the body is the truth and a sibling `path`
   * argument may be stale; reserving the wrong one is worse than reserving
   * nothing, because it is a claim the planner will believe.
   *
   * Return `null` for arguments this tool cannot make sense of. Unknown is not
   * harmless — it becomes a barrier, because a call that cannot state what it
   * touches has not stated that it touches nothing. Absent means the same as
   * `concurrent` alone said: reserves nothing, conflicts with nothing.
   *
   * Paths must be ABSOLUTE and normalized; the tool resolves them against the
   * `cwd` it is handed, since a relative string is meaningless to a planner that
   * does not know which directory it was written against.
   */
  reservation?(args: Record<string, unknown>, cwd: string): PathReservation | null;
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
  /**
   * Where a detached child is recorded, so the session can stop what it
   * started (see `processRegistry.ts`). Absent means background execution is
   * REFUSED rather than done unregistered — an unregistered background process
   * is the leak the registry exists to prevent.
   */
  processes?: ProcessRegistry;
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
